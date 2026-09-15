/**
 * dsh-notifier — 客户端判据共用的测试支撑（支撑模块：不入任何层、不计 --min）。
 *
 * 为什么单开一个文件而不是上提 test/helpers.ts：那份是包级夹具（宿主/服务端面），这段替身只服务
 * 客户端判据——支撑面越长，改它要读的文件越多（.dsh/skills/dsh-plugin-hub-testing §3）。
 * 为什么值得共用：它编码的是**宿主 locale 服务的契约**（key 查不到就回落 key 本体、`{name}` 插值），
 * 不是某个用例的局部意图。两处各写一份时，一边改了插值语义，另一边就悄悄在测另一个东西。
 */
import type { NotifierLocaleKey } from "../src/client/locales.ts";
import { zh } from "../src/client/locales.ts";

/** 官方向翻译函数的最薄替身：`{name}` 插值 zh 字典（省略的只有 locale 服务的注册面）。 */
export function translateWithZh(
  key: NotifierLocaleKey,
  params?: Readonly<Record<string, string | number>>,
): string {
  return zh[key].replace(/\{(\w+)\}/gu, (match, name: string) =>
    params !== undefined && Object.prototype.hasOwnProperty.call(params, name)
      ? String(params[name])
      : match,
  );
}
