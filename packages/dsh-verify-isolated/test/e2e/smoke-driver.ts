import { describe, expect, it, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SCRIPTS_DIR, driverFile } from "./smoke-support";

type DeviceEmulationState = {
  help: string;
  emulationExists: boolean;
  emu: {
    parseEmulationFlags: (getFlag: (name: string) => string | undefined) => {
      active: boolean;
      width?: number;
      height?: number;
      deviceScaleFactor: number;
      mobile: boolean;
    };
    buildDeviceMetrics: (
      flags: ReturnType<DeviceEmulationState["emu"]["parseEmulationFlags"]>,
      viewport: { width: number; height: number },
    ) => { width: number; height: number; deviceScaleFactor: number; mobile: boolean };
  };
  noFlagActive: boolean | undefined;
  allFlagsParsed: ReturnType<DeviceEmulationState["emu"]["parseEmulationFlags"]> | undefined;
  widthOnly: ReturnType<DeviceEmulationState["emu"]["parseEmulationFlags"]> | undefined;
  widthOnlyMetrics: ReturnType<DeviceEmulationState["emu"]["buildDeviceMetrics"]> | undefined;
  badViewportCode: number;
  badViewportOut: string;
  evalHelp: string;
  driverSrc: string;
  mobileOmitted: boolean | undefined;
  mobileFalseActive: boolean | undefined;
  mobileFalseMobile: boolean | undefined;
};

const get = (obj: Record<string, string>) => (n: string) => obj[n];

export function driverHelpContract() {
  describe("5. browser-driver.mjs 存在 + --help 参数契约（不启动浏览器实例）", () => {
    let driverExists;
    let help;
    let noArgExitsNonZero;

    beforeAll(() => {
      driverExists = existsSync(driverFile);
      help = execFileSync(process.execPath, [driverFile, "--help"], { encoding: "utf8" });
      noArgExitsNonZero = false;
      try {
        execFileSync(process.execPath, [driverFile], { encoding: "utf8" });
      } catch {
        noArgExitsNonZero = true;
      }
    });

    it("browser-driver.mjs 随 skill 目录分发", () => {
      expect(driverExists).toBeTruthy();
    });

    it("browser-driver --help 声明统一 JSON 输出", () => {
      expect(help.includes("--json")).toBeTruthy();
    });

    // 原脚本把命令契约写在数组循环内，故按命令展开为逐条可见用例。
    const driverCommands = [
      "launch",
      "quit",
      "snapshot",
      "click",
      "eval",
      "fill",
      "wait",
      "screenshot",
      "console",
    ];
    it.each(driverCommands)("browser-driver --help 契约含命令 %s", (cmd) => {
      expect(help.includes(cmd)).toBeTruthy();
    });

    it("browser-driver 无参数应非零退出（用法提示，不误启动浏览器）", () => {
      expect(noArgExitsNonZero).toBeTruthy();
    });
  });
}

async function initializeDeviceEmulation(state: DeviceEmulationState) {
  state.help = execFileSync(process.execPath, [driverFile, "--help"], { encoding: "utf8" });
  const emulationFile = join(SCRIPTS_DIR, "lib", "emulation.mjs");
  state.emulationExists = existsSync(emulationFile);

  state.emu = await import(pathToFileURL(emulationFile).href);
  state.noFlagActive = state.emu.parseEmulationFlags(get({})).active;
  state.allFlagsParsed = state.emu.parseEmulationFlags(
    get({ width: "375", height: "667", dpr: "2", mobile: "true" }),
  );
  state.widthOnly = state.emu.parseEmulationFlags(get({ width: "375" }));
  state.widthOnlyMetrics = state.emu.buildDeviceMetrics(state.widthOnly, {
    width: 800,
    height: 600,
  });

  // 参数校验先于连浏览器：state 指向不存在的实例时也应报参数错误而非环境错误
  state.badViewportCode = 0;
  state.badViewportOut = "";
  try {
    state.badViewportOut = execFileSync(
      process.execPath,
      [
        driverFile,
        "eval",
        "--state",
        join(tmpdir(), "nonexistent-browser.state"),
        "--width",
        "0",
        "--expression",
        "1",
      ],
      { encoding: "utf8" },
    );
  } catch (e) {
    state.badViewportCode = e.status ?? -1;
    state.badViewportOut = e.stdout ?? "";
  }

  // --mobile 取值语义：「出现即启用」会让 `--mobile=false` 得到与字面相反的结果
  state.mobileOmitted = state.emu.parseEmulationFlags(get({ mobile: "true" })).mobile;
  state.mobileFalseActive = state.emu.parseEmulationFlags(get({ mobile: "false" })).active;
  state.mobileFalseMobile = state.emu.parseEmulationFlags(
    get({ width: "375", mobile: "false" }),
  ).mobile;

  // 逐命令 help 是实际查参入口：设备 flag 只在全局 help 可见即等于该入口失效
  state.evalHelp = execFileSync(process.execPath, [driverFile, "--help", "eval"], {
    encoding: "utf8",
  });
  state.driverSrc = readFileSync(driverFile, "utf8");
}

