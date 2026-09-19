/**
 * dsh-lan-proxy — ca 域依赖声明（#930 一键生成本地 CA）。
 *
 * 纯类型面：声明本域对上需要什么，不提供、不实现。能力按提供方分组，
 * 端口收窄到实际使用的方法。值一律由装配层（apply）注入——本域实现文件
 * 不得值引 config/tls 域（verify-dir-imports I2① 域间值边终态为空）：
 * ROUTES 路径、forge 纯函数、scope 写面全部经本面注入；路径常量走
 * server/shared 叶子（共享设施由实现块直接引，不经注入面）。
 */
import type { ResolvedConfig } from "../config/interface.ts";
import type { CaAndLeafMaterials, LeafMaterials } from "../tls/interface.ts";

/** 配置提供方端口（settings 命名空间读写真相；revision 供乐观并发）。 */
export interface CaConfigPort {
  /** 当前生效配置（逐请求现读，非装配期快照）。 */
  resolve(): ResolvedConfig;
  /** 用户层原始节与 revision。 */
  readUser(): CaUserSnapshot;
  /** settings 服务是否可用（决定 POST 是否可写）。 */
  writable(): boolean;
  /** 增量 merge 三键进用户层（首建新增、轮换同值刷新 + revision 推进）。 */
  update(patch: object, expectedRevision?: number): Promise<void>;
}

/** 用户层快照（revision 缺席 = 服务未 attach，此时 writable() 必 false）。 */
export interface CaUserSnapshot {
  user: Record<string, unknown>;
  revision?: number;
}

/** 证书签发提供方端口（tls 域 forge 纯函数；FS 落盘与 scope 写入归本域）。 */
export interface CaCryptoPort {
  /** 全套：新 CA + 新叶子（首建与 CA 轮换）。 */
  generateFull(extraSans: string[]): Promise<CaAndLeafMaterials>;
  /** 仅叶子：沿用既有 CA 签新叶子（默认轮换，已装设备零操作）。 */
  generateLeaf(caCertPem: string, caKeyPem: string, extraSans: string[]): Promise<LeafMaterials>;
}

/** 变更类 FS 提供方端口（P1-1/R3 失败注入接缝：跨目标提交的补偿回滚、prune
 * 的 readdir/unlink 故障单测经此注入。kept-narrow 理由：读侧（readFileSync/
 * existsSync）与创建侧（writeFileSync/mkdirSync/chmodSync）的失败都收敛到同一
 * 500 映射且已有端到端覆盖，true/false 双态亦有真值表覆盖——无中途注入需求，
 * 故不进缝，直连 node:fs）。 */
export interface CaFsPort {
  renameSync(from: string, to: string): void;
  readdirSync(dir: string): string[];
  unlinkSync(path: string): void;
}

/** buildCaActionRoutes 的依赖注入面（apply 内装配；单测用 fake 直接构造）。 */
export interface CaActionDeps {
  /** 路由路径（apply 从 ROUTES.caGenerate 注入；本域不值引 config 域）。 */
  readonly path: string;
  readonly config: CaConfigPort;
  readonly crypto: CaCryptoPort;
  readonly fs: CaFsPort;
  /** 当期局域网 IP 快照提供者（逐请求现读，非装配期快照）。 */
  readonly lanIps: () => string[];
  /** 服务端日志兜底（错误原文只进日志，不进响应）。 */
  readonly logWarn: (message: string) => void;
}
