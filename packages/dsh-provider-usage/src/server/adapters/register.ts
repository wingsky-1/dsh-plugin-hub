/**
 * dsh-provider-usage — 内置适配器 fail-fast 装配（server/adapters 域实现）。
 *
 * 三内置 .mjs 以 .d.mts 声明层静态声称 v2 契约，但 .mjs 运行时无类型——
 * 声明层与实现分叉（或实现被改坏）时，裸调 registry.register 会返回 false
 * 而调用方若忽略返回值，缺失的内置将静默为“无候选”，远处才现形。
 * 本函数把“内置拒收”收敛为启动期抛错：任一返回 false 即抛，
 * 诊断（含形状明细）已由注册表经 diag 通道出声，此处只点名。
 */
import type { UsageStatsAdapter } from "../../shared/interface.ts";
import type { BuiltinRegistryPort } from "./deps.ts";

/** 逐个注册内置适配器；任一被拒收即抛错（fail-fast，不静默缺失）。 */
export function registerBuiltinAdapters(
  port: BuiltinRegistryPort,
  adapters: readonly UsageStatsAdapter[],
): void {
  let index = 0;
  for (const adapter of adapters) {
    if (!port.register(adapter, "builtin")) {
      throw new Error(
        `[dsh-provider-usage] 内置适配器契约校验失败，已拒收并拒绝启动：${adapter.name}（序号 ${index}）`,
      );
    }
    index += 1;
  }
}
