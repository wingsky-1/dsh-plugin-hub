/**
 * dsh-mcp-manager — unit：initMiddleware 失败语义（#392 遗留⑤）。
 *
 * 锁定的契约：configStore 加载抛错时 initMiddleware 重置 maps 后重抛——
 * 不静默吞错（apply 中止），this.middleware 保持未赋值（不建半初始化实例）。
 * 真实 load 实现损坏/缺失恒回空、永不抛，故用毒化 configStore 覆盖该 catch 分支。
 * 本文件独占模块图：installOrchestrator 在此装配毒化端口，不影响其它用例文件。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { installOrchestrator } from "../../src/server/connection/orchestrator/interface.ts";
import { McpManager } from "../../src/server/connection/orchestrator/manager.ts";
import * as catalogApi from "../../src/server/catalog/interface.ts";
import * as configModelApi from "../../src/server/config/interface.ts";
import * as lifecycleApi from "../../src/server/servers/lifecycle/interface.ts";
import * as pipelineApi from "../../src/server/pipeline/interface.ts";
import * as runtimeApi from "../../src/server/connection/runtime/interface.ts";
import * as statsApi from "../../src/server/stats/interface.ts";
import * as storeApi from "../../src/server/store/interface.ts";
import * as upgradeApi from "../../src/server/upgrade/interface.ts";
import * as workspaceApi from "../../src/server/workspace/interface.ts";
import { McpStore } from "../../src/server/store/interface.ts";

describe("#392 遗留⑤：initMiddleware 加载失败穿透且不残留半初始化状态", () => {
  it("configStore 抛错时重抛、maps 置空、middleware 保持未赋值", async () => {
    const boom = new Error("dsh-mcp-manager: poisoned configStore load");
    // 除加载面外全用真实实现：断言只针对 catch 的重置+重抛语义。
    installOrchestrator({
      catalog: catalogApi,
      configModel: configModelApi,
      configStore: {
        ...storeApi,
        loadUserState: async () => {
          throw boom;
        },
        loadDisabledTools: async () => {
          throw boom;
        },
      },
      runtime: runtimeApi,
      lifecycle: lifecycleApi,
      pipeline: pipelineApi,
      stats: statsApi,
      workspace: workspaceApi,
      upgrade: upgradeApi,
    });
    const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-initfail-"));
    try {
      const store = new McpStore(join(dir, "global.json"));
      store.data = { version: 1, servers: [] };
      const manager = new McpManager(
        {
          logger: {
            info: () => {},
            warn: () => {},
            error: () => {},
          },
        } as unknown as Context,
        store,
      );
      // 失败不吞错：原样穿透给 apply（apply 无 catch，中止装配）。
      await expect(manager.initMiddleware()).rejects.toBe(boom);
      // 半初始化状态已清理：实例未建、两表置空。
      expect(manager.middleware).toBeUndefined();
      expect(manager.disabledByRoot.size).toBe(0);
      expect(manager.disabledTools.size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
