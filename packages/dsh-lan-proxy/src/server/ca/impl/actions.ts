/**
 * dsh-lan-proxy — ca 域一键动作（#930 Phase 2 POST 路由装配与编排）。
 *
 * 单路由 POST（路径由装配层经 deps.path 注入，见 ROUTES.caGenerate）：
 * 自签态首建（CA+叶子）/ 托管态轮换（默认仅叶子，CA 续用；rotateCa:true 才换
 * CA）。custom（用户资产）与 error（半套/缺文件）一律 409 fail-closed。
 *
 * 写顺序（F3 原子写）：temp 落盘 → scope.update 成功 → rename（旧目标先搬
 * .bak，成功后 prune 只留最近 1 个 .bak）。跨目标非原子故带补偿（P1-1）：
 * 第 N 个目标失败时已提交目标（含失败目标自己的 .bak）按逆序搬回。scope
 * 先行、rename 在后：补偿亦失败时 scope 指向缺失/旧文件，三态谓词如实报
 * error/managed（口径诚实，不静默）。响应永不带路径（F19），原文只进日志。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ServerResponse } from "node:http";
import {
  errorMessage,
  guardLoopbackMethod,
  readJsonBodyOutcome,
  writeJson,
} from "../../../../../../shared/host-utils.js";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import type { ResolvedConfig } from "../../config/interface.ts";
import type { CaState } from "./state.ts";
import {
  CA_CERT_FILE,
  CA_KEY_FILE,
  LEAF_CERT_FILE,
  LEAF_KEY_FILE,
  certsDir,
} from "../../shared/interface.ts";
import type { CaActionDeps, CaFsPort } from "../deps.ts";
import { classifyCaState } from "./state.ts";

/** POST body 读形态（未知键忽略；确认与轮换意向只认 true）。 */
export interface CaPostBody {
  confirmed?: unknown;
  expectedRevision?: unknown;
  rotateCa?: unknown;
}

/** 解析后动作意图（expectedRevision 非整数即缺席，不抛错）。 */
interface ParsedPostBody {
  confirmed: boolean;
  rotateCa: boolean;
  expectedRevision: number | undefined;
}

/** 动作成功回执（mode 供排障区分首建/叶轮换/CA 轮换；客户端重 fetch 为准）。 */
export type CaActionResult =
  | { ok: true; mode: "generated" }
  | { ok: true; mode: "leaf-rotated" }
  | { ok: true; mode: "ca-rotated" };

/** 动作失败码（F19 码表；路径永不进响应）。 */
const CA_ERROR_DETAILS: Record<string, string> = {
  "needs-confirm":
    "目标位置已存在证书材料：请确认后重试（confirmed:true）。默认仅轮换叶子（CA 续用，已装设备零操作）；轮换 CA 为危险动作，需显式指定 rotateCa:true。",
  "ca-generating": "正在生成中，请稍后重试",
  "ca-customized": "当前为自定义证书配置，一键生成已禁用（仅自签与托管态可用）",
  "ca-misconfigured":
    "证书配置异常（三键不完整或托管文件缺失）：清空三键回自签后重建，或恢复缺失文件",
  "ca-generate-failed": "生成失败，请查看服务端日志",
  "ca-revision-stale": "配置版本未知，请刷新后重试",
  conflict: "设置已被其他窗口修改，请刷新后重试",
  "settings-unavailable": "settings 服务不可用，无法保存配置",
};

/** 托管四件套的绝对路径（每次现读：certsDir 随 DSH_HOME 变，装配期快照会跨账号串味）。 */
interface ManagedPaths {
  readonly caCert: string;
  readonly caKey: string;
  readonly leafCert: string;
  readonly leafKey: string;
}

/** 托管四件套绝对路径（固定文件名 + certsDir，见 shared/paths.ts F18）。 */
function managedPaths(): ManagedPaths {
  const dir = certsDir();
  return {
    caCert: join(dir, CA_CERT_FILE),
    caKey: join(dir, CA_KEY_FILE),
    leafCert: join(dir, LEAF_CERT_FILE),
    leafKey: join(dir, LEAF_KEY_FILE),
  };
}

/** 解析 POST body（缺席即 {}；畸形由调用方先行 400，本函数只做形态收窄）。 */
function parsePostBody(body: Record<string, unknown>): ParsedPostBody {
  return {
    confirmed: body.confirmed === true,
    rotateCa: body.rotateCa === true,
    expectedRevision:
      typeof body.expectedRevision === "number" && Number.isInteger(body.expectedRevision)
        ? body.expectedRevision
        : undefined,
  };
}

