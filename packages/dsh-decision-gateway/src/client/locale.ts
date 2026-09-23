/**
 * dsh-decision-gateway — 客户端文案绑定（零依赖纯函数，可被 node 单测直测）。
 *
 * 语言判定：浏览器 locale 以 zh 开头即中文，其余英文（含缺 navigator 的 node 环境
 * 回落英文——与 JEV 英文问答更擅长一致）。单测经 setLang 锁定语言。
 *
 * 宿主 locale 服务（notifier 同款）：apply 期 register 字典 + bind 装配，订阅回调重绑，
 * 切语言免刷新跟随；未装配（旧运行时 / 单测直调）回落本地字典——界面照常渲染中文案。
 */
import { en, zh } from "./locales.ts";

export type DecisionLocale = "zh" | "en";
export type DecisionTextKey = keyof typeof zh;

/** 宿主装配的翻译函数（官方 ctx.locale.bind(ns) 产物；key 即本包字典键）。 */
export type HostTranslate = (key: string, params?: Record<string, unknown>) => string;

let current: DecisionLocale = resolveLang();
let bound: HostTranslate | null = null;

/** 装配 / 重绑宿主翻译函数（apply 期与 locale 订阅回调调用）。
 * 守住 bound 恒可调用：宿主异常实现可能返回非函数（命名空间未命中等），
 * 此时忽略装配、t() 回落本地字典（此前本地路径永不抛错，回归面见评审）。 */
export function bindTranslate(next: HostTranslate): void {
  if (typeof next !== "function") return;
  bound = next;
}

/** 摘除宿主绑定、回落本地字典（卸载 / 单测隔离用）。 */
export function unbindTranslate(): void {
  bound = null;
}

/** 解析当前语言（浏览器 zh 开头即 zh，否则 en）。 */
export function resolveLang(): DecisionLocale {
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
export function setLang(next: DecisionLocale): void {
  current = next;
}

/** 当前语言。 */
export function lang(): DecisionLocale {
  return current;
}

/** 取文案（key 即 zh 源；缺 key 永不发生——en 由 Record<keyof typeof zh> 锁死）。
 * 支持 {n} 数字插值（中英语序不同，禁止空串 key 占位）。 */
export function t(key: DecisionTextKey, params?: { readonly n?: number }): string {
  if (bound !== null) return bound(key, params === undefined ? undefined : { n: params.n });
  const raw = current === "zh" ? zh[key] : en[key];
  if (params?.n === undefined) return raw;
  return raw.replaceAll("{n}", String(params.n));
}
