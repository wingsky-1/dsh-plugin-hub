/**
 * TLS 域对外承诺：证书材料形状与两类证书来源。
 *
 * 独立于转发引擎——cert 回答「用哪份证书、何时重签」，引擎回答「流量如何转发」，
 * 两者无共享代码路径；引擎只消费本域产出的 TlsMaterials。
 */
export type { TlsMaterials } from "./impl/index.ts";
export {
  SELF_SIGNED_CERT,
  SELF_SIGNED_KEY,
  certStillValid,
  ensureSelfSignedTls,
  loadTlsFromFiles,
  toSanEntry,
} from "./impl/index.ts";
