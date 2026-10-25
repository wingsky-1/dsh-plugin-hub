/**
 * dsh-notifier upgrade 域 service 块 —— 存量设置的割接与空步登记。
 *
 * 判据面：装配期同步读存量并直接读写配置文件；割接落盘失败不回写刻度；空步只推进刻度。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { compareVersions } from "../../../../../shared/upgrade-chain.js";
import {
  CONFIG_FILE_NAME,
  HISTORY_FILE_NAME,
  SEQ_FILE_NAME,
  STATUS_FILE_NAME,
  notifierFile,
} from "../../../src/server/shared/interface.ts";
import { DEFAULT_CONFIG } from "../../../src/server/config/impl/model/index.ts";
import { tempDshHome } from "../../helpers.ts";
import {
  assembleUpgrade as assemble,
  configOnDisk,
  makeLegacy,
  newestTarget,
  releaseUpgrade,
  seedStoredVersion,
  storedVersionOnDisk,
} from "./upgrade-service-support.ts";

let home: { readonly dir: string; dispose: () => void };

beforeEach(() => {
  home = tempDshHome();
});

afterEach(() => {
  releaseUpgrade();
  home.dispose();
});

/** 内置条目 + 用户当年在旧顶层键上表过态的字段（必须是**用户那个值**，不是默认值）。 */
function builtins(over: Record<string, unknown>): unknown[] {
  return DEFAULT_CONFIG.channels.map((channel) => ({ ...channel, ...over }));
}