/** 进程内 singleflight（F4：第二请求 429，按钮侧复用 inFlight disabled）。 */
class GenerationGate {
  private held = false;
  tryAcquire(): boolean {
    if (this.held) return false;
    this.held = true;
    return true;
  }
  release(): void {
    this.held = false;
  }
}

/** 目标同目录 temp 路径（同文件系统 rename 才原子；单 flight 下固定名无碰撞）。 */
function tempPath(target: string): string {
  return target + ".tmp";
}

/** 写 temp（0600 + chmodSync 双保险，见 F13/F14；残留旧 temp 先清）。 */
function writeTempFile(target: string, content: string): void {
  const tmp = tempPath(target);
  try {
    unlinkSync(tmp);
  } catch {
    // 无残留即空操作。
  }
  writeFileSync(tmp, content, { mode: 0o600 });
  chmodSync(tmp, 0o600);
}

/** 清 temp（失败路径收尾；best effort）。 */
function cleanupTempFile(target: string): void {
  try {
    unlinkSync(tempPath(target));
  } catch {
    // 本就无文件即成功。
  }
}

/** 已提交目标（补偿回滚按逆序用各自 .bak 搬回）。 */
interface CommittedTarget {
  target: string;
  backup: string | undefined;
}

/**
 * 提交单个目标：旧文件搬时间戳 .bak → temp 原子 rename 上位（rename 走注入接缝）。
 * 本函数只登记不回滚：调用方在跨目标循环外统一补偿（含本目标自己的 .bak——
 * 登记先于风险 rename，失败时登记项已在表内）。调用方另清 temp。
 */
function commitTarget(
  fs: CaFsPort,
  logWarn: (message: string) => void,
  target: string,
  stamp: string,
  done: CommittedTarget[],
): void {
  const tmp = tempPath(target);
  let backup: string | undefined;
  if (existsSync(target)) {
    backup = target + "." + stamp + ".bak";
    fs.renameSync(target, backup);
  }
  done.push({ target, backup });
  fs.renameSync(tmp, target);
  pruneBackups(target, fs, logWarn);
}

/**
 * .bak 只留最近 1 个（F10：按时间戳后缀降序保留首个；.migrated.bak 系另名不沾）。
 * 清理失败只记日志（提交已成功，不因此 500）。
 */
function pruneBackups(target: string, fs: CaFsPort, logWarn: (message: string) => void): void {
  const dir = dirname(target);
  const base = basename(target);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    logWarn("lan-proxy: 备份目录读取失败（" + dir + ")— " + errorMessage(err));
    return;
  }
  const owned = names
    .filter((name) => name.startsWith(base + ".") && name.endsWith(".bak"))
    .sort()
    .reverse();
  for (const extra of owned.slice(1)) {
    try {
      fs.unlinkSync(join(dir, extra));
    } catch (err) {
      logWarn("lan-proxy: 旧证书备份清理失败（" + extra + ")— " + errorMessage(err));
    }
  }
}

/** 失败码写回（固定文案，路径不进响应）。 */
function writeCaError(res: ServerResponse, status: number, code: string): void {
  writeJson(res, status, { ok: false, error: { code, details: CA_ERROR_DETAILS[code] } });
}

/**
 * 组装一键 CA 动作路由（POST 只写；loopback 围栏 + POST 白名单；body 经
 * readJsonBodyOutcome 解析 {confirmed?, expectedRevision?, rotateCa?}）。
 * 导出供 apply 装配与单测（fake deps，不依赖网络）。
 */
export function buildCaActionRoutes(deps: CaActionDeps): WebRoute[] {
  const gate = new GenerationGate();
  const actionRoute: WebRoute = {
    kind: "exact",
    path: deps.path,
    handler: async (req, res) => {
      if (!guardLoopbackMethod(req, res, ["POST"])) return;
      const parsed = await readCaPostBody(req, res);
      if (parsed === undefined) return;
      const current = deps.config.resolve();
      // 放行判定：设置面、乐观并发、证书态势三道都在这里出结论（见 caPrecheck）。
      const pre = caPrecheck(deps, parsed, current);
      if (!pre.ok) {
        writeCaError(res, pre.status, pre.code);
        return;
      }
      const expectedRevision = pre.expectedRevision;
      const state = pre.state;
      const paths = managedPaths();
      const full = caFullOf(state, parsed.rotateCa);
      const rotateTargets = caRotateTargetsOf(full, paths);
      if (caNeedsConfirm(state, rotateTargets) && !parsed.confirmed) {
        writeCaError(res, 409, "needs-confirm");
        return;
      }
      if (!gate.tryAcquire()) {
        writeCaError(res, 429, "ca-generating");
        return;
      }
      try {
        await runCaAction(deps, {
          full,
          rotateTargets,
          paths,
          expectedRevision,
        });
      } catch (err) {
        const code = (err as { code?: unknown })?.code;
        if (code === "SETTINGS_CONFLICT") {
          cleanupTempFiles(rotateTargets);
          writeCaError(res, 409, "conflict");
          return;
        }
        cleanupTempFiles(rotateTargets);
        deps.logWarn("lan-proxy: 一键 CA 动作失败 — " + errorMessage(err));
        writeCaError(res, 500, "ca-generate-failed");
        return;
      } finally {
        gate.release();
      }
      writeJson(res, 200, caResultOf(state, full));
    },
  };
  return [actionRoute];
}

