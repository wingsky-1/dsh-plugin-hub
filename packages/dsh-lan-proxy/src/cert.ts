// dsh-lan-proxy — TLS 证书准备。
//
// 两级证书来源，按配置优先：
//   1. 用户提供的 PEM 文件（tlsCertFile / tlsKeyFile）——正式证书、
//      mkcert 本地 CA 证书等，由 loadTlsFromFiles 读取；
//   2. 自动生成的自签名证书——用 selfsigned（构建期内联进产物，
//      运行时零依赖）生成（rsa:2048 / sha256 / 有效期 825 天），
//      缓存到 <DSH_HOME>/lan-proxy/，幂等复用：证书存在且 24 小时内
//      不过期则直接复用，否则重新生成。
//   过期判定用 node:crypto 的 X509Certificate 解析 validToDate，
//   不再依赖宿主机 openssl 子进程（issue #9）。
//
// 自签名证书带 subjectAltName（localhost / 127.0.0.1 / ::1 / 调用方传入的
// 本机局域网 IP）：Chrome 59+ 对缺失 SAN 的证书直接拒绝（无法"继续访问"），
// 有 SAN 的自签证书至少允许用户显式信任后进入。
import { X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isIP } from "node:net";
import { generate as generateSelfSigned } from "selfsigned";
import type { TlsMaterials } from "./proxy.js";

/** 自签证书缓存文件名（目录由调用方决定，默认 <DSH_HOME>/lan-proxy）。 */
export const SELF_SIGNED_KEY = "dsh-lan-proxy-key.pem";
export const SELF_SIGNED_CERT = "dsh-lan-proxy-cert.pem";

/** 自签证书有效期（天）。825 ≈ 2.25 年，浏览器信任窗口友好。 */
const CERT_DAYS = 825;
/** 剩余有效期低于该秒数视为即将过期，需要重签（24 小时）。 */
const MIN_REMAINING_SECONDS = 86400;

/** selfsigned subjectAltName 条目（type 7 = IP 字面量，type 2 = DNS 名）。 */
export interface SanAltName {
  type: 2 | 7;
  value?: string;
  ip?: string;
}

/** 默认 SAN：回环访问（本机 https://localhost:3443 测试）。 */
const DEFAULT_SANS: SanAltName[] = [
  { type: 7, ip: "127.0.0.1" },
  { type: 2, value: "localhost" },
  { type: 7, ip: "::1" },
];

/** 把主机名/IP 编码为 selfsigned SAN 条目（IP 字面量走 ip 字段，其余走 DNS value）。 */
export function toSanEntry(host: string): SanAltName {
  if (host === "localhost") return { type: 2, value: "localhost" };
  return isIP(host) !== 0 ? { type: 7, ip: host } : { type: 2, value: host };
}

/** 读取用户提供的 PEM 证书与私钥文件。 */
export function loadTlsFromFiles(certFile: string, keyFile: string): TlsMaterials {
  if (!existsSync(certFile)) throw new Error(`TLS cert file not found: ${certFile}`);
  if (!existsSync(keyFile)) throw new Error(`TLS key file not found: ${keyFile}`);
  return { cert: readFileSync(certFile), key: readFileSync(keyFile) };
}

/** ensureSelfSignedTls 选项。 */
export interface SelfSignedOptions {
  /** 证书缓存目录（自动创建）。 */
  dir: string;
  /** 额外加入 SAN 的主机名/局域网 IP（如本机全部非回环 IPv4）。 */
  extraSans?: string[];
}

/** 证书是否仍然有效（存在、可解析、剩余有效期 > 24 小时）。 */
export function certStillValid(certPath: string): boolean {
  try {
    const cert = new X509Certificate(readFileSync(certPath));
    return cert.validToDate.getTime() - Date.now() > MIN_REMAINING_SECONDS * 1000;
  } catch {
    return false;
  }
}

/**
 * 幂等获取自签名证书材料：缓存目录里已有未过期证书则直接复用，
 * 否则用 selfsigned 生成（rsa:2048 / sha256 / 825 天 / 带 SAN）并落盘缓存。
 * 生成失败时抛错（调用方降级为 HTTP-only）。
 */
export function ensureSelfSignedTls(options: SelfSignedOptions): TlsMaterials {
  const keyPath = join(options.dir, SELF_SIGNED_KEY);
  const certPath = join(options.dir, SELF_SIGNED_CERT);
  if (existsSync(certPath) && existsSync(keyPath) && certStillValid(certPath)) {
    // 私钥权限收敛 0600（历史缓存可能受 umask 影响过宽）
    chmodSync(keyPath, 0o600);
    return { cert: readFileSync(certPath), key: readFileSync(keyPath) };
  }
  mkdirSync(options.dir, { recursive: true });
  const sans = [...DEFAULT_SANS, ...(options.extraSans ?? []).map(toSanEntry)];
  let pem: { private: string; cert: string };
  try {
    pem = generateSelfSigned([{ name: "commonName", value: "dsh-lan-proxy" }], {
      keySize: 2048,
      algorithm: "sha256",
      days: CERT_DAYS,
      extensions: [{ name: "subjectAltName", altNames: sans }],
    });
  } catch (err) {
    throw new Error(`self-signed cert generation failed: ${(err as Error).message}`);
  }
  writeFileSync(keyPath, pem.private, { mode: 0o600 });
  writeFileSync(certPath, pem.cert);
  // 显式收敛私钥权限 0600（writeFileSync mode 受 umask 影响可能过宽）
  chmodSync(keyPath, 0o600);
  return { cert: readFileSync(certPath), key: readFileSync(keyPath) };
}
