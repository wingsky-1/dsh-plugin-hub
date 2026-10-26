import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { TARGET_DSH_VERSION, scriptFile, winCmdShimFor } from "./smoke-support";

type PresetCase = {
  status: number | null;
  report: string;
  verdict: {
    dshHome?: string;
    onboarding?: {
      skip: boolean;
      source: string;
      version: string | null;
      namespace: string | null;
    };
  };
  settingsExists: boolean;
  settingsWrites: string[];
  settings: string | null;
};

type PresetState = {
  tmp: string;
  noDshDir: string;
  missingCase: PresetCase;
  validCase: PresetCase;
  legacyRejectedCase: PresetCase;
  tooNewVersionCase: PresetCase;
  oldVersionCase: PresetCase;
  versionReadFailureCase: PresetCase;
  noDshCase: PresetCase;
};

function makeDshInstall(
  tmp: string,
  name: string,
  clientSource: string,
  versionOutput: string | null = "0.2.1-rc.2",
  versionExitCode = 0,
) {
  const fixture = mkdtempSync(join(tmp, name));
  const dshRoot = join(fixture, "node_modules", "@deepseek-ai", "dsh");
  const clientDir = join(dshRoot, "node_modules", "@deepseek-ai", "dsh-client-ui-settings-models");
  mkdirSync(join(dshRoot, "lib"), { recursive: true });
  mkdirSync(join(clientDir, "lib"), { recursive: true });
  writeFileSync(
    join(dshRoot, "package.json"),
    JSON.stringify({ name: "@deepseek-ai/dsh", version: versionOutput ?? "unknown" }),
  );
  writeFileSync(
    join(clientDir, "package.json"),
    JSON.stringify({ name: "@deepseek-ai/dsh-client-ui-settings-models" }),
  );
  writeFileSync(join(clientDir, "lib", "client.js"), clientSource);
  const bin = join(dshRoot, "lib", "bin.mjs");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import http from "node:http";
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log(${JSON.stringify(versionOutput ?? "")});
  process.exit(${versionExitCode});
}
if (args[0] === "plugin" && args.includes("list")) {
  const i = args.indexOf("--profile");
  const dir = join(process.env.DSH_HOME, "profiles", args[i + 1]);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dsh: { profile: { bundles: [] } } }));
  process.exit(0);
}
if (args.includes("--host")) {
  const port = Number(args[args.indexOf("--port") + 1]);
  const server = http.createServer((_req, res) => {
    res.writeHead(200);
    res.end("ok");
  });
  server.listen(port, "127.0.0.1", () => {
    console.log("dsh web: http://127.0.0.1:" + port + "/?token=fixture-token");
    setTimeout(() => server.close(() => process.exit(0)), 750);
  });
  await new Promise(() => {});
}
process.exit(0);
`,
  );
  chmodSync(bin, 0o755);
  return { fixture, entry: winCmdShimFor(bin) };
}

function pathEntryFor(entry: string) {
  const pathDir = join(dirname(entry), "path-bin");
  mkdirSync(pathDir, { recursive: true });
  if (process.platform === "win32") {
    writeFileSync(join(pathDir, "dsh.cmd"), `@echo off\r\n"${process.execPath}" "${entry}" %*\r\n`);
  } else {
    symlinkSync(entry, join(pathDir, "dsh"));
  }
  return pathDir;
}

function settingsFilesUnder(root: string) {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name === "settings.yaml") found.push(abs);
    }
  };
  walk(root);
  return found;
}

function settingsProbe(settingsPath: string | null) {
  if (settingsPath === null || !existsSync(settingsPath)) {
    return { exists: false, content: null };
  }
  return { exists: true, content: readFileSync(settingsPath, "utf8") };
}

function runCase(
  state: PresetState,
  pathDir: string | null,
  extraEnv: NodeJS.ProcessEnv = {},
): PresetCase {
  const runTmp = mkdtempSync(join(state.tmp, "runtime-"));
  const args = [scriptFile, "--json", "--keep", "--port", "0"];
  const pathValue = (
    pathDir === null ? [state.noDshDir] : [pathDir, dirname(process.execPath), process.env.PATH]
  )
    .filter(Boolean)
    .join(delimiter);
  const result = spawnSync(process.execPath, args, {
    encoding: "utf8",
    timeout: 30000,
    env: {
      ...process.env,
      PATH: pathValue,
      TMPDIR: runTmp,
      TMP: runTmp,
      TEMP: runTmp,
      ...extraEnv,
    },
  });
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  const lines = stdout.trim().split("\n").filter(Boolean);
  const verdict = JSON.parse(lines.at(-1) ?? "{}");
  const home = verdict.dshHome ?? null;
  const settings = settingsProbe(home ? join(home, "settings.yaml") : null);
  return {
    status: result.status,
    report: stdout + stderr,
    verdict,
    settingsExists: settings.exists,
    settingsWrites: settingsFilesUnder(runTmp),
    settings: settings.content,
  };
}

function executePresetRuns(state: PresetState) {
  const missing = makeDshInstall(
    state.tmp,
    "missing-namespace-",
    'const WELCOME_NOTICE_VERSION = "2099-01-01.1";',
  );
  const valid = makeDshInstall(
    state.tmp,
    "valid-",
    'const WELCOME_NOTICE_SETTINGS_NAMESPACE = "ui-settings-general";\nconst WELCOME_NOTICE_VERSION = "2099-01-01.1";',
  );
  const clientSource =
    'const WELCOME_NOTICE_SETTINGS_NAMESPACE = "ui-settings-general";\nconst WELCOME_NOTICE_VERSION = "2099-01-01.1";';
  const legacyRejected = makeDshInstall(state.tmp, "rejected-legacy-", clientSource, "0.2.0-rc.2");
  const tooNewVersion = makeDshInstall(state.tmp, "too-new-version-", clientSource, "0.2.2-rc.1");
  const oldVersion = makeDshInstall(state.tmp, "old-version-", clientSource, "0.1.5-rc.1");
  const versionReadFailure = makeDshInstall(
    state.tmp,
    "version-read-failure-",
    clientSource,
    null,
    9,
  );
  state.noDshDir = mkdtempSync(join(state.tmp, "empty-path-"));

  state.missingCase = runCase(state, pathEntryFor(missing.entry));
  state.validCase = runCase(state, pathEntryFor(valid.entry));
  state.legacyRejectedCase = runCase(state, pathEntryFor(legacyRejected.entry));
  state.tooNewVersionCase = runCase(state, pathEntryFor(tooNewVersion.entry));
  state.oldVersionCase = runCase(state, pathEntryFor(oldVersion.entry));
  state.versionReadFailureCase = runCase(state, pathEntryFor(versionReadFailure.entry));
  state.noDshCase = runCase(state, null);
}

export function presetWelcomeNoticeContract() {
  describe("10c-2. presetWelcomeNotice 严格事实与预置报告", () => {
    const state = {} as PresetState;

    beforeAll(() => {
      state.tmp = mkdtempSync(join(tmpdir(), "dsh-verify-preset-e2e-"));
      executePresetRuns(state);
    }, 60_000);

    afterAll(() => {
      for (const result of [
        state.missingCase,
        state.validCase,
        state.legacyRejectedCase,
        state.tooNewVersionCase,
        state.oldVersionCase,
        state.versionReadFailureCase,
        state.noDshCase,
      ]) {
        const home = result?.verdict?.dshHome;
        if (home) rmSync(home, { recursive: true, force: true });
      }
      rmSync(state.tmp, { recursive: true, force: true });
    });

    it("PATH 无 dsh 时 fail-closed，不创建隔离目录", () => {
      expect(state.noDshCase.status).toBe(2);
      expect(state.noDshCase.report).toContain("PATH 中找不到 dsh 入口");
    });

    it("旧版本 0.1.5-rc.1 被拒绝，错误点名实际与期望版本", () => {
      expect(state.oldVersionCase.status).toBe(2);
      expect(state.oldVersionCase.report).toContain("实际版本: 0.1.5-rc.1");
      expect(state.oldVersionCase.report).toContain(`期望版本: ${TARGET_DSH_VERSION}`);
    });

    it("旧版本 0.2.0-rc.2 被拒绝（单版锚定，不兼容）", () => {
      expect(state.legacyRejectedCase.status).toBe(2);
      expect(state.legacyRejectedCase.report).toContain("实际版本: 0.2.0-rc.2");
      expect(state.legacyRejectedCase.report).toContain(`期望版本: ${TARGET_DSH_VERSION}`);
    });

    it("越界版本 0.2.2-rc.1 被拒绝，不退化为 semver range", () => {
      expect(state.tooNewVersionCase.status).toBe(2);
      expect(state.tooNewVersionCase.report).toContain("实际版本: 0.2.2-rc.1");
      expect(state.tooNewVersionCase.report).toContain(`期望版本: ${TARGET_DSH_VERSION}`);
    });

    it("--version 读取失败被拒绝，不降级为 unknown 后继续", () => {
      expect(state.versionReadFailureCase.status).toBe(2);
      expect(state.versionReadFailureCase.report).toContain("实际版本: 读取失败");
      expect(state.versionReadFailureCase.report).toContain(`期望版本: ${TARGET_DSH_VERSION}`);
      expect(state.versionReadFailureCase.report).not.toContain("(unknown)");
    });

    it.each([
      ["0.1.5 旧版本", () => state.oldVersionCase],
      ["0.2.0 旧版本", () => state.legacyRejectedCase],
      ["过新版本", () => state.tooNewVersionCase],
      ["版本读取失败", () => state.versionReadFailureCase],
      ["PATH 无 dsh", () => state.noDshCase],
    ])("%s 不产出 settings 或 preset 目标证据", (_label, getResult) => {
      const result = getResult();
      expect(result.verdict.dshHome).toBeUndefined();
      expect(result.verdict.onboarding).toBeUndefined();
      expect(result.settingsExists).toBe(false);
      expect(result.settingsWrites).toEqual([]);
      expect(result.report).not.toContain("source=preset");
      expect(result.report).not.toContain('"source": "preset"');
    });

    it("缺 namespace 时 preset skip、不写 settings，报告不含旧 namespace", () => {
      expect(state.missingCase.status).toBe(0);
      expect(state.missingCase.verdict.onboarding).toMatchObject({
        skip: true,
        source: "unavailable",
        version: null,
        namespace: null,
      });
      expect(state.missingCase.settingsExists).toBe(false);
      expect(state.missingCase.report).not.toContain("ui-onboarding");
    });

    it("目标 namespace+version 仍预置真实 settings，报告显式真实 namespace", () => {
      expect(state.validCase.status).toBe(0);
      expect(state.validCase.report).toContain("0.2.1-rc.2");
      expect(state.validCase.verdict.onboarding).toMatchObject({
        skip: true,
        source: "preset",
        version: "2099-01-01.1",
        namespace: "ui-settings-general",
      });
      expect(state.validCase.settings).toBe(
        "ui-settings-general:\n  welcomeNoticeVersion: 2099-01-01.1\n",
      );
      expect(state.validCase.settingsWrites).toHaveLength(1);
      expect(state.validCase.report).toContain(
        "ui-settings-general.welcomeNoticeVersion=2099-01-01.1",
      );
      expect(state.validCase.report).not.toContain("ui-onboarding");
    });

    it("单版锚定：0.2.0-rc.2 已不再被接受", () => {
      expect(state.legacyRejectedCase.status).toBe(2);
      expect(state.legacyRejectedCase.report).toContain("实际版本: 0.2.0-rc.2");
    });
  });
}
