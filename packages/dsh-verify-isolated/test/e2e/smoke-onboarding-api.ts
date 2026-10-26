import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SCRIPTS_DIR } from "./smoke-support";

export function noticeExtractionContract() {
  describe("10a. 须知版本与命名空间提取", () => {
    let onboardingExists;
    let ob;

    beforeAll(async () => {
      const onboardingFile = join(SCRIPTS_DIR, "lib", "onboarding.mjs");
      onboardingExists = existsSync(onboardingFile);
      ob = await import(pathToFileURL(onboardingFile).href);
    });

    it("首启弹窗跳过纯函数 lib/onboarding.mjs 随 skill 分发", () => {
      expect(onboardingExists).toBeTruthy();
    });

    it("从客户端产物提取须知版本", () => {
      expect(ob.extractWelcomeNoticeVersion('const WELCOME_NOTICE_VERSION = "2026-08-13.1";')).toBe(
        "2026-08-13.1",
      );
    });

    it("无版本常量返回 null（降级不抛）", () => {
      expect(ob.extractWelcomeNoticeVersion("nothing here")).toBe(null);
    });

    it("null 输入返回 null", () => {
      expect(ob.extractWelcomeNoticeVersion(null)).toBe(null);
    });

    it("从客户端产物提取须知命名空间（RC2 系列形态）", () => {
      expect(
        ob.extractWelcomeNoticeNamespace(
          'const WELCOME_NOTICE_SETTINGS_NAMESPACE = "ui-settings-general";',
        ),
      ).toBe("ui-settings-general");
    });

    it("无命名空间常量返回 null（调用方不得预置旧值）", () => {
      expect(ob.extractWelcomeNoticeNamespace("nothing here")).toBe(null);
    });

    it("命名空间 null 输入返回 null", () => {
      expect(ob.extractWelcomeNoticeNamespace(null)).toBe(null);
    });

    it("版本正则锚定官方同名常量（改名即打红，防静默失效）", () => {
      expect(String(ob.WELCOME_NOTICE_VERSION_RE)).toContain("WELCOME_NOTICE_VERSION");
    });

    it("命名空间正则锚定官方同名常量（改名即打红，防静默失效）", () => {
      expect(String(ob.WELCOME_NOTICE_SETTINGS_NAMESPACE_RE)).toContain(
        "WELCOME_NOTICE_SETTINGS_NAMESPACE",
      );
    });
  });
}

export function settingsDocumentContract() {
  describe("10b. settings 文档形状 + 注入防护", () => {
    let ob;

    beforeAll(async () => {
      ob = await import(pathToFileURL(join(SCRIPTS_DIR, "lib", "onboarding.mjs")).href);
    });

    it("目标 namespace+version 构造合法 settings 文档", () => {
      expect(ob.welcomeSettingsDocument("2026-08-13.1", "ui-settings-general")).toBe(
        "ui-settings-general:\n  welcomeNoticeVersion: 2026-08-13.1\n",
      );
    });

    it("缺 namespace 拒绝构造（不得使用旧命名空间）", () => {
      expect(() => ob.welcomeSettingsDocument("2026-08-13.1")).toThrow(/命名空间/);
    });

    it("版本含换行被拒绝", () => {
      expect(() => ob.welcomeSettingsDocument("bad\nvalue", "ui-settings-general")).toThrow(
        /意外字符/,
      );
    });

    it("命名空间含换行被拒绝", () => {
      expect(() => ob.welcomeSettingsDocument("2026-08-13.1", "bad\nns")).toThrow(/意外字符/);
    });
  });
}

type InstallRootState = {
  fix: string;
  fixBare: string;
  fixMissingNamespace: string;
  fixMissingVersion: string;
  installRoot: string;
  welcomeClientFile: string | null;
  version: string | undefined;
  namespace: string | undefined;
  missingNamespace: unknown;
  missingVersion: unknown;
  bareClientFile: string | null;
  bareVersion: unknown;
};

