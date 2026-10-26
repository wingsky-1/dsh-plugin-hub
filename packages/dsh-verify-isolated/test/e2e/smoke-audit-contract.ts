import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SCRIPTS_DIR, scriptFile } from "./smoke-support";

export function auditWhitelistContract() {
  describe("9a. 白名单版本化 + 模式全集存在", () => {
    let auditExists;
    let audit;
    let whitelistV;

    beforeAll(async () => {
      const auditFile = join(SCRIPTS_DIR, "lib", "audit.mjs");
      auditExists = existsSync(auditFile);
      audit = await import(pathToFileURL(auditFile).href);
      whitelistV = audit.WHITELIST_V;
    });

    it("lib/audit.mjs 随 skill 目录分发", () => {
      expect(auditExists).toBeTruthy();
    });

    // 预置模式数组，版本化 WHITELIST_V；v2 起含 dsh 自身写面
    // .credentials.yaml / storages/**；v3 起含 settings.yaml——首启弹窗跳过会预置它，
    // 页面改设置也由 dsh 重写；v4 起含 settings.yaml.imported（0.2.x-rc.2 导入映射重命名残留，
    // 待真机确认实际落盘形态）。
    it("WHITELIST_V 版本化格式", () => {
      expect(whitelistV).toMatch(/^v\d+$/);
    });

    it("WHITELIST_V 已跟进到 v4（settings.yaml.imported 入白名单即 bump）", () => {
      expect(whitelistV).toBe("v4");
    });

    const whitelistPatterns = [
      "profiles/**",
      "*.json",
      "*.jsonl",
      "*.log",
      ".credentials.yaml",
      "settings.yaml",
      "settings.yaml.imported",
      "browser.state",
      "browser-profile/**",
      "evidence/**",
      "audit/**",
      "storages/**",
      "dsh.log",
      "verdict.json",
    ];
    it.each(whitelistPatterns)("预置白名单含 %s", (p) => {
      expect(audit.WHITELIST.includes(p)).toBeTruthy();
    });
  });
}

export function auditScriptContract() {
  describe("9b. 脚本契约锚定（USAGE/parseCli/--help 同步义务 + 结论行文案 + 落盘契约）", () => {
    let script;

    beforeAll(() => {
      script = readFileSync(scriptFile, "utf8");
    });

    const auditOptions = ["--audit", "--audit-extra-dirs"];
    it.each(auditOptions)("脚本含 %s 选项契约", (opt) => {
      expect(script.includes(opt)).toBeTruthy();
    });

    it("脚本引用版本化白名单常量", () => {
      expect(script.includes("WHITELIST_V")).toBeTruthy();
    });

    it("审计结论行通过文案", () => {
      expect(script.includes("审计:通过")).toBeTruthy();
    });

    it("审计结论行可疑文案", () => {
      expect(script.includes("项可疑")).toBeTruthy();
    });

    it("审计报告落盘契约（--keep 落 $ISOLATED_HOME/audit/audit.json）", () => {
      expect(script.includes("audit.json")).toBeTruthy();
    });

    // 回归：t0 基线必须在**就绪断言通过之后**（dsh 启动写面与官方
    // bundle link 进基线——语义「就绪后运行期写面审计」，源码位置锚定）
    it("t0 基线快照位于就绪断言通过之后（时序）", () => {
      expect(script.indexOf("auditBaseline = [") > script.indexOf("就绪断言通过")).toBeTruthy();
    });
  });
}

export function auditCliContract() {
  describe("9c. --audit 子进程退出码实测", () => {
    let h2;
    let badExtra;
    let badFile;
    let m6;
    let m6Lines;
    let m6Parsed;
    let fileAsExtra;
    let plainFile;

    beforeAll(() => {
      const run = (args) => {
        let code = 0;
        let out = "";
        try {
          out = execFileSync(process.execPath, [scriptFile, ...args], { encoding: "utf8" });
        } catch (e) {
          code = e.status ?? -1;
          out = (e.stdout ?? "") + (e.stderr ?? "");
        }
        return { code, out };
      };
      h2 = run(["--audit", "--help"]);
      badExtra = run([
        "--audit",
        "--audit-extra-dirs",
        join(tmpdir(), "dsh-verify-no-such-audit-dir-xyz"),
      ]);
      // M4：--audit-extra-dirs 传文件 → 参数错误（exit 2，不得静默漏审）
      fileAsExtra = mkdtempSync(join(tmpdir(), "dsh-verify-extra-file-"));
      plainFile = join(fileAsExtra, "afile");
      writeFileSync(plainFile, "x");
      badFile = run(["--audit", "--audit-extra-dirs", plainFile]);
      // t0 前错误（extra-dir 不存在）--json 单 JSON 恒带 audit:null（与 verdict 对齐）
      m6 = run([
        "--json",
        "--audit",
        "--audit-extra-dirs",
        join(tmpdir(), "dsh-verify-no-such-audit-dir-m6"),
      ]);
      m6Lines = m6.out
        .trim()
        .split("\n")
        .filter((l) => l.trim().length > 0);
      m6Parsed = JSON.parse(m6Lines[0]);
    });

    afterAll(() => {
      if (fileAsExtra) rmSync(fileAsExtra, { recursive: true, force: true });
    });

    it("--audit --help 退出码 0", () => {
      expect(h2.code).toBe(0);
    });

    it("--help 含 --audit-extra-dirs 用法", () => {
      expect(h2.out.includes("--audit-extra-dirs")).toBeTruthy();
    });

    it("--audit-extra-dirs 目录不存在退出码 2（参数错误）", () => {
      expect(badExtra.code).toBe(2);
    });

    it("--audit-extra-dirs 传文件退出码 2（必须是目录）", () => {
      expect(badFile.code).toBe(2);
    });

    it("--audit-extra-dirs 非目录报可操作错误", () => {
      expect(badFile.out.includes("必须是目录")).toBeTruthy();
    });

    it("--json t0 前错误路径退出码 2", () => {
      expect(m6.code).toBe(2);
    });

    it("--json t0 前错误路径 stdout 只有 1 行 JSON", () => {
      expect(m6Lines.length).toBe(1);
    });

    it("error JSON 恒带 audit 字段", () => {
      expect(Object.prototype.hasOwnProperty.call(m6Parsed, "audit")).toBeTruthy();
    });

    it("t0 前错误 audit=null（未进入审计）", () => {
      expect(m6Parsed.audit).toBe(null);
    });
  });

  // 9g. --audit 端到端回归：假 dsh 就绪前建模 dsh 启动写面
  // （官方 bundle link 指向外部 + .credentials.yaml + storages/**），验证：
  //   变体 A（干净运行）：exit 0 + 审计:通过 + verdict.audit pass + --keep 落盘
  //   audit/audit.json（启动写面进 t0 基线 → 不误报，核心回归）；
  //   变体 B（运行期写面）：RUNTIME_WRITE → exit 0 + verdict.audit suspicious
  //   count=1（mystery.bin）——「就绪后运行期写面审计」语义仍生效。
}
