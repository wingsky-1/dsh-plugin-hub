/**
 * dsh-mcp-manager — 跨端一致性锁（D5 的永久不变式；#767 B1.5a）。
 *
 * 两面判据，缺一面都会留下假绿：
 *  A 值一致：客户端路径表逐键等于宿主 ROUTES；宿主产物帧名等于 shared 帧名。
 *  B 单点定义：规范字面量（11 条路由路径 / SSE 帧名 / 客户端状态表的六态键）在包内
 *    只允许出现在 src/shared/**。只有 A 时，一份**等值的副本**照样全绿——B 才是
 *    「两端真的用同一份」的判据，也是本锁存在的理由（不是迁移期临时件）。
 *
 * 边界（刻意不判）：客户端其它文件里对 `server.status` 的比较字面量、展示顺序与颜色
 * 属单端实现与纯展示数据，不在跨端契约面内；仓库根 shared/sse-hub.js 的心跳帧是跨包
 * 共享层（本包不拥有），其字面量也不在本判据面内。
 *
 * 追加于 B1.5b 的两面：C 单点定义从「字面量」扩到「DTO 形状声明」（客户端不得自带
 * 副本），D 是**回归闸**——本包的服务声明面已从仓库根退回包内，仓库根不得再长出
 * 同名文件或再被源码引用（旧位置的文件与现在的包内定义会构成两个物理定义面）。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ROUTES, SERVER_STATES, SSE_FRAMES } from "../../src/shared/interface.ts";
import { API, STATUS_ORDER, STATUS_TEXT } from "../../src/client/core/constants.ts";
import { ROUTES as PRODUCT_ROUTES, SSE_PING_FRAME, uiConfigChangedFrame } from "../../lib/index.js";

const pkgDir = fileURLToPath(new URL("../../", import.meta.url));
const srcDir = join(pkgDir, "src");

/** 包根相对路径（判词里稳定可读）。 */
function rel(abs) {
  return abs.slice(pkgDir.length).replace(/\\/g, "/");
}

/** src 下参与判据的源文件（.ts/.tsx；.d.ts 无值面）。 */
function collectSrcFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(abs);
    }
  };
  walk(srcDir);
  return out.sort();
}

/** 逐行命中（行号 + 内容）；global 正则每次重置 lastIndex。 */
function hits(text, re) {
  const found = [];
  text.split("\n").forEach((line, index) => {
    re.lastIndex = 0;
    if (re.test(line)) found.push(`${index + 1}: ${line.trim()}`);
  });
  return found;
}

/** 只允许有一个物理定义的规范字面量。 */
const SINGLE_DEFINITION_RULES = [
  { id: "路由路径字面量", re: /"\/api\/dsh-mcp\/[^"]*"/g },
  { id: "SSE 帧名字面量", re: /"(?:ui-config-changed|ping)"/g },
  // 只认「帧工厂调用」这一形态：summary 是通用词，裸 literal 规则会命中注释里的
  // `{ type: "summary" }` 散文（实测踩过），故收紧到 sseData(...) 调用形状。
  { id: "SSE 帧负载字面量", re: /sseData\(\s*\{\s*type:\s*"summary"\s*\}\s*\)/g },
];

/** 客户端状态表的键不得自带：六态字面量。 */
const STATE_KEY_LITERAL = /"(?:connected|connecting|reconnecting|stopped|disabled|failed)"/g;

/**
 * 跨端 DTO 形状只允许在 src/shared/** 有物理定义。
 * 只认**声明**形态（`export interface X` / `export type X =`）：`export type { X } from`
 * 是同名再转出，不构成第二份定义。
 */
const DTO_SHAPE_DECLARATION =
  /^\s*export\s+(?:interface|type)\s+(?:McpServerSummary|McpServerListEntry|ClientUiConfig)\b/g;

