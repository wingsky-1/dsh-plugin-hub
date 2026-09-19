// dsh-lan-proxy — TLS 证书准备。
//
// 两级证书来源，按配置优先：用户提供的 PEM（tlsCertFile / tlsKeyFile）→ 自签名证书。
// 自签证书经 selfsigned 生成（rsa:2048 / sha256 / 825 天 / 带 SAN），缓存到
// <DSH_HOME>/@wingsky-1/dsh-lan-proxy/ 幂等复用：存在且剩余有效期 > 24 小时则直接复用，否则重签。
// 过期判定走 node:crypto 的 X509Certificate，不依赖宿主机 openssl 子进程（issue #9）。
// SAN 是必需的——Chrome 59+ 对缺失 SAN 的证书直接拒绝，用户无法「继续访问」。
import { Buffer } from "node:buffer";
import { X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isIP } from "node:net";
import { generate as generateSelfSigned } from "selfsigned";

/** TLS 证书材料（PEM 字符串或 Buffer）。 */
export interface TlsMaterials {
  key: string | Buffer;
  cert: string | Buffer;
}

/** 自签证书缓存文件名（目录由调用方决定，见 shared/paths.ts 的命名空间目录）。 */
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

/**
 * 取首个 CERTIFICATE 块的 DER（issue #911 下发端用）。
 *
 * 接受 PEM（含链/私钥混排时跳过非证书块取首个证书）或 DER 二进制；纯私钥/
 * 垃圾一律抛错（调用方映射为 404，原文只进日志）。实测：私钥在前 + 证书
 * 在后照样解析出证书（只出公钥 material，私钥永不出网），故“误指私钥文件”
 * 仅在文件不含任何 CERTIFICATE 块时成立。X509Certificate 的首证书语义恰好
 * 就是“首证书”口径，无需手写 PEM 切分。
 */
export function extractFirstCertificateDer(input: string | Buffer): Buffer {
  try {
    return Buffer.from(new X509Certificate(input).raw);
  } catch (err) {
    throw new Error("not a valid CERTIFICATE PEM/DER: " + ((err as Error)?.message ?? err));
  }
}

/** DER → 单证书 PEM 文本（下发 ?format=pem 用；base64 64 列换行）。 */
export function encodeCertificatePem(der: Buffer): string {
  const b64 = der.toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 64) lines.push(b64.slice(i, i + 64));
  return "-----BEGIN CERTIFICATE-----\n" + lines.join("\n") + "\n-----END CERTIFICATE-----\n";
}

/** 下发失败码（对外固定文案，原文只进日志）。 */
export type DownloadCertCode = "ca-unconfigured" | "ca-unavailable" | "ca-invalid";

/** loadDownloadableCertificate 入参（调用方传值，本域不读配置存储）。 */
export interface DownloadCertSource {
  tlsCaCertFile?: string;
  tlsCertFile?: string;
  tlsKeyFile?: string;
  /** 自签回退目录（apply 经 resolvePluginDir 抉择后传入）。 */
  selfSignedDir: string;
}

/** loadDownloadableCertificate 结果（body 已按格式编码，附下发元信息）。 */
export type DownloadCertResult =
  | { ok: true; body: Buffer; contentType: string; filename: string }
  | { ok: false; code: DownloadCertCode };

/** 非空字符串判定（空串视为未配置，回落下一态）。 */
function hasCertPath(s: unknown): s is string {
  return typeof s === "string" && s.length > 0;
}

/**
 * 可下发证书装配（issue #911；证书知识只归本域，调用方只给值不读文件）。
 *
 * 三态：配 CA → 返回 CA 公钥；自签模式（叶对均空）→ 返回缓存叶子；配自定义
 * 叶子但无 CA → ca-unconfigured（装叶子建不起信任，返回即误导）。只伺服首个
 * CERTIFICATE 块（含链/混排跳过非证书块；纯私钥/垃圾 → ca-invalid）。
 * format 仅 der/pem（调用方 routes 层已白名单，非法不进本函数）。
 */
export function loadDownloadableCertificate(
  source: DownloadCertSource,
  format: "der" | "pem",
  logWarn?: (message: string) => void,
): DownloadCertResult {
  let file: string | undefined;
  if (hasCertPath(source.tlsCaCertFile)) {
    file = source.tlsCaCertFile;
  } else if (hasCertPath(source.tlsCertFile) || hasCertPath(source.tlsKeyFile)) {
    return { ok: false, code: "ca-unconfigured" };
  } else {
    file = join(source.selfSignedDir, SELF_SIGNED_CERT);
  }
  let raw: Buffer;
  try {
    raw = readFileSync(file);
  } catch (err) {
    logWarn?.("lan-proxy: 证书下发读取失败（" + file + ")— " + ((err as Error)?.message ?? err));
    return { ok: false, code: "ca-unavailable" };
  }
  let der: Buffer;
  try {
    der = extractFirstCertificateDer(raw);
  } catch (err) {
    logWarn?.(
      "lan-proxy: 证书下发解析失败（" +
        file +
        " 非 CERTIFICATE）— " +
        ((err as Error)?.message ?? err),
    );
    return { ok: false, code: "ca-invalid" };
  }
  if (format === "pem") {
    return {
      ok: true,
      body: Buffer.from(encodeCertificatePem(der), "utf8"),
      contentType: "application/x-pem-file",
      filename: "dsh-lan-ca.pem",
    };
  }
  return {
    ok: true,
    body: der,
    contentType: "application/x-x509-ca-cert",
    filename: "dsh-lan-ca.cer",
  };
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
