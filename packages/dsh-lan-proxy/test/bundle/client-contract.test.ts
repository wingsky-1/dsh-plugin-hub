// dsh-lan-proxy bundle：client 契约（lib/client.js 产物字面量）。
//
// #1174 A1 自 test/e2e/smoke.test.ts 拆出。断言与 describe 名逐字保留。
// 层归属：断言对象是构建产物形态（test/bundle/**），不进变异面——产物外壳无法用
// perTest 覆盖分析归因到 src 模块；产物导入只在本文件发生，不外溢到 unit/integration
// （否则那两层的直连 src 判据会被产物面污染）。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ROUTES } from "../../src/server/config/interface.ts";
import {
  assertClientProductContract,
  assertClientSourceContract,
} from "../../../../test/smoke-lib.ts";

const pkgDir = fileURLToPath(new URL("../../", import.meta.url));

// 产物在收集期读取：accessibility 用例的 id 表由产物内容派生，需在建表前可用
// （仍是读 lib/client.js 产物，未改为直连 src）。
const clientCode = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
const expectedLabelIds = [
  "lp-set-enabled",
  "lp-set-port",
  "lp-set-https-enabled",
  "lp-set-https-port",
  "lp-set-cert",
  "lp-set-key",
  "lp-set-banner",
  "lp-set-ca",
  "lp-set-ws-bridge",
  "lp-set-ws-compress",
  "lp-set-ws-paths",
  "lp-set-http-compress",
  "lp-set-level",
  "lp-set-inject-token",
  "lp-set-owns-host-compat",
];
const htmlForIds = [...clientCode.matchAll(/htmlFor:\s*"([^"]+)"/g)].map((m) => m[1]);
const inputModeCount = [...clientCode.matchAll(/inputMode:\s*"numeric"/g)].length;

// 场景族提取为注册函数（#1174 A1）：避免顶层 describe 回调超过 max-lines-per-function。
// 提取的是完整的一级子 describe（场景族），其内容与名字逐字保留，嵌套顺序不变。
function registerSourceAndRouteContracts() {
  it("client source contract（IIFE/use strict/load id/SymbolTag/factory/load once）", () => {
    assertClientSourceContract(pkgDir);
  });

  it("client product contract（执行断言：arrive 可解析/apply/inject）", () => {
    assertClientProductContract(pkgDir);
  });

  it("client shares CONFIG route with host", () => {
    expect(clientCode.includes(ROUTES.config)).toBeTruthy();
  });
}

// issue #348：i18n 接线 + 设置卡字段字典覆盖。
function registerI18nWiring() {
  describe("client i18n 接线 + 设置卡字段字典覆盖（issue #348）", () => {
    // i18n 哨兵：NS / register / bind / slots locale 参数 / 双语字典进产物
    it("i18n 命名空间 NS 进产物", () => {
      expect(clientCode.includes('"settings.lanProxy"')).toBeTruthy();
    });

    it("locale.register（字典注册）进产物", () => {
      expect(clientCode.includes("locale.register")).toBeTruthy();
    });

    it("locale.bind（t 装配）进产物", () => {
      expect(clientCode.includes("locale.bind")).toBeTruthy();
    });

    it("slots.register locale 参数进产物", () => {
      expect(clientCode.includes("locale: NS")).toBeTruthy();
    });

    it("en/zh 双语字典进产物", () => {
      expect(clientCode.includes("Enabled") && clientCode.includes("enable")).toBeTruthy();
    });

    // zh 字典覆盖卡片全部字段（渲染正确性由 client-shim 执行断言 + 浏览器实测保证）
    it("LAN 端口文案进产物", () => {
      expect(clientCode.includes("LAN 端口")).toBeTruthy();
    });

    it("HTTPS 端口文案进产物", () => {
      expect(clientCode.includes("HTTPS 端口")).toBeTruthy();
    });

    it("证书文件文案进产物", () => {
      expect(clientCode.includes("证书文件")).toBeTruthy();
    });

    it("启动时打印访问地址文案进产物", () => {
      expect(clientCode.includes("启动时打印访问地址")).toBeTruthy();
    });

    it("HTTP 压缩开关已渲染", () => {
      expect(clientCode.includes("HTTP 响应压缩")).toBeTruthy();
    });

    it("压缩档位下拉框已渲染", () => {
      expect(
        clientCode.includes("压缩档位") && clientCode.includes("高（最高压缩比：gzip 9 / br 9）"),
      ).toBeTruthy();
    });
  });
}

// issue #33 子项 1：客户端 save() 前本地校验，错误指明字段与范围。
function registerLocalValidation() {
  describe("client 本地校验文案指明字段与合法范围", () => {
    it("端口范围提示（i18n key）", () => {
      expect(clientCode.includes('t("portRangeFail")')).toBeTruthy();
    });

    it("HTTPS 端口范围提示（i18n key）", () => {
      expect(clientCode.includes('t("httpsPortRangeFail")')).toBeTruthy();
    });

    it("档位范围提示（i18n key）", () => {
      expect(clientCode.includes('t("levelRangeFail")')).toBeTruthy();
    });

    it("本地整数校验", () => {
      expect(clientCode.includes("Number.isInteger")).toBeTruthy();
    });
  });
}

