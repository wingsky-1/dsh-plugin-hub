/**
 * 执行期身份解析：从 `exec` 取会话身份与工作目录。
 *
 * `exec.agent` 在类型上是可选的（子派发、非 agent 调用都没有它），所以这里返回
 * `undefined` 而不是抛错；调用方必须把它翻成一句明确的失败，而不是回落到 `process.cwd()`
 * ——后者会把绑定挂到一个与调用者无关的目录上。
 */
export interface SessionFace {
  readonly id: string;
  readonly cwd: string | undefined;
  /**
   * 会话 header 的创建时间。登记要把它一起落盘：id 是进程内计数器，重启后会被新会话复用，
   * 没有它就分不清「同一个会话」与「另一个会话拿到了同一个 id」。
   */
  readonly createdAt: number | undefined;
}

/** 解析会话身份。形状不符即 undefined，不猜。 */
export function sessionOf(exec: unknown): SessionFace | undefined {
  const session = readObject(readObject(exec, "agent"), "session");
  if (session === undefined) return undefined;
  const id = readField(session, "id");
  if (typeof id !== "string" || id.length === 0) return undefined;
  const header = readObject(session, "header");
  return {
    id,
    cwd: nonEmptyTextOrUndefined(readField(header, "cwd")),
    createdAt: finiteNumberOrUndefined(readField(header, "createdAt")),
  };
}

function readObject(source: unknown, key: string): unknown {
  if (typeof source !== "object" || source === null) return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "object" && value !== null ? value : undefined;
}

/** 读一层字段（容器不是对象即 undefined，不抛）。容器判定的断言只在本模块 readRecord 一处出现。 */
function readField(source: unknown, key: string): unknown {
  if (typeof source !== "object" || source === null) return undefined;
  return (source as Record<string, unknown>)[key];
}

/** 非空文本，否则 undefined（空串与缺失在「工作目录」这件事上是同一件事）。 */
function nonEmptyTextOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** 有限数字，否则 undefined（NaN / Infinity 不是可登记的创建时间）。 */
function finiteNumberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
