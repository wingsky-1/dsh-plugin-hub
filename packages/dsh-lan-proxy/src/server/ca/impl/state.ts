/**
 * dsh-lan-proxy — ca 域证书三态判定（#930 F7）。
 *
 * 真值表（用户层三键组合 × 文件存在性；health.caState 单一来源，客户端只渲染
 * 不判定——两端各写一份即重复逻辑，判定只活此处）：
 *
 * | 三键组合 | 文件存在性 | state |
 * |---|---|---|
 * | 全空 | — | self-signed |
 * | 全非空 + 路径均在 certs/ 界内 | realpath 均落界内 | managed |
 * | 全非空 + 路径均在 certs/ 界内 | 任一缺失/链出 | error（托管文件缺失） |
 * | 全非空 + 任一路径在界外 | — | custom |
 * | 叶对完整 + CA 缺席 + 任一叶路径在界外 | — | custom（自定义孤叶子） |
 * | 叶对完整 + CA 缺席 + 叶路径均在界内 | — | error（托管脱钩） |
 * | 仅 CA 非空（孤 CA 下载态） | — | error（半套，fail-closed） |
 * | 叶对单侧（cert/key 恰一非空） | — | error（半套） |
 *
 * “托管”（F7 定义）= 三键均非空且 realpath 均指向 certsDir()/；isManaged(p)
 * 取 F17 字面口径（realpath 双侧收敛 + sep 边界，缺文件/链出即 false）。
 * 界内判定另有一层纯字符串前缀（pathInCertsDir）：realpath 需文件存在，
 * “路径在界内但文件缺失”必须能与“路径本就不在界内”区分，否则托管缺文件
 * 会误判 custom——前者是 error（可恢复：清键回自签重建），后者是 custom
 * （用户资产，本域不动）。
 */
import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { certsDir } from "../../shared/interface.ts";

/** 证书配置态（health.caState 单一来源）。 */
export type CaState = "self-signed" | "managed" | "custom" | "error";

/** classifyCaState 入参（调用方传 resolve() 三键现值，本域不读配置存储）。 */
export interface CaStateInput {
  tlsCaCertFile?: string;
  tlsCertFile?: string;
  tlsKeyFile?: string;
}

/** 非空字符串判定（空串视为未配置，与 sanitizeSettings 清除语义同口径）。 */
function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** 纯字符串界内判定（不碰 FS：区分“界内缺文件”与“本就不在界内”）。 */
function pathInCertsDir(candidate: string): boolean {
  const dir = resolve(certsDir());
  return resolve(candidate).startsWith(dir + sep);
}

/**
 * 托管路径判定（#930 F17 字面口径）：realpath(candidate) 落在
 * realpath(certsDir()) 内。文件缺失/链出即 false（fail-closed）。
 */
export function isManagedPath(candidate: string): boolean {
  try {
    const dir = realpathSync(certsDir());
    return realpathSync(candidate).startsWith(dir + sep);
  } catch {
    return false;
  }
}

/**
 * 证书三态分类（#930 F7 真值表；F17 生成门控与 health.caState 同源）。
 * 自签/托管可一键动作；custom（用户资产）与 error（半套/缺文件）由动作端
 * 409 拒绝并指引（fail-closed，不自动改写用户文件）。
 */
export function classifyCaState(input: CaStateInput): CaState {
  const ca = nonEmpty(input.tlsCaCertFile) ? input.tlsCaCertFile : undefined;
  const cert = nonEmpty(input.tlsCertFile) ? input.tlsCertFile : undefined;
  const key = nonEmpty(input.tlsKeyFile) ? input.tlsKeyFile : undefined;
  if (ca === undefined && cert === undefined && key === undefined) return "self-signed";
  if (ca !== undefined && cert !== undefined && key !== undefined) {
    if (!pathInCertsDir(ca) || !pathInCertsDir(cert) || !pathInCertsDir(key)) return "custom";
    // 界内路径：realpath 全落界内即托管，任一失败即托管文件缺失/链出 → error。
    if (isManagedPath(ca) && isManagedPath(cert) && isManagedPath(key)) return "managed";
    return "error";
  }
  if (ca === undefined && cert !== undefined && key !== undefined) {
    // 叶对完整而 CA 缺席：叶路径任一在界外即自定义孤叶子（custom）；
    // 叶路径均在界内即托管脱钩（scope 与磁盘不一致，error 指引清键重建）。
    if (!pathInCertsDir(cert) || !pathInCertsDir(key)) return "custom";
    return "error";
  }
  // 孤 CA 与叶对单侧均为半套：error。
  return "error";
}
