/**
 * dsh-mcp-manager — 配置存储（独立模块，无内部依赖）。
 *
 * 服务器配置持久化在本插件私有目录（路径的物理定义在 server/shared/paths.ts，版本化，
 * 原子写入）。由 lib/index.js 组合根 re-export。
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { configFile, fileMode } from "../../shared/interface.ts";
import type { ServerConfig } from "../../config/interface.ts";

// ------------------------------------------------------------------ 存储

/**
 * 同路径 save 串行链（#903 M-store：rename 先后无保证，同毫秒两次 save 的 tmp
 * 同名互盖 + rename 竞态丢更新）。模块级（file-io writeChains 同式）：串行必须跨
 * 实例生效（全局 store 与项目 store 可能同路径）；前一次失败不阻断下一次。
 */
const saveChains = new Map<string, Promise<void>>();

/** 唯一临时名：pid + 时间戳 + 随机后缀——同名临时文件绝不会被两次写共用（#903 M-store）。 */
function temporaryNameFor(path: string): string {
  return `${path}.tmp.${process.pid}.${Date.now().toString(36)}.${randomBytes(6).toString("hex")}.tmp`;
}

/**
 * 默认配置存储路径。文件名与权限是迁移契约，只能来自 server/shared/paths.ts 的单点定义；
 * 就地拼 DSH_HOME 与文件名会让迁移的读面与写面各持一份字面量（I7）。
 */
export function defaultStorePath() {
  return configFile();
}

/**
 * 版本化存储：{ version: 1, servers: ServerConfig[] }。
 * 记录磁盘基线（mtime + 全文快照）：外部修改（git pull / 手动编辑）可被
 * reloadIfChanged 检测，无需重启宿主即生效；save 前若基线已失配则 fail-closed
 * 抛错（#903 M3-store 反写：静默覆盖外部编辑即丢用户数据）。
 */
export class McpStore {
  path: string;
  data: { version: number; servers: ServerConfig[] };
  /** 上次读/写时的文件 mtime；undefined = 从未建立基线，0 = 当前文件不存在。 */
  mtimeMs: number | undefined;
  /** 上次读/写时的文件全文快照（同毫秒 mtime 漏检的第二道锁，#903 M3-store）；null = 无文件内容基线。 */
  snapshot: string | null = null;

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
      this.snapshot = null;
      return;
    }
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as { servers?: unknown };
      // 解析成功但缺 servers/形态不对 = 空配置（#903 M3-store：静默保留内存旧值
      // 会让已删配置复活；损坏 JSON 仍走 catch 保持内存态，两者区分处理）。
      this.data.servers = Array.isArray(parsed.servers) ? (parsed.servers as ServerConfig[]) : [];
      this.mtimeMs = (await stat(this.path)).mtimeMs;
      this.snapshot = raw;
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
    // 同路径串行（#903 M-store）：链上排队，前一次失败不阻断下一次。
    // 冲突检查在链内（writeSnapshot 首行）：检查放链外时，跨实例并发 save 会在
    // 检查与落盘之间插空，检查形同虚设。
    const previous = saveChains.get(this.path) ?? Promise.resolve();
    const next = previous.then(
      () => this.writeSnapshot(),
      () => this.writeSnapshot(),
    );
    saveChains.set(this.path, next);
    try {
      await next;
    } finally {
      if (saveChains.get(this.path) === next) saveChains.delete(this.path);
    }
  }

  /** 单次落盘：链内写前冲突检查（fail-closed）+ 唯一 tmp 名 + 失败清理后上抛原错误。 */
  private async writeSnapshot() {
    // #903 M3-store 反写：基线失配说明排队期间有外部写入，直接落盘会静默覆盖——
    // 抛错让调用方（路由 handleError）如实返回。无基线（新 store 未 load）不视为冲突。
    if (await this.changedOnDisk()) {
      throw new Error(
        `dsh-mcp-manager: 配置文件在外部被修改（${this.path}），本次写入已中止以防覆盖；请重载后重试`,
      );
    }
    const dir = dirname(this.path);
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    // mode 取登记表：项目级新形态 null→随项目自身权限模型（与 file-io 同式不设 mode）；
    // 未登记（用户 storePath 显式接管的任意路径）回落既有 0o600 行为——直接套 fileMode 会抛（I6）。
    let mode: number | null;
    try {
      mode = fileMode(this.path);
    } catch {
      mode = 0o600;
    }
    const payload = JSON.stringify(this.data, null, 2);
    const tmp = temporaryNameFor(this.path);
    try {
      await writeFile(
        tmp,
        payload,
        mode === null ? { encoding: "utf8" } : { encoding: "utf8", mode },
      );
      await rename(tmp, this.path);
    } catch (error) {
      try {
        await rm(tmp, { force: true });
      } catch {
        // 清理失败忽略：tmp 可能未创建，或权限问题，主错误优先上抛
      }
      throw error;
    }
    try {
      this.mtimeMs = (await stat(this.path)).mtimeMs;
    } catch {
      this.mtimeMs = 0;
    }
    this.snapshot = payload;
  }

  /** 磁盘文件是否已被外部修改（mtime 不等即变更；mtime 相等再比全文快照，防同毫秒漏检；无基线不视为变更）。 */
  async changedOnDisk() {
    if (this.mtimeMs === undefined) return false;
    let current;
    try {
      current = (await stat(this.path)).mtimeMs;
    } catch {
      current = 0; // 文件不存在
    }
    if (current !== this.mtimeMs) return true;
    // #903 M3-store 同毫秒漏检：mtime 粒度内多次写 / 外部改与 save 同毫秒时读全文比对。
    if (this.snapshot === null) return false;
    try {
      return (await readFile(this.path, "utf8")) !== this.snapshot;
    } catch {
      return true; // 基线有文件、现在读不出 = 被删
    }
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
