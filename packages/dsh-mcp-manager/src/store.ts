/**
 * dsh-mcp-manager — 配置存储（独立模块，无内部依赖）。
 *
 * 服务器配置持久化在 `~/.dsh/dsh-mcp.json`（版本化，原子写入）。
 * 由 lib/index.js 组合根 re-export。
 */

import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { dshHome } from "../../../shared/dsh-home.js";
import type { ServerConfig } from "./types.ts";

// ------------------------------------------------------------------ 存储

/** 默认配置存储路径。 */
export function defaultStorePath() {
  return join(dshHome(), "dsh-mcp.json");
}

/**
 * 版本化存储：{ version: 1, servers: ServerConfig[] }。
 * 记录磁盘 mtime 基线：外部修改（git pull / 手动编辑）可被 reloadIfChanged 检测，
 * 无需重启宿主即生效（写路径全部经 save 落盘，内存态始终有盘上副本，重读无冲突）。
 */
export class McpStore {
  path: string;
  data: { version: number; servers: ServerConfig[] };
  /** 上次读/写时的文件 mtime；undefined = 从未建立基线，0 = 当前文件不存在。 */
  mtimeMs: number | undefined;

  constructor(path: string) {
    this.path = path;
    this.data = { version: 1, servers: [] };
    this.mtimeMs = undefined;
  }

  async load() {
    if (!existsSync(this.path)) {
      // 文件不存在：外部删除 = 清空配置；建立 0 基线（下次创建文件可被检测）。
      this.data = { version: 1, servers: [] };
      this.mtimeMs = 0;
      return;
    }
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as { servers?: unknown };
      if (Array.isArray(parsed.servers)) this.data.servers = parsed.servers as ServerConfig[];
      this.mtimeMs = (await stat(this.path)).mtimeMs;
    } catch {
      // 损坏的存储保持内存态，不覆盖也不启动崩溃；仍推进基线避免反复重读。
      try {
        this.mtimeMs = (await stat(this.path)).mtimeMs;
      } catch {
        this.mtimeMs = 0;
      }
    }
  }

  async save() {
    const dir = dirname(this.path);
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(tmp, this.path);
    try {
      this.mtimeMs = (await stat(this.path)).mtimeMs;
    } catch {
      this.mtimeMs = 0;
    }
  }

  /** 磁盘文件是否已被外部修改（mtime 与基线比对；无基线不视为变更）。 */
  async changedOnDisk() {
    let current;
    try {
      current = (await stat(this.path)).mtimeMs;
    } catch {
      current = 0; // 文件不存在
    }
    if (this.mtimeMs === undefined) return false;
    return current !== this.mtimeMs;
  }

  /** 外部变更时重读；返回是否发生了重读。 */
  async reloadIfChanged() {
    if (!(await this.changedOnDisk())) return false;
    await this.load();
    return true;
  }

  find(name: string): ServerConfig | undefined {
    return this.data.servers.find((server) => server.name === name);
  }

  upsert(server: ServerConfig) {
    const index = this.data.servers.findIndex((entry) => entry.name === server.name);
    if (index >= 0) this.data.servers[index] = server;
    else this.data.servers.push(server);
  }

  remove(name: string) {
    const index = this.data.servers.findIndex((entry) => entry.name === name);
    if (index >= 0) this.data.servers.splice(index, 1);
  }
}
