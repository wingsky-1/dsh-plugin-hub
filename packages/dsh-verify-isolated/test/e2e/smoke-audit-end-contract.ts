import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { SCRIPTS_DIR, scriptFile, winCmdShimFor } from "./smoke-support";

type AuditRun = { code: number; out: string; home: string | null };
type AuditEndState = {
  tmp2: string;
  runAuditE2E: (extraEnv: NodeJS.ProcessEnv) => AuditRun;
  a: AuditRun | undefined;
  av: { audit: { conclusion: string; count: number; whitelistV: string } } | undefined;
  b: AuditRun | undefined;
  bv: { audit: { conclusion: string; count: number; suspicious: { path: string }[] } } | undefined;
  aAuditJsonExists: boolean;
  auditWhitelistV: string;
};

function initializeAuditEndState(state: AuditEndState) {
  state.tmp2 = mkdtempSync(join(tmpdir(), "dsh-verify-audit-e2e-"));
  const fakeDsh = join(state.tmp2, "fake-dsh-audit.mjs");
  writeFileSync(
    fakeDsh,
    `#!/usr/bin/env node
import { mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import http from "node:http";
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("0.2.1-rc.2"); process.exit(0); }
if (args[0] === "plugin" && args.includes("list")) {
  const i = args.indexOf("--profile");
  const dir = join(process.env.DSH_HOME, "profiles", args[i + 1]);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } } }));
  process.exit(0);
}
if (args[0] === "plugin" && args.includes("add")) { process.exit(0); }
if (args.includes("--host")) {
  const H = process.env.DSH_HOME;
  const pi = args.indexOf("--profile");
  const prof = args[pi + 1];
  mkdirSync(join(H, "profiles", prof, "node_modules", "@deepseek-ai"), { recursive: true });
  // 悬空 bundle 链接：win32 目符号链接需特权，junction 无需且悬空语义一致。
  if (process.platform === "win32") {
    symlinkSync("C:\\\\nonexistent\\\\dsh-install\\\\lib", join(H, "profiles", prof, "node_modules", "@deepseek-ai", "dsh-base"), "junction");
  } else {
    symlinkSync("/nonexistent/dsh-install/lib", join(H, "profiles", prof, "node_modules", "@deepseek-ai", "dsh-base"), "dir");
  }
  writeFileSync(join(H, ".credentials.yaml"), "token: fake\\n");
  mkdirSync(join(H, "storages"), { recursive: true });
  writeFileSync(join(H, "storages", "workspace.json"), "{}");
  const port = Number(args[args.indexOf("--port") + 1]);
  const srv = http.createServer((_req, res) => { res.writeHead(200); res.end("ok"); });
  srv.on("error", () => process.exit(1));
  srv.listen(port, "127.0.0.1", () => {
    console.log("dsh web: http://127.0.0.1:" + port + "/");
    if (process.env.RUNTIME_WRITE === "1") {
      setTimeout(() => writeFileSync(join(H, "mystery.bin"), "runtime-write"), 2000);
    }
    setTimeout(() => { srv.close(); process.exit(0); }, 2500);
  });
  setTimeout(() => { srv.close(); process.exit(0); }, 3000);
  await new Promise(() => {});
}
process.exit(1);
`,
  );
  chmodSync(fakeDsh, 0o755);
  const fakeDshEntry = winCmdShimFor(fakeDsh);
  // PATH 驱动：目录内置名 `dsh` 指向假 dsh。
  const auditPathDir = mkdtempSync(join(state.tmp2, "path-bin-"));
  if (process.platform === "win32") {
    writeFileSync(
      join(auditPathDir, "dsh.cmd"),
      `@echo off\r\n"${process.execPath}" "${fakeDshEntry}" %*\r\n`,
    );
  } else {
    symlinkSync(fakeDshEntry, join(auditPathDir, "dsh"));
  }
  const auditPathEnv = {
    PATH: [auditPathDir, dirname(process.execPath), process.env.PATH]
      .filter(Boolean)
      .join(delimiter),
  };
  const runAuditE2E = (extraEnv) => {
    let code = 0;
    let out = "";
    try {
      out = execFileSync(process.execPath, [scriptFile, "--audit", "--keep", "--port", "0"], {
        encoding: "utf8",
        env: { ...process.env, ...auditPathEnv, ...extraEnv },
        timeout: 60000,
      });
    } catch (e) {
      code = e.status ?? -1;
      out = (e.stdout ?? "") + (e.stderr ?? "");
    }
    const home = /DSH_HOME=([^ ]+)/.exec(out)?.[1] ?? null;
    return { code, out, home };
  };
  return runAuditE2E;
}

function executeAuditEndRuns(state: AuditEndState) {
  state.a = state.runAuditE2E({});
  state.aAuditJsonExists = Boolean(
    state.a.home && existsSync(join(state.a.home, "audit", "audit.json")),
  );
  state.av = JSON.parse(readFileSync(join(state.a.home, "verdict.json"), "utf8"));
  // 变体 B：运行期写面
  state.b = state.runAuditE2E({ RUNTIME_WRITE: "1" });
  state.bv = JSON.parse(readFileSync(join(state.b.home, "verdict.json"), "utf8"));
  // 零污染纪律：--keep 保留的隔离 home 由 smoke 显式清理
  if (state.a.home) rmSync(state.a.home, { recursive: true, force: true });
  if (state.b.home) rmSync(state.b.home, { recursive: true, force: true });
  rmSync(state.tmp2, { recursive: true, force: true });
}

export function auditEndToEndContract() {
  describe("9g. --audit 端到端回归（假 dsh 建模启动写面）", () => {
    const state = { aAuditJsonExists: false } as AuditEndState;
    beforeAll(async () => {
      const audit = await import(pathToFileURL(join(SCRIPTS_DIR, "lib", "audit.mjs")).href);
      state.runAuditE2E = initializeAuditEndState(state);
      executeAuditEndRuns(state);
      state.auditWhitelistV = audit.WHITELIST_V;
    }, 180_000);

    it("变体A 干净运行 exit 0", () => {
      expect(state.a.code).toBe(0);
    });

    it("变体A 输出审计:通过", () => {
      expect(state.a.out.includes("审计:通过")).toBeTruthy();
    });

    it("变体A --keep 落盘 audit/audit.json", () => {
      expect(state.aAuditJsonExists).toBeTruthy();
    });

    it("变体A verdict.audit conclusion=pass", () => {
      expect(state.av.audit.conclusion).toBe("pass");
    });

    it("变体A verdict.audit count=0（启动写面进基线不误报）", () => {
      expect(state.av.audit.count).toBe(0);
    });

    it("变体A verdict.audit.whitelistV 与模块一致", () => {
      expect(state.av.audit.whitelistV).toBe(state.auditWhitelistV);
    });

    it("变体B 运行期写面 exit 0", () => {
      expect(state.b.code).toBe(0);
    });

    it("变体B verdict.audit conclusion=suspicious", () => {
      expect(state.bv.audit.conclusion).toBe("suspicious");
    });

    it("变体B count=1", () => {
      expect(state.bv.audit.count).toBe(1);
    });

    it("变体B 可疑路径 mystery.bin", () => {
      expect(state.bv.audit.suspicious[0].path).toBe("mystery.bin");
    });
  });
}
