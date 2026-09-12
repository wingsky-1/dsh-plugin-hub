/**
 * dsh-notifier pipeline 域 —— 路由块：这条通知该发给谁。
 *
 * 本块把设置翻译成**一组目标**：不投递、不落盘、不问该不该发。判据全部来自设置，
 * 因此它是纯的——同一份设置与同一个 kind 永远得到同一组目标。
 *
 * 未实现时返回空清单（= 没有可用出口），而不是抛错：理由同裁决块，本块挂在一条
 * 活的调用链上。
 *
 * 依赖方向：只引用本目录与 `../../deps.ts`，不引用 `interface.ts`。
 */
import type { EffectiveConfig } from "../../deps.ts";
import type { NotifyKind } from "../service/type.ts";
import type { RouteDeps, RoutedTarget } from "./type.ts";

/**
 * 路由：按 kind 与设置选出本次要投递的目标。
 *
 * 未实现。待填的四路出口：
 *
 * - 出站频道：`channels` 里 `enabled` 的实例，按 `kindRoutes[kind]` 收窄（缺省广播
 *   全部启用频道），bark 的紧急度取 `levels[kind]` 命中值、回落 `level`；
 * - webhook 凭据：配置存的是「认证方式 + 分散的凭据字段」，投递要的是「已解析的
 *   凭据对象」，转换在这一步完成——投递域不回显凭据、也不做掩码往返；
 * - 浏览器出口：`browserNotify` 开着时给一个 browser 目标，`pop` 由 `notifyWhenVisible`
 *   与页面可见性共同决定，铃声取 `browserSound`；
 * - 系统出口：`systemNotify` 开着时给一个 system 目标，铃声取 `systemSound`。
 *
 * 系统通知脚本的路径不在这里选：它由包内共享层按平台推导，同一进程内恒定，做成
 * 装配入参只会让每个装配点都知道本包的文件叫什么。
 */
export function routeTargets(deps: RouteDeps, config: EffectiveConfig, kind: NotifyKind): RoutedTarget[] {
  void deps;
  void config;
  void kind;
  return [];
}