/**
 * 本轮是「建全套 / 轮换 CA」还是「只轮换叶子」：自签态恒建全套（没有 CA 可续用，
 * rotateCa 对它无意义）；托管态听调用方的 rotateCa。
 */
function caFullOf(state: CaState, rotateCa: boolean): boolean {
  return state === "self-signed" ? true : rotateCa;
}

/** 本轮要轮换的目标文件：全套（CA 两件 + 叶子两件）或只换叶子两件。 */
function caRotateTargetsOf(full: boolean, paths: ManagedPaths): string[] {
  return full
    ? [paths.caCert, paths.caKey, paths.leafCert, paths.leafKey]
    : [paths.leafCert, paths.leafKey];
}

/**
 * 读体 → 收窄 → 解析：body 非法即就地 400 并返回 undefined（handler 见到 undefined 即结束）。
 *
 * 「体读不出来」与「体读出来但字段不对」是两级判据，混在 handler 里时 handler 前 20 行都在
 * 处理入参、真正的动作编排被推到看不见的地方。
 */
async function readCaPostBody(
  req: Parameters<NonNullable<WebRoute["handler"]>>[0],
  res: ServerResponse,
): Promise<ParsedPostBody | undefined> {
  const outcome = await readJsonBodyOutcome(req, 64 * 1024);
  if (outcome.kind === "invalid") {
    writeJson(res, 400, {
      ok: false,
      error: { code: "invalid-json", details: "invalid JSON body: " + outcome.reason },
    });
    return undefined;
  }
  // JSON 体边界收窄：reader 只承诺 object，字段读取走 Record 视图（数组体各字段即缺席）。
  const rawBody: Record<string, unknown> =
    outcome.kind === "json" ? (outcome.value as Record<string, unknown>) : {};
  return parsePostBody(rawBody);
}

/** 失败补偿：把本轮已动过的目标逐个撤回来（两条 catch 分支共用，故收一处）。 */
function cleanupTempFiles(targets: readonly string[]): void {
  for (const target of targets) cleanupTempFile(target);
}

/**
 * 放行预检的结论：拒绝侧带状态码与错误码（handler 就地 4xx 出去，不抛）；
 * 放行侧带**收窄后**的 expectedRevision 与证书态势（handler 直接用，不必再判一次）。
 */
type CaPrecheck =
  | { readonly ok: true; readonly expectedRevision: number; readonly state: CaState }
  | { readonly ok: false; readonly status: number; readonly code: string };

/**
 * 三道门：设置面在不在、并发基线在不在、证书态势允许不允许动。三者是三类不同的事实，
 * 混在 handler 里时，读代码要一路数到第四个 writeCaError 才看得清「还有没有别的门」。
 */
function caPrecheck(
  deps: CaActionDeps,
  parsed: ParsedPostBody,
  current: ResolvedConfig,
): CaPrecheck {
  if (!deps.config.writable()) {
    return { ok: false, status: 503, code: "settings-unavailable" };
  }
  // P2-4：expectedRevision 缺席即 409（禁 last-write-wins 静默覆盖；
  // 调用方刷新拿新 revision 后重试，文案复用 conflict）。
  if (parsed.expectedRevision === undefined) {
    return { ok: false, status: 409, code: "ca-revision-stale" };
  }
  const state = classifyCaState({
    tlsCaCertFile: current.tlsCaCertFile,
    tlsCertFile: current.tlsCertFile,
    tlsKeyFile: current.tlsKeyFile,
  });
  if (state === "custom") return { ok: false, status: 409, code: "ca-customized" };
  if (state === "error") return { ok: false, status: 409, code: "ca-misconfigured" };
  return { ok: true, expectedRevision: parsed.expectedRevision, state };
}