function registerLegacyConfigMigrations() {
  describe("存量设置的割接：装配期同步读，直接读写配置文件", () => {
    it("装配返回时存量已割接落盘：旧键换成新形态，装配键不进配置", async () => {
      const legacy = makeLegacy([
        {
          ns: "dsh-notifier",
          user: {
            enabled: true,
            notifyAsk: false,
            notifySound: false,
            configFile: "/legacy/x.json",
          },
        },
      ]);

      await assemble({ legacy });

      // 同步读面：装配返回时割接已经写完，没有「等一会儿再来读」的窗口。
      expect(legacy.reads()).toBe(1);
      const stored = configOnDisk();
      expect(stored.notifyAsk).toBe(false);
      // 旧键搬完即删：文件里只留条目一处表达
      expect("notifySound" in stored).toBe(false);
      // 旧的全局音效键摊到两条内置条目的 `sound` 上（用户当时关掉的提示音不该复活——补齐只补缺席
      // 字段，`sound` 已在场因此原样保留，见 #1016 P1-1）。
      expect(stored.channels).toEqual(builtins({ sound: false }));
      // 组合层装配键在旧格式里就属于启动参数，迁移后不该出现在配置里。
      expect("configFile" in stored).toBe(false);
      expect("enabled" in stored).toBe(false);
    });

    it("既没有存量也没有配置文件：不凭空建一份（默认值被读成「用户改过」是另一条语义的反面）", async () => {
      await assemble();

      expect(existsSync(notifierFile(CONFIG_FILE_NAME))).toBe(false);
    });

    it("配置文件已有内容时以文件为基底合并存量：存量覆盖同名键，文件里多出来的形状留住", async () => {
      const file = notifierFile(CONFIG_FILE_NAME);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(
        file,
        `${JSON.stringify({ notifyAsk: true, historyMaxAgeDays: 32 })}\n`,
        "utf8",
      );

      await assemble({ legacy: makeLegacy([{ ns: "dsh-notifier", user: { notifyAsk: false } }]) });

      const stored = configOnDisk();
      expect(stored.notifyAsk).toBe(false);
      expect(stored.historyMaxAgeDays).toBe(32);
    });

    // 刻度是「这一步做完了」的凭证：割接落盘失败的那一步不回写刻度，下次启动从同一步重跑，
    // 已完成的步不必因为后面某步失败而整体作废。故障精确发生在 config 原子写（更早的
    // storage-layout 已由预置文件排掉），且失败的是首个待办步，故刻度仍停在链起点。
    it("割接落盘失败即抛且刻度不动；恢复写权限后重试一次提交到目标", async () => {
      seedStoredVersion("0.2.3");
      const configFile = notifierFile(CONFIG_FILE_NAME);
      const storageDir = dirname(configFile);
      mkdirSync(storageDir, { recursive: true });
      writeFileSync(configFile, '{"notifyAsk":true}\n', "utf8");
      // 存储布局先落定，确保只读故障精确发生在 config 原子写，而不是更早的 storage-layout。
      writeFileSync(notifierFile(HISTORY_FILE_NAME), "", "utf8");
      writeFileSync(notifierFile(STATUS_FILE_NAME), "{}\n", "utf8");
      writeFileSync(notifierFile(SEQ_FILE_NAME), "0\n", "utf8");

      chmodSync(storageDir, 0o555);
      let caught: unknown;
      try {
        await assemble({
          legacy: makeLegacy([{ ns: "dsh-notifier", user: { notifyAsk: false } }]),
        });
      } catch (cause) {
        caught = cause;
      } finally {
        chmodSync(storageDir, 0o755);
      }

      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("配置形态割接落盘失败");
      expect(storedVersionOnDisk()).toBe("0.2.3");
      expect(configOnDisk().notifyAsk).toBe(true);

      await assemble({ legacy: makeLegacy([{ ns: "dsh-notifier", user: { notifyAsk: false } }]) });
      expect(storedVersionOnDisk()).toBe(newestTarget());
      expect(configOnDisk().notifyAsk).toBe(false);
    });

    /**
     * 步骤表接线：装配方真的驱动的是**本包自己的**迁移动作，且刻度停在步骤表最后一步的目标版本。
     * 判据落在磁盘效果（旧布局文件被搬进新位置 + 刻度到表末）而不是「框架被调用了几次」。
     */
    it("装配方从 0.2.3 起跑完整条链：旧布局被归位、刻度停在步骤表最后目标版本", async () => {
      seedStoredVersion("0.2.3");
      const legacyHistory = join(home.dir, "dsh-notifier-history.jsonl");
      writeFileSync(legacyHistory, '{"ts":7}\n', "utf8");

      await assemble();

      expect(readFileSync(notifierFile(HISTORY_FILE_NAME), "utf8")).toBe('{"ts":7}\n');
      expect(existsSync(legacyHistory)).toBe(false);
      expect(storedVersionOnDisk()).toBe(newestTarget());
      // 空步登记不能被静默丢掉：表里必须还有**比业务迁移那一步更新**的刻度，否则「没有数据要改的
      // 版本也得占一步」这条约定一破，存储刻度会永久停在业务迁移那格——而上面那句断言照样绿。
      // 不写版本字面量：发版每加一格空步就得回来改一遍断言，那是与被测行为无关的维护负担。
      expect(compareVersions(newestTarget(), "0.2.4")).toBeGreaterThan(0);
    });
  });

  /**
   * 空步登记：0.2.9 → 0.2.10 没有数据形态变化，但必须占一步刻度——漏登记会让存量安装的存储刻度
   * 永久停在 0.2.9（链以步骤为刻度）。
   *
   * 判据：种子 0.2.9 → 跑链 → 刻度到 0.2.10，且存量数据正文逐字不变、重复启动可重入。
   */
  describe("空步登记：0.2.9 → 0.2.10 只推进刻度", () => {
    it("0.2.9 → 0.2.10 只推进刻度并可重复启动（判据：存储正文逐字不变，漏步或误写必须红）", async () => {
      const storedData = '{"notifyAsk":false,"channels":[]}\n';
      seedStoredVersion("0.2.9");
      mkdirSync(dirname(notifierFile(CONFIG_FILE_NAME)), { recursive: true });
      writeFileSync(notifierFile(CONFIG_FILE_NAME), storedData, "utf8");

      await assemble();
      expect(storedVersionOnDisk()).toBe("0.2.10");
      expect(readFileSync(notifierFile(CONFIG_FILE_NAME), "utf8")).toBe(storedData);

      releaseUpgrade();
      await assemble();
      expect(storedVersionOnDisk()).toBe("0.2.10");
      expect(readFileSync(notifierFile(CONFIG_FILE_NAME), "utf8")).toBe(storedData);
    });
  });
}

registerLegacyConfigMigrations();