async function initializeInstallRoot(state: InstallRootState) {
  const ob = await import(pathToFileURL(join(SCRIPTS_DIR, "lib", "onboarding.mjs")).href);
  state.fix = mkdtempSync(join(tmpdir(), "dsh-verify-onboarding-"));
  state.fixBare = mkdtempSync(join(tmpdir(), "dsh-verify-onboarding-bare-"));
  const dshRoot = join(state.fix, "node_modules", "@deepseek-ai", "dsh");
  const clientDir = join(dshRoot, "node_modules", "@deepseek-ai", "dsh-client-ui-settings-models");
  mkdirSync(join(dshRoot, "lib"), { recursive: true });
  mkdirSync(join(clientDir, "lib"), { recursive: true });
  writeFileSync(
    join(dshRoot, "package.json"),
    JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.0.0" }),
  );
  writeFileSync(join(dshRoot, "lib", "bin.js"), "");
  writeFileSync(
    join(clientDir, "package.json"),
    JSON.stringify({ name: "@deepseek-ai/dsh-client-ui-settings-models" }),
  );
  writeFileSync(
    join(clientDir, "lib", "client.js"),
    'const WELCOME_NOTICE_SETTINGS_NAMESPACE = "ui-settings-general";\nconst WELCOME_NOTICE_VERSION = "2099-01-01.1";',
  );
  const bin = join(dshRoot, "lib", "bin.js");
  state.installRoot = ob.dshRootOf(bin);
  state.welcomeClientFile = ob.welcomeClientFileOf(dshRoot);
  state.version = ob.findWelcomeNoticeVersion(bin)?.version;
  state.namespace = ob.findWelcomeNoticeVersion(bin)?.namespace;
  const makeMissingFactFixture = (prefix, clientSource) => {
    const fixture = mkdtempSync(join(tmpdir(), prefix));
    const root = join(fixture, "node_modules", "@deepseek-ai", "dsh");
    const client = join(root, "node_modules", "@deepseek-ai", "dsh-client-ui-settings-models");
    mkdirSync(join(root, "lib"), { recursive: true });
    mkdirSync(join(client, "lib"), { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.0.0" }),
    );
    writeFileSync(join(root, "lib", "bin.js"), "");
    writeFileSync(
      join(client, "package.json"),
      JSON.stringify({ name: "@deepseek-ai/dsh-client-ui-settings-models" }),
    );
    writeFileSync(join(client, "lib", "client.js"), clientSource);
    return { fixture, binPath: join(root, "lib", "bin.js") };
  };

  const missingNamespace = makeMissingFactFixture(
    "dsh-verify-onboarding-missing-namespace-",
    'const WELCOME_NOTICE_VERSION = "2099-01-01.1";',
  );
  state.fixMissingNamespace = missingNamespace.fixture;
  const rootMissingNamespace = missingNamespace.binPath;
  state.missingNamespace = ob.findWelcomeNoticeVersion(rootMissingNamespace);

  const missingVersion = makeMissingFactFixture(
    "dsh-verify-onboarding-missing-version-",
    'const WELCOME_NOTICE_SETTINGS_NAMESPACE = "ui-settings-general";',
  );
  state.fixMissingVersion = missingVersion.fixture;
  const rootMissingVersion = missingVersion.binPath;
  state.missingVersion = ob.findWelcomeNoticeVersion(rootMissingVersion);

  // 负例用独立 fixture（依赖从一开始就不存在）：删除文件会被 require.resolve
  // 的路径缓存挡住，测不出真实的「依赖缺失」路径
  const rootBare = join(state.fixBare, "node_modules", "@deepseek-ai", "dsh");
  mkdirSync(join(rootBare, "lib"), { recursive: true });
  writeFileSync(
    join(rootBare, "package.json"),
    JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.0.0" }),
  );
  writeFileSync(join(rootBare, "lib", "bin.js"), "");
  state.bareClientFile = ob.welcomeClientFileOf(rootBare);
  state.bareVersion = ob.findWelcomeNoticeVersion(join(rootBare, "lib", "bin.js"));
}

export function installRootContract() {
  describe("10c. dsh 安装根与产物定位（mkdtemp fixture 建模 npm 提升布局）", () => {
    const state = {} as InstallRootState;

    beforeAll(async () => initializeInstallRoot(state));

    afterAll(() => {
      rmSync(state.fix, { recursive: true, force: true });
      rmSync(state.fixBare, { recursive: true, force: true });
      rmSync(state.fixMissingNamespace, { recursive: true, force: true });
      rmSync(state.fixMissingVersion, { recursive: true, force: true });
    });

    it("dshRootOf 从入口向上解析安装根", () => {
      expect(state.installRoot).toBe(join(state.fix, "node_modules", "@deepseek-ai", "dsh"));
    });

    it("welcomeClientFileOf 经 Node 解析算法定位产物", () => {
      expect(state.welcomeClientFile).toBe(
        join(
          join(state.fix, "node_modules", "@deepseek-ai", "dsh"),
          "node_modules",
          "@deepseek-ai",
          "dsh-client-ui-settings-models",
          "lib",
          "client.js",
        ),
      );
    });

    it("端到端解析版本", () => {
      expect(state.version).toBe("2099-01-01.1");
    });

    it("端到端解析命名空间（RC2 系列形态）", () => {
      expect(state.namespace).toBe("ui-settings-general");
    });

    it("版本与命名空间同源一致（单源读取，防下次 bump 静默失效）", () => {
      expect(`${state.namespace}:\n  welcomeNoticeVersion: ${state.version}\n`).toBe(
        "ui-settings-general:\n  welcomeNoticeVersion: 2099-01-01.1\n",
      );
    });

    it("缺命名空间常量时端到端返回 null", () => {
      expect(state.missingNamespace).toBe(null);
    });

    it("缺版本常量时端到端返回 null", () => {
      expect(state.missingVersion).toBe(null);
    });

    it("依赖解析失败返回 null（降级不抛）", () => {
      expect(state.bareClientFile).toBe(null);
    });

    it("产物缺失时端到端返回 null（预置失败只警告）", () => {
      expect(state.bareVersion).toBe(null);
    });
  });
}