/**
 * 已存在即需确认（F16）：托管态恒需（轮换具破坏性）；自签态仅残留文件时需
 * （真正全新安装一键直达；残留覆盖走确认 + .bak 留痕）。
 */
function caNeedsConfirm(state: CaState, rotateTargets: readonly string[]): boolean {
  return state === "managed" ? true : rotateTargets.some((target) => existsSync(target));
}

/** 动作落定后的结论（自签态建全套、托管态轮换 CA 或只轮换叶子）。 */
function caResultOf(state: CaState, full: boolean): CaActionResult {
  if (state === "self-signed") return { ok: true, mode: "generated" };
  return { ok: true, mode: full ? "ca-rotated" : "leaf-rotated" };
}

/** runCaAction 入参（handler 内已校验态势，本函数只做生成→落盘→提交）。 */
interface CaRunInput {
  full: boolean;
  rotateTargets: string[];
  paths: { caCert: string; caKey: string; leafCert: string; leafKey: string };
  expectedRevision: number;
}

/**
 * 执行生成→落盘→提交（F3/F5/F10/F13/F14）：forge 回调式异步签发 → temp(0600)
 * → scope.update（三键同值刷新，首建新增）→ rename 上位（.bak+prune）。
 * 跨目标非原子故带补偿（P1-1）：第 N 个目标失败时已提交目标按逆序用各自
 * .bak 搬回（含失败目标自己的 .bak），搬回失败尽力 + 日志，不掩盖原错。
 * SETTINGS_CONFLICT 原样上抛（调用方映射 409）；其余异常上抛映射 500。
 */
async function runCaAction(deps: CaActionDeps, input: CaRunInput): Promise<void> {
  const dir = certsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // 既存目录权限收敛 0700（mkdir mode 只作用于新建；best-effort，失败不阻断，
  // 仿私钥 0600 write+chmod 双保险——P1-2）。
  try {
    chmodSync(dir, 0o700);
  } catch {
    // 历史宽松目录下次动作幂等收敛；收敛失败不阻断本次签发落盘。
  }
  const extraSans = deps.lanIps();
  // 待写对（目标与 PEM 同行构造：rotateTargets 即 jobs 的目标投影，无缺 PEM 的死角）。
  const jobs: Array<{ target: string; pem: string }> = [];
  if (input.full) {
    const full = await deps.crypto.generateFull(extraSans);
    jobs.push(
      { target: input.paths.caCert, pem: full.caCert },
      { target: input.paths.caKey, pem: full.caKey },
      { target: input.paths.leafCert, pem: full.leafCert },
      { target: input.paths.leafKey, pem: full.leafKey },
    );
  } else {
    // 仅换叶子：CA 公私钥从托管文件现读（state=managed 已保证存在；竞态缺失即抛→500）。
    const caCertPem = readFileSync(input.paths.caCert, "utf8");
    const caKeyPem = readFileSync(input.paths.caKey, "utf8");
    const leaf = await deps.crypto.generateLeaf(caCertPem, caKeyPem, extraSans);
    jobs.push(
      { target: input.paths.leafCert, pem: leaf.leafCert },
      { target: input.paths.leafKey, pem: leaf.leafKey },
    );
  }
  for (const job of jobs) writeTempFile(job.target, job.pem);
  await deps.config.update(
    {
      tlsCaCertFile: input.paths.caCert,
      tlsCertFile: input.paths.leafCert,
      tlsKeyFile: input.paths.leafKey,
    },
    input.expectedRevision,
  );
  // P2-5：每目标唯一时间戳（同毫秒多目标顺序提交时 .bak 名不互踩）。
  const stampBase = String(Date.now());
  const done: CommittedTarget[] = [];
  try {
    input.rotateTargets.forEach((target, index) => {
      commitTarget(deps.fs, deps.logWarn, target, stampBase + "-" + index, done);
    });
  } catch (err) {
    // R1：无 .bak 的已提交目标即本轮新文件，删之（best-effort+日志）；有 .bak 则搬回。
    for (const committed of [...done].reverse()) {
      try {
        if (committed.backup === undefined) deps.fs.unlinkSync(committed.target);
        else deps.fs.renameSync(committed.backup, committed.target);
      } catch (rollbackErr) {
        deps.logWarn(
          "lan-proxy: 一键 CA 回滚失败（" + committed.target + ")— " + errorMessage(rollbackErr),
        );
      }
    }
    throw err;
  }
}
