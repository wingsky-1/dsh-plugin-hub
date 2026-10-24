// dsh-mcp-manager 冒烟测试（vitest e2e project）—— McpStore 持久化族。
//
// #1174 shape 拆分产物：原 e2e/smoke.test.ts 的 store it 族整块迁入本文件
// （保存并读回无临时文件残留、upsert / remove、reloadIfChanged 外部修改重读）。
// fullName 与断言逐字保留（顶层 it 原名，不新增 describe 层级）。
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { McpStore } from "../../src/server/store/interface.ts";
import { normalizeServer } from "../../lib/index.js";

/** 在临时目录建一个空 store，返回 { store, path, cleanup }。 */
function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mcp-manager-"));
  const path = join(dir, "dsh-mcp.json");
  return {
    store: new McpStore(path),
    path,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

it("保存并读回，成功后无临时文件残留", async () => {
  const { store, path, cleanup } = tempStore();
  try {
    store.data.servers = [normalizeServer({ name: "a", transport: "stdio", command: "echo" })];
    await store.save();
    const reloaded = new McpStore(path);
    await reloaded.load();
    expect(reloaded.data.servers.length).toBe(1);
    expect(reloaded.data.servers[0].name).toBe("a");
    expect(
      readdirSync(dirname(path)).filter((name) => name.startsWith("dsh-mcp.json.tmp.")),
    ).toEqual([]);
  } finally {
    cleanup();
  }
});
it("upsert / remove", async () => {
  const { store, cleanup } = tempStore();
  try {
    store.upsert({ name: "a" } as ServerConfig);
    store.upsert({ name: "b" } as ServerConfig);
    expect(store.data.servers.length).toBe(2);
    store.upsert({ name: "a", extra: 1 } as unknown as ServerConfig);
    expect(store.data.servers.length).toBe(2);
    store.remove("a");
    expect(store.find("a")).toBe(undefined);
  } finally {
    cleanup();
  }
});
it("reloadIfChanged：外部修改重读 / 未变跳过 / 删除清空", async () => {
  const { store, path, cleanup } = tempStore();
  try {
    store.data.servers = [normalizeServer({ name: "a", transport: "stdio", command: "echo" })];
    await store.save();
    expect(await store.reloadIfChanged(), "无外部变更不重读").toBe(false);
    // 避免与 save() 基线同毫秒导致 reloadIfChanged 检测不到（事件驱动替代固定 sleep）。
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        servers: [{ name: "b", transport: "stdio", command: "echo", enabled: true }],
      }),
    );
    utimesSync(path, Date.now() / 1000 + 10, Date.now() / 1000 + 10);
    expect(await store.reloadIfChanged(), "外部修改触发重读").toBe(true);
    expect(store.data.servers.length).toBe(1);
    expect(store.data.servers[0].name, "重读后数据来自磁盘").toBe("b");
    expect(await store.reloadIfChanged(), "重读后基线推进").toBe(false);
    // 外部删除 → 清空配置（删除后 stat 失败 current=0，与基线 mtime 恒异，无需等待）。
    rmSync(path);
    expect(await store.reloadIfChanged(), "删除触发重读").toBe(true);
    expect(store.data.servers, "删除 = 清空配置").toEqual([]);
    expect(await store.reloadIfChanged(), "删除后基线推进").toBe(false);
  } finally {
    cleanup();
  }
});
