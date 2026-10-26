import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PKG_ROOT, SCRIPTS_DIR, SKILL_FILE, driverFile, scriptFile } from "./smoke-support";

export function overlayProbeContract() {
  describe("10d. 弹窗探针表达式", () => {
    let skipButtonTexts;
    let authMarker;
    let probes;

    beforeAll(async () => {
      const ob = await import(pathToFileURL(join(SCRIPTS_DIR, "lib", "onboarding.mjs")).href);
      skipButtonTexts = [...ob.SKIP_BUTTON_TEXTS];
      authMarker = ob.AUTH_REQUIRED_MARKER;
      probes = {
        auto: ob.buildOverlayProbeExpression(),
        manual: ob.buildOverlayProbeExpression({ click: false }),
      };
    });

    it("跳过按钮文案含 en + zh（locale 变化不失效）", () => {
      expect(skipButtonTexts).toEqual(["Continue", "Configure later", "继续", "稍后配置"]);
    });

    it("默认探针允许点击", () => {
      expect(/const allowClick = true/.test(probes.auto)).toBeTruthy();
    });

    it("--no-auto-dismiss 探针禁止点击", () => {
      expect(/const allowClick = false/.test(probes.manual)).toBeTruthy();
    });

    // 原脚本把「两类探针各自四项」写在数组循环内，故按探针展开为逐条可见用例。
    const probeCases = [
      { title: "默认探针", key: "auto" },
      { title: "--no-auto-dismiss 探针", key: "manual" },
    ];

    it.each(probeCases)("$title：探针保留点击路径", ({ key }) => {
      expect(probes[key].includes("target.click()")).toBeTruthy();
    });

    it.each(probeCases)("$title：禁止点击的分支先于 target.click()（防假开关回归）", ({ key }) => {
      expect(
        probes[key].indexOf("if (!allowClick) return") < probes[key].indexOf("target.click()"),
      ).toBeTruthy();
    });

    it.each(probeCases)("$title：探针以应用根 inert 为阻断判据", ({ key }) => {
      expect(probes[key].includes("root.inert !== true")).toBeTruthy();
    });

    it.each(probeCases)("$title：探针携带鉴权拒绝文案判据", ({ key }) => {
      expect(probes[key].includes(authMarker)).toBeTruthy();
    });

    it("401 判据与 dsh web 实际文案一致", () => {
      expect(authMarker).toBe("dsh web authentication required");
    });
  });

  // 10e. 令牌脱敏：回显 URL 会随证据归档，真令牌只允许留在 0o600 的 state/log
}

export function tokenRedactionContract() {
  describe("10e. 令牌脱敏", () => {
    let ob;

    beforeAll(async () => {
      ob = await import(pathToFileURL(join(SCRIPTS_DIR, "lib", "onboarding.mjs")).href);
    });

    it("回显去令牌", () => {
      expect(ob.redactToken("http://127.0.0.1:41915/?token=abc123")).toBe(
        "http://127.0.0.1:41915/?token=***",
      );
    });

    it("多参数下只替换令牌值", () => {
      expect(ob.redactToken("http://127.0.0.1:1/a?x=1&token=abc&y=2")).toBe(
        "http://127.0.0.1:1/a?x=1&token=***&y=2",
      );
    });

    it("非字符串原样返回", () => {
      expect(ob.redactToken(undefined)).toBe(undefined);
    });
  });

  // 10f. 访问 URL 解析（令牌唯一来源）：只认 dsh 打印的完整 URL，截断即 null
}

export function verifyOnboardingContract() {
  describe("10g. verify-isolated 首启弹窗契约锚定", () => {
    let vScript;
    let viHelp;

    beforeAll(() => {
      vScript = readFileSync(scriptFile, "utf8");
      viHelp = execFileSync(process.execPath, [scriptFile, "--help"], { encoding: "utf8" });
    });

    const onboardingContracts = [
      "--no-skip-onboarding",
      "presetWelcomeNotice",
      "settings.yaml",
      "首启弹窗预置",
    ];
    it.each(onboardingContracts)("verify-isolated 含首启弹窗契约 %s", (opt) => {
      expect(vScript.includes(opt)).toBeTruthy();
    });

    const onboardingVerdictFields = ["web:", "onboarding:", "tokenSource:"];
    it.each(onboardingVerdictFields)("verdict schema 含字段 %s", (field) => {
      expect(vScript.includes(field)).toBeTruthy();
    });

    it("带令牌 URL 写入 browser.state.dshWebUrl", () => {
      expect(vScript.includes("st.dshWebUrl = webUrl")).toBeTruthy();
    });

    it("--help 声明 --no-skip-onboarding", () => {
      expect(viHelp.includes("--no-skip-onboarding")).toBeTruthy();
    });

    it("--help 说明访问令牌（GUI 带鉴权）", () => {
      expect(viHelp.includes("令牌")).toBeTruthy();
    });
  });
}

