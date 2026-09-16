/**
 * 测试支撑模块（support，不是测试条目——层登记见 mutation-topology 的 `$testLayers`）。
 *
 * 所有落盘都在 mkdtempSync 的隔离目录里：仓库纪律 #218 的产物零污染是红线，
 * 而 git fixture 天然要写很多文件，靠 `.gitignore` 兜底不算合规。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientSlotsPort, StoredEntryLike } from "../src/client/shared/ports.ts";

/** 建一个用后即弃的隔离目录。 */
export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), "dsh-worktree-sidebar-" + prefix + "-"));
}

/** 递归删除。清理失败不该让用例判红，故吞掉异常。 */
export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * 跑一条 git（fixture 搭建期用）。被测代码一律走注入的 exec 面，
 * 只有「把仓库造成那个样子」这一步不属于被测范围。
 */
export function git(dir: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

/** 在隔离目录里造一个真仓库并提交一次。关掉 gpgsign：用户的全局配置不该让 fixture 失败。 */
export function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "fixture@example.invalid"]);
  git(dir, ["config", "user.name", "fixture"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "README.md"), "fixture\n", "utf8");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "init"]);
}

/**
 * 假座位登记表：语义逐条对齐官方 SlotCore（`@deepseek-ai/dsh-client-ui-slots` 的 `lib/index.js:72-152` 与
 * `:187-200`；该包不在 dsh 安装树里，可读副本见 takeover.ts 头部注释给的 catalog 锁版路径）——
 * 同 key 同 priority 才抛、按 priority 升序、每个 cell 取首条存活项、被 abdicate 的条目不再当值；
 * 登记与撤销都按官方的**微任务批处理**通知（`markDirty` + `queueMicrotask`）。
 *
 * 为什么必须复刻而不是随手写个数组：客户端接管的失败形态是「右栏坏了」，语义不一致的假表会让
 * 「遮蔽之后当值的是不是我们」这类判据在测试里永远绿（本包为此栽过一次，见 client-takeover 文件头）。
 */
export interface FakeSlots {
  readonly slots: ClientSlotsPort;
  /** 某座位的原始账（含被遮蔽的条目）。 */
  entries(slot: string): readonly StoredEntryLike[];
  /** 某座位当前当值的那一条（可能没有）。 */
  winner(slot: string): StoredEntryLike | undefined;
  /** 立即触发某座位的变更通知（不等微任务）。 */
  emit(slot: string): void;
  /** 让某条条目退场（官方 `reportEntryError` 的 abdicate 分支）。 */
  abdicate(entry: StoredEntryLike): void;
  /** 触发一次 entry 崩溃回调；`abdicate` 为真时同时让该条目退场。 */
  reportError(slot: string, entry: StoredEntryLike, error: unknown, abdicate?: boolean): void;
}

export function createFakeSlots(initial: Record<string, StoredEntryLike[]> = {}): FakeSlots {
  const records = new Map<string, StoredEntryLike[]>();
  for (const [slot, entries] of Object.entries(initial)) records.set(slot, [...entries]);
  const listeners = new Map<string, Set<() => void>>();
  const errorListeners = new Set<(key: string, entry: StoredEntryLike, error: unknown) => void>();
  const abdicated = new WeakSet<StoredEntryLike>();
  let flushScheduled = false;
  const dirty = new Set<string>();

  const list = (slot: string): StoredEntryLike[] => {
    let entries = records.get(slot);
    if (entries === undefined) {
      entries = [];
      records.set(slot, entries);
    }
    return entries;
  };
  const emit = (slot: string): void => {
    for (const listener of [...(listeners.get(slot) ?? [])]) listener();
  };
  const markDirty = (slot: string): void => {
    dirty.add(slot);
    if (flushScheduled) return;
    flushScheduled = true;
    queueMicrotask(() => {
      flushScheduled = false;
      const slots = [...dirty];
      dirty.clear();
      for (const slot of slots) emit(slot);
    });
  };
  const winner = (slot: string): StoredEntryLike | undefined => {
    const seenCells = new Set<string | undefined>();
    for (const entry of list(slot)) {
      if (abdicated.has(entry)) continue;
      const cell = entry.options.key;
      if (seenCells.has(cell)) continue;
      seenCells.add(cell);
      return entry;
    }
    return undefined;
  };

  return {
    slots: {
      entries: (slot) => list(slot),
      entriesOfSlot: (slot) => {
        const heads: StoredEntryLike[] = [];
        const seenCells = new Set<string | undefined>();
        for (const entry of list(slot)) {
          if (abdicated.has(entry)) continue;
          const cell = entry.options.key;
          if (seenCells.has(cell)) continue;
          seenCells.add(cell);
          heads.push(entry);
        }
        return heads;
      },
      register: (options, component) => {
        const slot = String(options["name"]);
        const key = options["key"] as string | undefined;
        if (key === undefined) throw new Error(`keyed slot "${slot}" requires options.key`);
        const priority = options["priority"] as number | undefined;
        const occupant = list(slot).find(
          (entry) => entry.options.key === key && (entry.options.priority ?? 0) === (priority ?? 0),
        );
        if (occupant !== undefined) {
          throw new Error(
            `keyed slot "${slot}" already has an entry for key "${key}" at priority ${priority ?? 0} — register at a different priority to shadow it (lowest renders)`,
          );
        }
        const entry: StoredEntryLike = {
          component,
          options: {
            key,
            ...(priority !== undefined ? { priority } : {}),
          },
          ...(options["inject"] !== undefined
            ? { inject: options["inject"] as StoredEntryLike["inject"] }
            : {}),
          ...(options["store"] !== undefined ? { store: options["store"] } : {}),
          ...(options["locale"] !== undefined ? { locale: options["locale"] as string } : {}),
        };
        // 官方按 priority 升序（list 座位再按 order 兜底），当值判定依赖这个次序。
        list(slot).push(entry);
        list(slot).sort((a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0));
        markDirty(slot);
        return () => {
          const current = records.get(slot) ?? [];
          const at = current.indexOf(entry);
          if (at < 0) return;
          current.splice(at, 1);
          markDirty(slot);
        };
      },
      subscribe: (slot, listener) => {
        let set = listeners.get(slot);
        if (set === undefined) {
          set = new Set();
          listeners.set(slot, set);
        }
        set.add(listener);
        return () => set.delete(listener);
      },
      onEntryError: (listener) => {
        errorListeners.add(listener);
        return () => errorListeners.delete(listener);
      },
    },
    entries: (slot) => list(slot),
    winner,
    emit,
    abdicate: (entry) => {
      abdicated.add(entry);
    },
    reportError: (slot, entry, error, abdicate = false) => {
      if (abdicate) abdicated.add(entry);
      for (const listener of [...errorListeners]) listener(slot, entry, error);
    },
  };
}
