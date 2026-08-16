// dsh-lan-proxy — TLS 证书准备（零运行时依赖）。
//
// 两级证书来源，按配置优先：
//   1. 用户提供的 PEM 文件（tlsCertFile / tlsKeyFile）——正式证书、
//      mkcert 本地 CA 证书等，由 loadTlsFromFiles 读取；
//   2. 自动生成的自签名证书——用系统 openssl 生成（有效期 825 天），
//      缓存到 <DSH_HOME>/lan-proxy/，幂等复用：证书存在且 24 小时内
//      不过期则直接复用，否则重新生成。
//
// 自签名证书带 subjectAltName（localhost / 127.0.0.1 / ::1 / 调用方传入的
// 本机局域网 IP）：Chrome 59+ 对缺失 SAN 的证书直接拒绝（无法"继续访问"），
// 有 SAN 的自签证书至少允许用户显式信任后进入。
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isIP } from "node:net";
import type { TlsMaterials } from "./proxy.js";

/** 自签证书缓存文件名（目录由调用方决定，默认 <DSH_HOME>/lan-proxy）。 */
export const SELF_SIGNED_KEY = "dsh-lan-proxy-key.pem";
export const SELF_SIGNED_CERT = "dsh-lan-proxy-cert.pem";

/** 自签证书有效期（天）。825 ≈ 2.25 年，浏览器信任窗口友好。 */
const CERT_DAYS = 825;
/** 剩余有效期低于该秒数视为即将过期，需要重签（24 小时）。 */
const MIN_REMAINING_SECONDS = 86400;

/** 默认 SAN：回环访问（本机 https://localhost:3443 测试）。 */
const DEFAULT_SANS = ["IP:127.0.0.1", "DNS:localhost", "IP:::1"];

/** 把主机名/IP 编码为 openssl SAN 条目（IP 字面量用 IP: 前缀，其余用 DNS:）。 */
export function toSanEntry(host: string): string {
  if (host === "localhost") return "DNS:localhost";
  return isIP(host) !== 0 ? `IP:${host}` : `DNS:${host}`;
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
    execFileSync("openssl", ["x509", "-in", certPath, "-noout", "-checkend", String(MIN_REMAINING_SECONDS)], {
      stdio: "ignore",
      timeout: 10000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 幂等获取自签名证书材料：缓存目录里已有未过期证书则直接复用，
 * 否则用 openssl 生成（rsa:2048 / sha256 / 825 天 / 带 SAN）。
 * openssl 不可用或生成失败时抛错（调用方降级为 HTTP-only）。
 */
export function ensureSelfSignedTls(options: SelfSignedOptions): TlsMaterials {
  const keyPath = join(options.dir, SELF_SIGNED_KEY);
  const certPath = join(options.dir, SELF_SIGNED_CERT);
  if (existsSync(certPath) && existsSync(keyPath) && certStillValid(certPath)) {
    // 私钥权限收敛 0600（openssl -keyout 受 umask 影响可能过宽）
  chmodSync(keyPath, 0o600);
  return { cert: readFileSync(certPath), key: readFileSync(keyPath) };
  }
  mkdirSync(options.dir, { recursive: true });
  const sans = [...DEFAULT_SANS, ...(options.extraSans ?? []).map(toSanEntry)];
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-sha256",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-days",
        String(CERT_DAYS),
        "-subj",
        "/CN=dsh-lan-proxy",
        "-addext",
        `subjectAltName=${sans.join(",")}`,
      ],
      { stdio: "ignore", timeout: 30000 },
    );
  } catch (err) {
    throw new Error(`self-signed cert generation failed (is openssl installed?): ${(err as Error).message}`);
  }
  // 私钥权限收敛 0600（openssl -keyout 受 umask 影响可能过宽）
  chmodSync(keyPath, 0o600);
  return { cert: readFileSync(certPath), key: readFileSync(keyPath) };
}
