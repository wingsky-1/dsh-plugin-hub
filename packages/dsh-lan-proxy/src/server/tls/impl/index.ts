// dsh-lan-proxy — TLS 证书准备。
//
// 两级证书来源，按配置优先：用户提供的 PEM（tlsCertFile / tlsKeyFile）→ 自签名证书。
// 自签证书经 selfsigned 生成（rsa:2048 / sha256 / 825 天 / 带 SAN），缓存到
// <DSH_HOME>/@wingsky-1/dsh-lan-proxy/ 幂等复用：存在且剩余有效期 > 24 小时则直接复用，否则重签。
// 过期判定走 node:crypto 的 X509Certificate，不依赖宿主机 openssl 子进程（issue #9）。
// SAN 是必需的——Chrome 59+ 对缺失 SAN 的证书直接拒绝，用户无法「继续访问」。
import { Buffer } from "node:buffer";
import { X509Certificate, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isIP } from "node:net";
import { generate as generateSelfSigned } from "selfsigned";
import * as forge from "node-forge";

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
/** 一键 CA 有效期（天）。10 年：装机一次长期信任，轮换 CA 即显式危险动作（#930 F6/F10）。 */
const CA_DAYS = 3650;
/** 一键生成叶子有效期（天）。398 = 现行最严交集（#930 修正评论 2026-09-19；
 * 既有 CERT_DAYS=825 保留给自签存量兼容，不沿用）。 */
const LEAF_DAYS = 398;
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
 * 可下发证书装配（issue #911 下发面，#930 Phase 1 收紧为无 CA 不下发；证书知识
 * 只归本域，调用方只给值不读文件）。
 *
 * 两态：配 CA → 返回 CA 公钥；无 CA（一律 404 ca-unconfigured）→ 自签模式与
 * 自定义叶子模式都不下发（自签叶子/孤叶子装了建不起信任，返回即误导）。只伺服
 * 首个 CERTIFICATE 块（含链/混排跳过非证书块；纯私钥/垃圾 → ca-invalid）。
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
    // #930 Phase 1：自签模式无 CA 可下发（下发自签叶子对 iOS 无用但外观可用，
    // 口径不诚实），与自定义无 CA 同码 404，调用方凭 caConfigured=false 联合判定。
    return { ok: false, code: "ca-unconfigured" };
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

/** 一键 CA 全套材料（PEM 文本；落盘与 scope 写入归 ca 域，本函数不碰 FS/scope）。 */
export interface CaAndLeafMaterials {
  caCert: string;
  caKey: string;
  leafCert: string;
  leafKey: string;
}

/** 仅轮换叶子时的新叶子材料（PEM 文本；CA 续用，已装设备零操作）。 */
export interface LeafMaterials {
  leafCert: string;
  leafKey: string;
}

/**
 * forge RSA 异步生成（#930 F5：回调式，不阻塞 loopback 请求）。
 *
 * Node 下 forge 优先走原生 `_crypto.generateKeyPair`（lib/rsa.js 回调分支），
 * 熵源为 `require("crypto").randomBytes`（lib/prng.js seedFile 系，CSPRNG）；
 * 只有显式 `usePureJavaScript` 才回落 Fortuna 弱熵——本包不设该 flag。
 * 行号证据见 #930 F15（random.js CSPRNG 分支 / prng.js 15-19,328-341）。
 */
function generateRsaKeyPair(bits: number): Promise<forge.pki.rsa.KeyPair> {
  return new Promise((resolve, reject) => {
    forge.pki.rsa.generateKeyPair(bits, 0x10001, (err, keypair) => {
      if (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      resolve(keypair);
    });
  });
}

/** 证书序列号（CSPRNG 16 hex；同一 CA 下新签叶子不重号）。 */
function freshSerialHex(): string {
  return randomBytes(8).toString("hex");
}

/** 证书有效期窗口（notBefore 即刻，notAfter 按天）。 */
function validityWindow(days: number): { notBefore: Date; notAfter: Date } {
  return { notBefore: new Date(), notAfter: new Date(Date.now() + days * 86400 * 1000) };
}

/** 叶子 SAN：默认回环集 + 调用方快照的局域网 IP（toSanEntry 编码，IP 走 type 7）。 */
function leafSans(extraSans: string[]): SanAltName[] {
  return [...DEFAULT_SANS, ...extraSans.map(toSanEntry)];
}

/**
 * 签发自签 CA 证书体（profile 全表 #930 F6：basicConstraints cA:true +
 * keyUsage keyCertSign/cRLSign；subject/issuer 同体，sha256 自签）。
 */
function buildCaCertificate(publicKey: forge.pki.PublicKey): forge.pki.Certificate {
  const cert = forge.pki.createCertificate();
  cert.publicKey = publicKey;
  cert.serialNumber = freshSerialHex();
  const window = validityWindow(CA_DAYS);
  cert.validity.notBefore = window.notBefore;
  cert.validity.notAfter = window.notAfter;
  const attrs = [{ name: "commonName", value: "dsh-lan-proxy CA" }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
  ]);
  return cert;
}

