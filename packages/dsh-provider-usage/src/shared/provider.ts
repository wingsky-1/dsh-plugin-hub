/**
 * dsh-provider-usage — src/shared 跨端 provider 名叶子（#768 A波7）。
 *
 * OPENCODE_GO_PROVIDER 字符串的 canonical 落点（由
 * server/adapters/opencode-go.mjs:24 纯下沉，字面量逐字一致，零副作用）。
 * 跨端理由：src/shared/config.ts（DEFAULT_CONFIG/provider 缺省 + Config schema）
 * 被服务端与客户端双消费，字符串置跨端 shared 后两端同源；adapters 域改从本文件取，
 * 扶正「域→共享」方向（消除 shared|server/adapters 反向值边）。
 * 目录外经 src/shared/interface.ts 消费，旧址保留 re-export 门面。
 */

/** 内置适配器的 provider 名（如 "opencode-go"）。 */
export const OPENCODE_GO_PROVIDER = "opencode-go";