export function driverOnboardingContract() {
  describe("10h. browser-driver 首启弹窗契约锚定", () => {
    let dScript;
    let drvHelp;

    beforeAll(() => {
      dScript = readFileSync(driverFile, "utf8");
      drvHelp = execFileSync(process.execPath, [driverFile, "--help"], { encoding: "utf8" });
    });

    const driverOnboardingContracts = [
      "--no-auto-dismiss",
      "--overlay-wait",
      "dshWebUrl",
      "onboardingBlocked",
    ];
    it.each(driverOnboardingContracts)("browser-driver 含 %s 契约", (opt) => {
      expect(dScript.includes(opt)).toBeTruthy();
    });

    const gotoCommands = ["cmdSnapshot", "cmdClick", "cmdWait", "cmdScreenshot"];
    it.each(gotoCommands)("%s 接入导航收尾（弹窗跳过不得绕过）", (cmd) => {
      const body = dScript.split(`async function ${cmd}(`)[1]?.split("\nasync function ")[0] ?? "";
      expect(body.includes("goto(")).toBeTruthy();
    });

    // console 走长连接收事件（短连接的 goto 会丢事件），导航与收尾内联，但收尾必须在
    it("cmdConsole 内联接入导航收尾（弹窗跳过不得绕过）", () => {
      const body =
        dScript.split("async function cmdConsole(")[1]?.split("\nasync function ")[0] ?? "";
      expect(body.includes("settleOverlays(")).toBeTruthy();
    });

    const nonNavigatingCommands = ["cmdEval", "cmdFill"];
    it.each(nonNavigatingCommands)("%s 不导航、不触发弹窗跳过（设计契约）", (cmd) => {
      const body = dScript.split(`async function ${cmd}(`)[1]?.split("\nasync function ")[0] ?? "";
      expect(!body.includes("goto(") && !body.includes("settleOverlays(")).toBeTruthy();
    });

    it("--help 声明 --url state 保留取值", () => {
      expect(drvHelp.includes("--url <url|state>")).toBeTruthy();
    });

    it("--help 声明 --no-auto-dismiss", () => {
      expect(drvHelp.includes("--no-auto-dismiss")).toBeTruthy();
    });
  });
}

export function onboardingDocumentationContract() {
  describe("10i. 文档同步（跳过与令牌指导锚点）", () => {
    let skillRaw;
    let readmeZh;
    let readmeEn;

    beforeAll(() => {
      skillRaw = readFileSync(SKILL_FILE, "utf8");
      readmeZh = readFileSync(join(PKG_ROOT, "README.md"), "utf8");
      readmeEn = readFileSync(join(PKG_ROOT, "README.en.md"), "utf8");
    });

    const skillAnchors = [
      "--url state",
      "首启弹窗",
      "401",
      "token=***",
      "--no-skip-onboarding",
      "inert",
    ];
    it.each(skillAnchors)("SKILL.md 含跳过/鉴权指导锚点 %s", (anchor) => {
      expect(skillRaw.includes(anchor)).toBeTruthy();
    });

    const readmeZhAnchors = ["--no-skip-onboarding", "--url state", "token=***", "settings.yaml"];
    it.each(readmeZhAnchors)("README.md 含 %s", (anchor) => {
      expect(readmeZh.includes(anchor)).toBeTruthy();
    });

    const readmeEnAnchors = ["--no-skip-onboarding", "--url state", "token=***", "onboarding.mjs"];
    it.each(readmeEnAnchors)("README.en.md 含 %s", (anchor) => {
      expect(readmeEn.includes(anchor)).toBeTruthy();
    });
  });
}

export function onboardingSourceContract() {
  describe("10j. skill 加载 + 生产实现单源回归", () => {
    let skillRaw;
    let onboardingSrc;

    beforeAll(() => {
      skillRaw = readFileSync(SKILL_FILE, "utf8");
      onboardingSrc = readFileSync(join(SCRIPTS_DIR, "lib", "onboarding.mjs"), "utf8");
    });

    it("skill 主文件存在（加载回归）", () => {
      expect(existsSync(SKILL_FILE)).toBeTruthy();
    });

    it("skill 主文件提及命名空间现取（文档与实现同源）", () => {
      expect(skillRaw.includes("WELCOME_NOTICE_SETTINGS_NAMESPACE")).toBeTruthy();
    });

    it("生产实现不含目标 namespace 字面量", () => {
      expect(onboardingSrc.includes('"ui-settings-general"')).toBe(false);
    });

    it("生产实现不含 legacy namespace 字面量", () => {
      expect(onboardingSrc.includes('"ui-onboarding"')).toBe(false);
    });

    it("生产实现不含目标 version 字面量", () => {
      expect(onboardingSrc.includes("2026-08-13.1")).toBe(false);
    });
  });
}
