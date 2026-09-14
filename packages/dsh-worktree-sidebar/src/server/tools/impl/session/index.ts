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
}

/** 解析会话身份。形状不符即 undefined，不猜。 */
export function sessionOf(exec: unknown): SessionFace | undefined {
  if (typeof exec !== "object" || exec === null) return undefined;
  const session = readObject(readObject(exec, "agent"), "session");
  if (session === undefined) return undefined;
  const id = (session as { id?: unknown }).id;
  if (typeof id !== "string" || id.length === 0) return undefined;
  const header = readObject(session, "header");
  const cwd = header === undefined ? undefined : (header as { cwd?: unknown }).cwd;
  return { id, cwd: typeof cwd === "string" && cwd.length > 0 ? cwd : undefined };
}

function readObject(source: unknown, key: string): unknown {
  if (typeof source !== "object" || source === null) return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "object" && value !== null ? value : undefined;
}
