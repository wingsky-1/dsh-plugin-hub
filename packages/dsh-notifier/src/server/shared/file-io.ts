/**
 * 落盘 IO 的单一实现（原子写 + 容错读）：先写同目录临时文件、再 `rename` 覆盖目标——同一文件系统内 `rename` 是原子的，读到的
 * 要么旧内容要么新内容、不会是写了一半的 JSON（直接 `writeFile` 到目标则在截断与写入之间有窗口）；失败用返回值表达而不是抛出。
 *
 * 原子性只解决「读到写了一半的文件」，不解决「后写的被先写的盖回去」：`rename` 的先后在并发下由调度决定，
 * 实测同路径 2000 路并发写有 16/20 轮把旧值覆盖回盘上，且每一次都返回 ok（静默丢数据；序号文件回退会让客户端
 * 按 `seq <= lastSeq` 静默丢帧）。故写盘恒定四件事：**同路径串行** → 显式 mode 写临时名 → `rename` 覆盖 →
 * 失败清掉临时名并把**原错误**交回调用方（不吞、不替换成清理的失败）。
 *
 * 已知限制（不在本层可解）：没有 fsync，掉电时目录项可能尚未落盘。补 fsync 治不了上面那个乱序回退（成因是并发
 * `rename` 的先后，不是持久化时序），代价是每次写多两次系统调用；这里按「已知限制」登记，不假装已耐久。
 */
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** 读取结果：文件不存在、不可读、是目录都归为「没有内容」。 */
type FileRead = { ok: true; text: string } | { ok: false };

/** 写入结果：失败带回原因文本（不含路径之外的敏感信息）。 */
export type FileWrite = { ok: true } | { ok: false; reason: string };

/** 落盘文件的权限：只有本人可读写。mode 挂在**写临时名**上而不是事后 chmod——`rename` 保留 mode，
 * 事后补等于先开一个 0644 的窗口，而落盘面里有带凭据的 `config.json`。 */
const FILE_MODE = 0o600;

/**
 * 插件自有目录（`<DSH_HOME>/@wingsky-1/dsh-notifier/`）的权限：只有本人可进出。
 *
 * 既是**新建时**的目标值，也是**既存时**的掩码（`mode & DIR_MODE`）——一处常量两用，口径不分叉。
 */
const DIR_MODE = 0o700;

/**
 * 同目标路径的写链——**模块级**的（#733 宪法第 1 条的一处显式例外，形态与理由同
 * `packages/dsh-mcp-manager/src/server/shared/file-io.ts`）：
 *  - 串行必须**跨调用点**生效。序号落盘（api/stream）、历史追加（stores/history）、配置落盘（config/service）
 *    各走各的调用点，队列收进实例等于各写各的，等于没有队列。
 *  - **门禁盲区如实登记**：`forbid-module-state-src` 的 AST 判据只命中 Program 顶层的 `let`/`var`，本行的
 *    `const` + `new Map()` 不命中。这不是「门禁没报所以合规」——Map 的内容确实跨 apply() 共享，是有意为之。
 *  - settle 后按 key 删条目：链条不跨调用累积（否则长跑进程里这张表只增不减）；只在条目仍是自己时删，
 *    免得把已经排上后继的链摘掉。
 */
const writeChains = new Map<string, Promise<void>>();

/** 唯一临时名：pid+时间戳+随机后缀，同进程并发双写不再共用同一 tmp（否则两路 `writeFile` 截断同一路径）。 */
function temporaryNameFor(file: string): string {
  return `${file}.tmp-${process.pid}.${Date.now().toString(36)}.${randomBytes(6).toString("hex")}.tmp`;
}

/**
 * 补齐父目录，并把**叶子那一级**收进 `DIR_MODE` 允许的范围。
 *
 * 四条边界，同一句话：不越权改别人的东西。
 *  - `mkdir` 的 mode 会套到递归建出的**每一级**上，照传 `0o700` 会把 DSH home 根与 `@wingsky-1/` 一起收成
 *    0700——那是宿主与其它插件的共享面。故先不带 mode 建链，父目录保持 umask 语义，再单独 chmod 叶子。
 *  - 权限口径对新建与既存**同一条公式** `mode & DIR_MODE`：**只保留 owner 三位**（group/other 一律清零），
 *    **永不新增任何权限位**。这比「既存目录完全不 chmod」更对——后者让旧安装的 0755/0777 目录永远收不紧，
 *    正是本包自己的缺口；而 `&` 掩码只做减法，故运维的意图不会被反向撤销：0555 收成 0500、**仍然只读**，
 *    刻意设成只读的目录不会被重新打开可写（`upgrade/service.test.ts` 拿只读目录排故障的那条判据因此不受影响）。
 *    收的读面落在 group/other 上（里面躺着带凭据的 `config.json`），不动 owner 的可写性。
 *  - **掩码连特殊位一起清**（已登记的行为变更）：系统调用层的 `chmod`（Node `fs.chmod`）只按 mode 参数里出现的位
 *    设置，参数里没有的位一律清掉（coreutils 的 `chmod(1)` 对目录会刻意保留 setuid/setgid，本条说的不是它），
 *    所以 owner 之外的 setuid/setgid/sticky 也会被清——实测同一条公式下 `2770`/`1777`/`4755`/`7777` 全部落成
 *    `0700`，团队共享目录常见的 `2770` 的 setgid 同样被清。方向是加固（私有数据目录上这些位本无实际语义），
 *    故不改公式、只如实登记；目录若带 POSIX 扩展 ACL，ACL mask 还会被收紧为 `0`，命名条目的**有效**权限随之归零
 *    （条目本身仍在）。
 *  - 收紧失败一律吞掉：权限是加固不是功能，收不动（Windows / 非本用户 / 只读挂载）不该让整次写失败、也不该进 reason。
 */
