/**
 * dsh-jev-decide — 客户端文案绑定（零依赖纯函数，可被 node 单测直测）。
 *
 * 语言判定：浏览器 locale 以 zh 开头即中文，其余英文（含缺 navigator 的 node 环境
 * 回落英文——与 JEV 英文问答更擅长一致）。单测经 setLang 锁定语言。
 */
import { en, zh } from "./locales.ts";

export type JevLocale = "zh" | "en";
export type JevTextKey = keyof typeof zh;

let current: JevLocale = resolveLang();

/** 解析当前语言（浏览器 zh 开头即 zh，否则 en）。 */
export function resolveLang(): JevLocale {
  try {
    const nav = (globalThis as unknown as { navigator?: { language?: unknown } }).navigator;
    const lang = nav?.language;
    if (typeof lang === "string" && lang.toLowerCase().startsWith("zh")) return "zh";
  } catch {
    /* 忽略 */
  }
  return "en";
}

/** 锁定语言（单测用；正常渲染走模块加载期解析）。 */
export function setLang(next: JevLocale): void {
  current = next;
}

/** 当前语言。 */
export function lang(): JevLocale {
  return current;
}

/** 取文案（key 即 zh 源；缺 key 永不发生——en 由 Record<keyof typeof zh> 锁死）。
 * 支持 {n} 数字插值（中英语序不同，禁止空串 key 占位）。 */
export function t(key: JevTextKey, params?: { readonly n?: number }): string {
  const raw = current === "zh" ? zh[key] : en[key];
  if (params?.n === undefined) return raw;
  return raw.replaceAll("{n}", String(params.n));
}