function registerDeviceEmulationObservations(state: DeviceEmulationState) {
  it("browser-driver --help 声明视口尺寸 flag", () => {
    expect(state.help.includes("--width") && state.help.includes("--height")).toBeTruthy();
  });

  it("browser-driver --help 声明 --dpr", () => {
    expect(state.help.includes("--dpr")).toBeTruthy();
  });

  it("browser-driver --help 声明 --mobile", () => {
    expect(state.help.includes("--mobile")).toBeTruthy();
  });

  it("设备模拟纯函数 lib/emulation.mjs 随 skill 分发", () => {
    expect(state.emulationExists).toBeTruthy();
  });

  it("无设备 flag 不启用模拟（页面命令走零开销路径）", () => {
    expect(state.noFlagActive).toBe(false);
  });

  it("四个设备 flag 全部解析", () => {
    expect(state.allFlagsParsed).toEqual({
      active: true,
      width: 375,
      height: 667,
      deviceScaleFactor: 2,
      mobile: true,
    });
  });

  it("只给 --width：height 留空待补齐、dpr 默认 1", () => {
    expect(state.widthOnly).toEqual({
      active: true,
      width: 375,
      height: undefined,
      deviceScaleFactor: 1,
      mobile: false,
    });
  });

  it("缺省维度按页面当前视口补齐（不把 undefined 传给 CDP）", () => {
    expect(state.widthOnlyMetrics).toEqual({
      width: 375,
      height: 600,
      deviceScaleFactor: 1,
      mobile: false,
    });
  });

  // 非法值必须抛错：否则 NaN/undefined 直达 CDP，用户只会看到难懂的协议报错。
  // 原脚本把 6 个非法值写在数组循环内，故逐个展开为可见用例。
  const badViewportFlags = [
    { width: "0" },
    { width: "abc" },
    { height: "10001" },
    { dpr: "0" },
    { dpr: "abc" },
    { dpr: "9" },
  ];
  it.each(
    badViewportFlags.map((bad) => ({
      title: `非法参数应抛可操作错误: ${JSON.stringify(bad)}`,
      bad,
    })),
  )("$title", ({ bad }) => {
    expect(() => state.emu.parseEmulationFlags(get(bad))).toThrow(/错误: --(width|height|dpr)/);
  });

  it("视口参数非法应退出 1", () => {
    expect(state.badViewportCode).toBe(1);
  });

  it("视口参数非法输出错误 JSON", () => {
    expect(JSON.parse(state.badViewportOut.trim()).ok).toBe(false);
  });

  it("错误文案点名非法参数 --width", () => {
    expect(state.badViewportOut.includes("--width")).toBeTruthy();
  });

  it("--mobile（省略值）启用移动语义", () => {
    expect(state.mobileOmitted).toBe(true);
  });

  it("--mobile=false 不启用模拟", () => {
    expect(state.mobileFalseActive).toBe(false);
  });

  it("--mobile=false 不打开移动语义", () => {
    expect(state.mobileFalseMobile).toBe(false);
  });

  it("--mobile 取值非法应报错（不猜测）", () => {
    expect(() => state.emu.parseEmulationFlags(get({ mobile: "maybe" }))).toThrow(/错误: --mobile/);
  });

  it("逐命令 help 含该命令自身参数", () => {
    expect(state.evalHelp.includes("--expression")).toBeTruthy();
  });

  it("逐命令 help 含设备模拟 flag", () => {
    expect(state.evalHelp.includes("--width") && state.evalHelp.includes("--dpr")).toBeTruthy();
  });
}

function registerDeviceEmulationCommands(state: DeviceEmulationState) {
  // 七条页面命令都必须走设备模拟路径：任何一条改回直连 connectPage，都会让
  // --width 等 flag 在该命令上静默失效（单命令回退的回归盲区）
  const emulatedCommands = [
    "cmdSnapshot",
    "cmdClick",
    "cmdEval",
    "cmdFill",
    "cmdWait",
    "cmdScreenshot",
    "cmdConsole",
  ];
  it.each(emulatedCommands)("%s 接入设备模拟（页面命令不得绕过 wrapper 直连）", (cmd) => {
    const body =
      state.driverSrc.split(`async function ${cmd}(`)[1]?.split("\nasync function ")[0] ?? "";
    expect(body.includes("withPageEmulation(")).toBeTruthy();
  });

  it("connectPage 只被 withPageEmulation 调用（设备模拟单点接入）", () => {
    expect((state.driverSrc.match(/await connectPage\(/g) || []).length).toBe(1);
  });

  // 清理静默失败会把视口残留给后续命令，两条告警路径都必须留在代码里
  it("清理抛错路径有可见警告", () => {
    expect(state.driverSrc.includes("设备模拟清理失败")).toBeTruthy();
  });

  it("清理后回读核对是否复原", () => {
    expect(state.driverSrc.includes("设备模拟清理后视口未复原")).toBeTruthy();
  });
}

export function deviceEmulationContract() {
  describe("5b. 设备模拟（视口）：纯函数行为 + 参数错误退出码（离线，不启动浏览器）", () => {
    const state = {
      badViewportCode: 0,
      badViewportOut: "",
    } as DeviceEmulationState;
    beforeAll(async () => initializeDeviceEmulation(state));
    registerDeviceEmulationObservations(state);
    registerDeviceEmulationCommands(state);
  });
}
