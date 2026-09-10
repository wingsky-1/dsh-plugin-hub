/**
 * dsh-notifier — 配置域：路径函数（node 依赖面）。
 *
 * 落盘路径（configFile/historyFile/statusFile）统一经 DSH home 解析——官方
 * settings 存储已随 DSH_HOME 隔离，插件 history/status 落盘也必须随隔离 home
 * 走，否则读写两面都串到真实 ~/.dsh；DSH home 语义由
 * shared/dsh-home.js 单一事实源承载。
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dshHome as sharedDshHome } from "../../../../shared/dsh-home.js";

/**
 * DSH home 基目录：薄 facade，语义由 shared/dsh-home.js
 * 单一事实源承载（非空 env 原样采用、未设置或空串回落 ~/.dsh）。
 */
function dshHome(): string {
  return sharedDshHome();
}

/**
 * 配置存储路径（旧版自建 json；现仅作存量迁移源，不再读写）。
 * 路径同样随 DSH_HOME：隔离环境的迁移源读隔离 home 下的旧配置，
 * 不触碰真实 `~/.dsh`；只读迁移语义不变。
 */
export function configFile() {
  return join(dshHome(), "dsh-notifier.json");
}

/** 通知历史文件路径（jsonl 追加；与配置同目录；DSH_HOME 感知）。 */
export function historyFile() {
  return join(dshHome(), "dsh-notifier-history.jsonl");
}

/** 频道投递状态文件路径（per-channel 最近投递终态；与配置同目录；DSH_HOME 感知）。 */
export function statusFile() {
  return join(dshHome(), "dsh-notifier-status.json");
}

/** SSE seq 计数器持久化文件路径（服务端重启续计数；与
 *  statusFile 同目录同命名风格；DSH_HOME 感知同纪律——隔离 home 的
 *  seq 文件不被真实 ~/.dsh 污染）。 */
export function seqFile() {
  return join(dshHome(), "notifier-seq.json");
}

/** toast 脚本路径（本插件 lib 下）。 */
export function toastScriptPath() {
  return join(dirname(fileURLToPath(import.meta.url)), "toast.ps1");
}