// issue #33 子项 2：effective 校准展示 + 增量 diff 提交。
function registerEffectiveCalibration() {
  describe("client 以 effective 校准展示且增量提交", () => {
    it("state.effective 被消费", () => {
      expect(clientCode.includes("effective")).toBeTruthy();
    });

    it("加载基线快照（diff 基准）", () => {
      expect(clientCode.includes("baseline")).toBeTruthy();
    });

    it("增量 diff 键值比较", () => {
      expect(clientCode.includes("sameSetting")).toBeTruthy();
    });

    it("无改动不发起保存请求", () => {
      expect(clientCode.indexOf("Object.keys(payload).length === 0") >= 0).toBeTruthy();
    });
  });
}

// issue #930 Phase 2：一键 CA 按钮/确认框/提醒走产物字面量锁定（行为由 client-dom 覆盖）。
function registerCaActionSurface() {
  describe("client 一键 CA 操作面", () => {
    it("动作路由进产物", () => {
      expect(clientCode.includes(ROUTES.caGenerate)).toBeTruthy();
    });

    it("生成按钮文案进产物", () => {
      expect(clientCode.includes("一键生成本地 CA")).toBeTruthy();
    });

    it("轮换按钮文案进产物", () => {
      expect(
        clientCode.includes("轮换叶子证书") && clientCode.includes("轮换 CA（危险）"),
      ).toBeTruthy();
    });

    it("确认框 key 进产物", () => {
      expect(
        clientCode.includes('t("caConfirmTitle"') && clientCode.includes('t("caConfirmBody"'),
      ).toBeTruthy();
    });

    it("提醒 key 进产物", () => {
      expect(
        clientCode.includes('t("caExpiring"') && clientCode.includes('t("caIpChanged"'),
      ).toBeTruthy();
    });
  });
}

// issue #33 子项 3：压缩状态 GUI 可见（卡片底部轻量状态行）。
function registerCompressStatusRow() {
  describe("client 渲染压缩状态行", () => {
    it("状态行文案函数", () => {
      expect(clientCode.includes("compressStatusLine")).toBeTruthy();
    });

    it("已启用 + 协商计数文案（i18n key）", () => {
      expect(clientCode.includes('t("compressOn"')).toBeTruthy();
    });

    it("关闭态文案（i18n key）", () => {
      expect(clientCode.includes('t("compressOff"')).toBeTruthy();
    });

    it("状态行样式类", () => {
      expect(clientCode.includes("lp-set-status")).toBeTruthy();
    });
  });
}

// issue #33 子项 4：可达性——label/input 经 htmlFor+id 全关联，数字输入带 inputMode。
function registerAccessibilityWiring() {
  describe("client 全部 label 经 htmlFor/id 关联且 number 输入带 inputMode", () => {
    it("15 行全部 htmlFor 关联", () => {
      expect([...htmlForIds].sort()).toEqual([...expectedLabelIds].sort());
    });

    // 原脚本把控件侧 id 断言写在 forIds 循环内，故按 id 展开为逐条可见用例。
    it.each(htmlForIds.map((id) => ({ title: `控件侧存在同名 id「${id}」`, id })))(
      "$title",
      ({ id }) => {
        expect(new RegExp(`id:\\s*"${id}"`).test(clientCode)).toBeTruthy();
      },
    );

    it("port/httpsPort 两个 number 输入均带 inputMode=numeric", () => {
      expect(inputModeCount).toBe(2);
    });
  });
}

// issue #380：injectToken 开关渲染 + 开启态常驻安全警示（评审要求：横幅一次性警示不足）。
function registerInjectTokenWarning() {
  describe("client 渲染 injectToken 开关与开启态警示", () => {
    it("开关 label（i18n key）", () => {
      expect(clientCode.includes('t("injectToken")')).toBeTruthy();
    });

    it("开启态警示文案（i18n key）", () => {
      expect(clientCode.includes('t("injectTokenOnHint")')).toBeTruthy();
    });

    it("警示样式类", () => {
      expect(clientCode.includes("lp-set-warn")).toBeTruthy();
    });

    it("DEFAULTS 缺省开启（前向兼容：存量用户升级即生效）", () => {
      expect(clientCode.includes("injectToken: true")).toBeTruthy();
    });
  });
}

describe("client 契约（lib/client.js 产物字面量）", () => {
  registerSourceAndRouteContracts();

  registerI18nWiring();

  registerLocalValidation();

  registerEffectiveCalibration();

  registerCaActionSurface();

  registerCompressStatusRow();

  registerAccessibilityWiring();

  registerInjectTokenWarning();
});