/** 指向仓库级服务声明面的 import / re-export 说明符（旧文件已退回包内）。 */
const RETIRED_SERVICE_SPECIFIER =
  /(?:from|import)\s*\(?\s*["'][^"']*mcp-manager-service[^"']*["']/g;

/** SSE data 帧的 type 字段（帧体形状：`data: {"type":"..."}\n\n`）。 */
function frameType(frame) {
  return JSON.parse(frame.replace(/^data: /, "").trim()).type;
}

/**
 * C 协议值冻结表（D5 §5.2：本轮只搬物理位置、不改线协议语义）。
 *
 * 这是**有意**的第二份写法，与实现副本的区别：它是 ABI 期望值（同 export-surface-snapshot
 * 的性质），改这里的唯一正当理由是「协议变更」——而那正是必须显式过审、显式进 release notes
 * 的动作。少了它，单点里的值被顺手改掉时两端会「一致地漂移」，没有任何信号。
 */
const FROZEN_ROUTES = {
  servers: "/api/dsh-mcp/servers",
  config: "/api/dsh-mcp/config",
  session: "/api/dsh-mcp/session",
  resume: "/api/dsh-mcp/resume",
  connect: "/api/dsh-mcp/servers/connect",
  disconnect: "/api/dsh-mcp/servers/disconnect",
  reconnect: "/api/dsh-mcp/servers/reconnect",
  importJson: "/api/dsh-mcp/import/json",
  events: "/api/dsh-mcp/events",
  health: "/api/dsh-mcp/health",
  toolDisable: "/api/dsh-mcp/tool-disable",
};
const FROZEN_FRAMES = { summary: "summary", uiConfigChanged: "ui-config-changed", ping: "ping" };
const FROZEN_STATES = {
  connected: "connected",
  connecting: "connecting",
  reconnecting: "reconnecting",
  disabled: "disabled",
  stopped: "stopped",
  failed: "failed",
};

describe("C 协议值冻结（单点里的值不得被顺手改掉）", () => {
  it("路由路径（键序 + 值）与冻结表逐字相同", () => {
    expect(JSON.stringify(ROUTES)).toBe(JSON.stringify(FROZEN_ROUTES));
  });

  it("SSE 帧名与冻结表逐字相同", () => {
    expect(JSON.stringify(SSE_FRAMES)).toBe(JSON.stringify(FROZEN_FRAMES));
  });

  it("六态键集合与键序与冻结表逐字相同", () => {
    expect(JSON.stringify(SERVER_STATES)).toBe(JSON.stringify(FROZEN_STATES));
  });
});

describe("A 值一致（两端取到的值必须逐条相同）", () => {
  it("客户端路径表逐键 === 宿主 ROUTES", () => {
    expect(Object.keys(API).sort()).toEqual(Object.keys(ROUTES).sort());
    for (const key of Object.keys(ROUTES)) {
      expect(API[key], `客户端路径表与宿主 ROUTES 漂移：${key}`).toBe(ROUTES[key]);
    }
  });

  it("宿主产物 ROUTES === shared ROUTES（入口转出未分叉）", () => {
    expect(PRODUCT_ROUTES).toEqual(ROUTES);
  });

  it("宿主产物帧名 === shared 帧名", () => {
    expect(frameType(uiConfigChangedFrame())).toBe(SSE_FRAMES.uiConfigChanged);
    expect(frameType(SSE_PING_FRAME)).toBe(SSE_FRAMES.ping);
  });

  it("客户端产物内联 shared 帧名全集（客户端拿到的是同一份帧名）", () => {
    const clientSrc = readFileSync(join(pkgDir, "lib/client.js"), "utf8");
    const missing = Object.values(SSE_FRAMES).filter(
      (name) => !clientSrc.includes(JSON.stringify(name)),
    );
    expect(missing, `客户端产物缺少 shared 帧名：${missing.join(",")}`).toEqual([]);
  });
});

describe("B 单点定义（不得出现等值副本）", () => {
  it("规范字面量只允许出现在 src/shared/**", () => {
    const violations = [];
    for (const abs of collectSrcFiles()) {
      const path = rel(abs);
      if (path.startsWith("src/shared/")) continue;
      const text = readFileSync(abs, "utf8");
      for (const rule of SINGLE_DEFINITION_RULES) {
        for (const hit of hits(text, rule.re)) violations.push(`${path} [${rule.id}] ${hit}`);
      }
    }
    expect(
      violations,
      `规范字面量出现在 src/shared 之外（两端自带副本 = 单一事实源被破）：\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("客户端状态表不含六态键字面量", () => {
    const text = readFileSync(join(pkgDir, "src/client/core/constants.ts"), "utf8");
    expect(hits(text, STATE_KEY_LITERAL)).toEqual([]);
  });

  it("跨端 DTO 形状声明只允许出现在 src/shared/**", () => {
    const violations = [];
    for (const abs of collectSrcFiles()) {
      const path = rel(abs);
      if (path.startsWith("src/shared/")) continue;
      const text = readFileSync(abs, "utf8");
      for (const hit of hits(text, DTO_SHAPE_DECLARATION)) {
        violations.push(`${path} [DTO 形状副本] ${hit}`);
      }
    }
    expect(
      violations,
      `跨端 DTO 形状在 src/shared 之外被重新声明（两端自带副本 = 单一事实源被破）：\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("锁不空转：src/shared 下确实存在这三个 DTO 形状的唯一定义", () => {
    const dto = readFileSync(join(pkgDir, "src/shared/dto.ts"), "utf8");
    const declared = ["McpServerSummary", "McpServerListEntry", "ClientUiConfig"].filter((name) =>
      new RegExp(`export (interface|type) ${name}\\b`).test(dto),
    );
    expect(declared.sort()).toEqual(["ClientUiConfig", "McpServerListEntry", "McpServerSummary"]);
  });

  it("锁不空转：两张状态表真的覆盖 shared 六态键全集", () => {
    const sharedKeys = Object.keys(SERVER_STATES).sort();
    expect([...STATUS_ORDER.map((entry) => entry.key)].sort()).toEqual(sharedKeys);
    expect(Object.keys(STATUS_TEXT).sort()).toEqual(sharedKeys);
  });
});

describe("D 服务类型不再有仓库级声明面（#767 B1.5b 回归闸）", () => {
  // 旧位置的文件若被重建，本包的服务类型就同时存在两个物理定义面（仓库根那份与
  // src/shared/service.ts），而**没有任何既有闸看得见它**：verify-dir-imports 的面是
  // 包内 src/**，pack-check 的 shared 期望清单取自仓库 shared/ 自身（源目录里有它
  // 就算「期望存在」，构建后每个包都随包复制一份，反而恒绿）。故这条判据落在本锁里。
  it("仓库根 shared/ 不得重建 mcp-manager-service 声明文件", () => {
    const repoShared = join(pkgDir, "..", "..", "shared");
    const strays = existsSync(repoShared)
      ? readdirSync(repoShared).filter((name) => name.startsWith("mcp-manager-service"))
      : [];
    expect(
      strays,
      `仓库根 shared/ 出现服务声明面副本（已随 B1.5b 退回包内）：${strays.join(", ")}`,
    ).toEqual([]);
  });

  it("包内源码不得再引用仓库级 mcp-manager-service 声明", () => {
    const violations = [];
    for (const abs of collectSrcFiles()) {
      const text = readFileSync(abs, "utf8");
      for (const hit of hits(text, RETIRED_SERVICE_SPECIFIER)) {
        violations.push(`${rel(abs)} ${hit}`);
      }
    }
    expect(violations, `源码仍指向已退回包内的仓库级声明面：\n${violations.join("\n")}`).toEqual(
      [],
    );
  });
});