/**
 * 签发 CA 下叶子证书体（profile 全表 #930 F6：cA:false + digitalSignature/
 * keyEncipherment + serverAuth + SAN；sha256 经 CA 私钥签）。
 */
function buildLeafCertificate(
  publicKey: forge.pki.PublicKey,
  extraSans: string[],
): forge.pki.Certificate {
  const cert = forge.pki.createCertificate();
  cert.publicKey = publicKey;
  cert.serialNumber = freshSerialHex();
  const window = validityWindow(LEAF_DAYS);
  cert.validity.notBefore = window.notBefore;
  cert.validity.notAfter = window.notAfter;
  cert.setSubject([{ name: "commonName", value: "dsh-lan-proxy" }]);
  cert.setIssuer([{ name: "commonName", value: "dsh-lan-proxy CA" }]);
  cert.setExtensions([
    { name: "basicConstraints", cA: false, critical: true },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
    { name: "extKeyUsage", serverAuth: true },
    { name: "subjectAltName", altNames: leafSans(extraSans) },
  ]);
  return cert;
}

/**
 * 一键生成本地 CA 全套（#930 F2 纯函数：只回答证书字节，不碰 FS/scope；
 * 调用方（ca 域）负责 temp+rename 落盘与 scope 写入）。
 *
 * 两次 RSA-2048 均为回调式异步（F5）；签名段为同步 forge 运算（ms 级，验证列实测）。
 * 失败抛错（调用方映射 500 ca-generate-failed，原文只进日志）。
 */
export async function generateCaAndLeaf(extraSans: string[]): Promise<CaAndLeafMaterials> {
  const caKeys = await generateRsaKeyPair(2048);
  const caCert = buildCaCertificate(caKeys.publicKey);
  caCert.sign(caKeys.privateKey, forge.md.sha256.create());
  const leafKeys = await generateRsaKeyPair(2048);
  const leafCert = buildLeafCertificate(leafKeys.publicKey, extraSans);
  leafCert.sign(caKeys.privateKey, forge.md.sha256.create());
  return {
    caCert: forge.pki.certificateToPem(caCert),
    caKey: forge.pki.privateKeyToPem(caKeys.privateKey),
    leafCert: forge.pki.certificateToPem(leafCert),
    leafKey: forge.pki.privateKeyToPem(leafKeys.privateKey),
  };
}

/**
 * 仅轮换叶子（#930 F10 默认动作：CA 续用，已装设备零操作）。
 *
 * CA 公私钥由调用方从托管文件读入（路径合法性由 ca 域 isManaged 判定，本函数
 * 只做 PEM 解析与签发）；新叶子 398 天 + 同口径 SAN（调用方传当期 extraSans
 * 快照，IP 变化即跟进）。失败抛错（同 generateCaAndLeaf 映射）。
 */
export async function generateLeafSignedByCa(
  caCertPem: string,
  caKeyPem: string,
  extraSans: string[],
): Promise<LeafMaterials> {
  let caKey: forge.pki.PrivateKey;
  try {
    caKey = forge.pki.privateKeyFromPem(caKeyPem);
    forge.pki.certificateFromPem(caCertPem);
  } catch (err) {
    throw new Error("invalid CA materials: " + (err instanceof Error ? err.message : String(err)));
  }
  const leafKeys = await generateRsaKeyPair(2048);
  const leafCert = buildLeafCertificate(leafKeys.publicKey, extraSans);
  leafCert.sign(caKey, forge.md.sha256.create());
  return {
    leafCert: forge.pki.certificateToPem(leafCert),
    leafKey: forge.pki.privateKeyToPem(leafKeys.privateKey),
  };
}

/** 叶子证书摘要（health certInfo 载荷；只出日期/SAN，不出路径/PEM）。 */
export type LeafCertSummary = { ok: true; validTo: string; sans: string[] } | { ok: false };

/**
 * 读叶子证书摘要（#930 F8 数据源：health.certInfo 当期值）。
 *
 * 读不出/解析不出即 { ok: false }（调用方 health 置 certInfo null，不提醒；
 * 下发端仍按三态如实 404，见 loadDownloadableCertificate）。SAN 取
 * X509Certificate.subjectAltName 原串按“, ”切分（DNS:/IP Address: 前缀保留，
 * 客户端只做包含比对，不过滤——丢前缀等于丢信息）。
 */
export function readLeafCertInfo(certPath: string): LeafCertSummary {
  try {
    const cert = new X509Certificate(readFileSync(certPath));
    const raw = cert.subjectAltName ?? "";
    const sans = raw.length === 0 ? [] : raw.split(", ");
    // ISO 格式出 health：客户端 new Date() 可靠解析（X509 原串非 ISO，各引擎解析不一）。
    return { ok: true, validTo: cert.validToDate.toISOString(), sans };
  } catch {
    return { ok: false };
  }
}