async function ensureDir(dir: string): Promise<void> {
  // 返回值是「本次建出来的第一个目录」：目录已存在时为 undefined，据此区分新建与既存。
  const created = await mkdir(dir, { recursive: true });
  if (created === undefined) {
    // 既存：`mode & DIR_MODE`——owner 三位原样保留，group/other 与特殊位一并清掉（口径见上）。stat 拿不到就放弃收紧——不猜，也不让写失败。
    try {
      await chmod(dir, (await stat(dir)).mode & DIR_MODE);
    } catch {
      // 同下：权限是加固不是功能。
    }
    return;
  }
  // 新建：直接落 DIR_MODE（把 umask 抠掉的 owner 位补回来）。
  await chmod(dir, DIR_MODE).catch(() => undefined);
}

/** 单次写（不含串行）：写临时名 → `rename` 覆盖；失败清掉临时名后**上抛原错误**。 */
async function writeOnce(file: string, text: string): Promise<void> {
  // 目录补齐放在 try 外：mkdir 失败时临时名还不存在，没有可清的东西。
  await ensureDir(dirname(file));
  const temporary = temporaryNameFor(file);
  try {
    await writeFile(temporary, text, { encoding: "utf8", mode: FILE_MODE });
    await rename(temporary, file);
  } catch (cause) {
    // 清理失败不掩盖原始错误：调用方要看到的是「为什么没写成」，不是「清理也没成」。
    await rm(temporary, { force: true }).catch(() => undefined);
    throw cause;
  }
}

/** 原子写全文：同目标路径串行（见 `writeChains`），失败用返回值表达。 */
export async function writeTextAtomic(file: string, text: string): Promise<FileWrite> {
  const previous = writeChains.get(file) ?? Promise.resolve();
  // 两个分支都走 writeOnce：链不能被一次失败毒化，否则一次 EACCES/ENOSPC 之后该路径再也写不进去。
  const next = previous.then(
    () => writeOnce(file, text),
    () => writeOnce(file, text),
  );
  writeChains.set(file, next);
  try {
    await next;
    return { ok: true };
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : "写入失败" };
  } finally {
    if (writeChains.get(file) === next) writeChains.delete(file);
  }
}

/** 读全文。只在装配路径上使用：设置必须在 `apply` 返回时就已是最终值，否则「读面第一次被调用」与「文件加载完成」
 * 之间会开一个窗口。不区分「不存在」与「读失败」——两者处置一致（调用方回落空值），区分只会多一个分支。 */
export function readTextFileSync(file: string): FileRead {
  try {
    return { ok: true, text: readFileSync(file, "utf8") };
  } catch {
    return { ok: false };
  }
}

/** 补齐父目录并把叶子收进 `DIR_MODE` 允许的范围（同步版；四条边界同 `ensureDir`）。 */
function ensureDirSync(dir: string): void {
  const created = mkdirSync(dir, { recursive: true });
  try {
    // 新建直接落 DIR_MODE；既存走同一条 `mode & DIR_MODE` 公式（owner 三位不动，group/other 与特殊位清零）。
    chmodSync(dir, created === undefined ? statSync(dir).mode & DIR_MODE : DIR_MODE);
  } catch {
    // 同 ensureDir：权限收不动不该让整次写失败。
  }
}

/**
 * 原子写全文（同步版）。只给装配路径上的小文件用（升级链每次推进都要落一次版本号）：同步写换掉的是「装配还没
 * 返回，磁盘上却已是新版本」这类顺序问题。
 *
 * **不进写链**：同步函数没有 promise 可挂，`writeChains` 对它不成立——不假装它也被串行化了。它的服务面是升级期的
 * 独占路径（`upgrade/impl/steps/*` 与 `upgrade/impl/version/`，装配尚未对外服务、没有并发的第二写方），
 * 此刻读到的必然是本进程刚落下的内容。将来若把它挪到有并发写的面上，`rename` 先后就重新变成调度说了算。
 */
export function writeTextAtomicSync(file: string, text: string): FileWrite {
  const temporary = temporaryNameFor(file);
  try {
    ensureDirSync(dirname(file));
    writeFileSync(temporary, text, { encoding: "utf8", mode: FILE_MODE });
    renameSync(temporary, file);
    return { ok: true };
  } catch (cause) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // 清不掉就留着：它带随机后缀，不会被下一次写覆盖，也不该盖掉本次真正的失败原因。
    }
    return { ok: false, reason: cause instanceof Error ? cause.message : "写入失败" };
  }
}
