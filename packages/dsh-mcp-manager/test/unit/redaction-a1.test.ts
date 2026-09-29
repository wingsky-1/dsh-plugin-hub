/**
 * dsh-mcp-manager — unit：调用方展开 ENV 模板后再脱敏（#770-A1）。
 *
 * 分工锁定：pipeline.createRedactor 保持纯函数（内不读 process.env），展开是
 * 调用方的职责——唯一秘密源 McpManager.getRedactionServers 在返回快照前经
 * configModel.expandServerEnv 展开，middleware.redact 与 dispatch
 * redactMcpError 经同一快照自动获得展开值（三处同调）。
 *
 * 覆盖：
 * - env 模板 + process.env 设置：error 含展开值被抹（经快照 + redactError 端到端）；
 * - redactor 自身不展开：原始模板服务器直接喂 createRedactor 时展开值残留
 *   （反例，锁定"展开在调用方"分工；若有人把展开移进 redactor，本用例失败）；
 * - 无模板恒等无害：值不变、脱敏仍命中；
 * - 空串不注册：未设置的变量展开为空串，不产生全量误抹（文本恒等、无 [REDACTED] 注入）。
 *
 * 凭据全为虚构测试串，无真实凭据；落盘仅进 mkdtempSync 隔离目录。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerConfig } from "../../src/server/config/interface.ts";
import * as configModelApi from "../../src/server/config/interface.ts";
import * as pipelineApi from "../../src/server/pipeline/interface.ts";
import * as catalogApi from "../../src/server/catalog/interface.ts";
import * as configStoreApi from "../../src/server/store/interface.ts";
import * as statsApi from "../../src/server/stats/interface.ts";
import { McpStore } from "../../src/server/store/interface.ts";
import {
  installOrchestrator,
  releaseOrchestrator,
  McpManager,
} from "../../src/server/connection/orchestrator/interface.ts";
import { fakeManagerCtx } from "../helpers.ts";

const A1_SECRET = "a1-fake-expanded-secret-X7y9Z1";
const A1_PLAIN_SECRET = "a1-fake-plain-secret-Q3w5E7";
const ENV_VAR = "DSH_MCP_MANAGER_A1_TEST_SECRET";
const UNSET_VAR = "DSH_MCP_MANAGER_A1_UNSET_VAR_XYZ";

let tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  try {
    releaseOrchestrator();
  } catch {
    // 未装配时复位抛错，忽略（不掩盖用例结论）
  }
  delete process.env[ENV_VAR];
  delete process.env[UNSET_VAR];
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

/** 仅装配 manager 快照链用到的端口（其余按类型面占位，运行期不触达）。 */
function installSnapshotPorts(): void {
  installOrchestrator({
    catalog: catalogApi,
    configModel: configModelApi,
    configStore: configStoreApi,
    runtime: {} as never,
    lifecycle: {} as never,
    pipeline: pipelineApi,
    stats: statsApi,
    workspace: {} as never,
    upgrade: {} as never,
  });
}

function stdioServer(name: string, env: Record<string, string>): ServerConfig {
  return { name, transport: "stdio", command: "echo", env } as unknown as ServerConfig;
}

/** 模板值拼装（避免在源码里写字面量模板形态）。 */
function tpl(name: string): string {
  return "${" + name + "}";
}

function managerWith(server: ServerConfig): InstanceType<typeof McpManager> {
  const dir = makeTempDir("dsh-mcp-a1-");
  const store = new McpStore(join(dir, "global.json"));
  store.data = { version: 1, servers: [server] } as unknown as McpStore["data"];
  return new McpManager(fakeManagerCtx(), store as never) as InstanceType<typeof McpManager>;
}

describe("#770-A1 调用方展开模板", () => {
  it("env 模板经快照展开：error 含展开值被抹", () => {
    process.env[ENV_VAR] = A1_SECRET;
    installSnapshotPorts();
    const manager = managerWith(stdioServer("tpl-srv", { HIDDEN_TOKEN: tpl(ENV_VAR) }));
    const snapshot = manager.getRedactionServers();
    expect(snapshot[0]?.env?.["HIDDEN_TOKEN"]).toBe(A1_SECRET);
    const out = (manager as unknown as { redactError(error: unknown): string }).redactError(
      new Error("boom " + A1_SECRET),
    );
    expect(out).not.toContain(A1_SECRET);
    expect(out).toContain("[REDACTED]");
  });

  it("redactor 自身不展开（分工反例：原始模板直喂时展开值残留）", () => {
    process.env[ENV_VAR] = A1_SECRET;
    const raw = stdioServer("tpl-srv", { HIDDEN_TOKEN: tpl(ENV_VAR) });
    const out = pipelineApi.createRedactor([raw])(new Error("boom " + A1_SECRET));
    expect(out).toContain(A1_SECRET);
  });

  it("无模板恒等无害：快照值不变、脱敏仍命中", () => {
    installSnapshotPorts();
    const plain = stdioServer("plain-srv", { HIDDEN_TOKEN: A1_PLAIN_SECRET });
    const manager = managerWith(plain);
    const snapshot = manager.getRedactionServers();
    expect(snapshot[0]?.env?.["HIDDEN_TOKEN"]).toBe(A1_PLAIN_SECRET);
    // 恒等指值相等（展开返回新对象，不就地改写落盘配置）。
    expect(snapshot[0]).not.toBe(plain);
    const out = (manager as unknown as { redactError(error: unknown): string }).redactError(
      new Error("boom " + A1_PLAIN_SECRET),
    );
    expect(out).not.toContain(A1_PLAIN_SECRET);
    expect(out).toContain("[REDACTED]");
  });

  it("空串不注册：未设置变量展开为空串，文本恒等无误抹", () => {
    delete process.env[UNSET_VAR];
    installSnapshotPorts();
    const manager = managerWith(stdioServer("empty-srv", { HIDDEN_TOKEN: tpl(UNSET_VAR) }));
    const snapshot = manager.getRedactionServers();
    expect(snapshot[0]?.env?.["HIDDEN_TOKEN"]).toBe("");
    const text = "plain error without secrets";
    const out = (manager as unknown as { redactError(error: unknown): string }).redactError(
      new Error(text),
    );
    expect(out).toBe(text);
    expect(out).not.toContain("[REDACTED]");
  });
});
