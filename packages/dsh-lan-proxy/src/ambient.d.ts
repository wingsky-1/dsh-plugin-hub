/**
 * @deepseek-ai/dsh-settings 的本地最小类型声明。
 *
 * 该包由宿主 dsh 运行时提供（可选服务），不在本仓库依赖中；
 * 动态 import 解析失败时插件降级 warn（GUI 设置面板不可用，功能不受影响）。
 * 声明仅覆盖 dsh-lan-proxy 实际使用的调用面（installSettingsSection /
 * settingsNamespace），签名宽松（unknown 兜底）。
 */
declare module "@deepseek-ai/dsh-settings" {
  export interface SettingsHooks {
    setSource(source: (() => Record<string, unknown>) | Record<string, unknown>): void;
    onChange(): void;
  }
  export function installSettingsSection(
    ctx: unknown,
    namespace: unknown,
    configSchema: unknown,
    config: unknown,
    hooks: SettingsHooks
  ): void;
  export function settingsNamespace(name: string): unknown;
}
