import type { Context } from "@deepseek-ai/cordis";
import { errorMessage } from "../../../../shared/host-utils.js";
import { normalizeConfig } from "./normalize.ts";
import { sanitizeSettings } from "./validators.ts";
import { configFile } from "./paths.ts";
import type { NotifierApplyConfig, NotifyConfig } from "./config.ts";
import { SETTINGS_NS, installNotifierSettings } from "./settings.ts";
import type { OwnerScopeLike, SettingsServiceLike } from "./settings.ts";
import { migrateLegacyConfig } from "./migrate.ts";

/**
 * 配置域对 API/判定层的正式接口（settings-bridge 实现；L8-2：路由面与 sdk
 * 注入面引用同一 confirmKind 实现，本文件是唯一 CAS 语义落点）。
 */
export interface ConfigPort {
  /** 当前生效配置（schemastery 解析值，含默认值兜底；getCurrent 别名）。 */
  resolve(): NotifyConfig;
  /** settings user 层原始节与 revision（describe({redactSecrets:true}) 读取）。
   *  降级：未 attach → { user: {}, revision: undefined }。 */
  readUser(): { user: Record<string, unknown>; revision?: number };
  /** settings 服务是否可用（决定 PUT 可写）；降级：未 attach → false。 */
  writable(): boolean;
  /** 增量 merge patch 进 settings user 层（乐观并发经 expectedRevision；
   *  SETTINGS_CONFLICT / SETTINGS_UNAVAILABLE）。 */
  update(patch: object, expectedRevision?: number): Promise<void>;
  /** 动态 kind 确认写入 allowKinds（CAS 重试 ≤2：SETTINGS_CONFLICT 回读重试、
   *  耗尽 reject）。 */
  confirmKind(kind: string, confirmed: boolean): Promise<void>;
}

export interface SettingsBridge extends ConfigPort {
  entry: Record<string, unknown>;
  getCurrent: () => NotifyConfig;
  getSource: () => NotifyConfig;
  isWritable: () => boolean;
  updateConfig: (patch: object, expectedRevision?: number) => Promise<void>;
  confirmKindToConfig: (kind: string, confirmed: boolean) => Promise<void>;
  getScope: () => OwnerScopeLike | undefined;
  getService: () => SettingsServiceLike | undefined;
}

/**
 * settings 状态镜像与官方命名空间桥接实现类。
 */
export class NotifierSettingsBridge implements SettingsBridge {
  entry: Record<string, unknown>;
  private current: NotifyConfig;
  private source: () => NotifyConfig;
  private attachedService: SettingsServiceLike | undefined;
  private attachedScope: OwnerScopeLike | undefined;

  constructor(ctx: Context, config: NotifierApplyConfig = {}) {
    const entry = (sanitizeSettings(config) ?? {}) as Record<string, unknown>;
    const storeFile = typeof config.configFile === "string" ? config.configFile : configFile();
    this.entry = entry;
    this.current = normalizeConfig(entry);
    this.source = () => this.current;

    installNotifierSettings(ctx, entry, {
      setSource: (s) => {
        this.source = s;
        this.current = normalizeConfig(s());
      },
      onChange: () => {
        this.current = normalizeConfig(this.source());
      },
      onScope: (scope, service) => {
        this.attachedScope = scope;
        this.attachedService = service;
        void migrateLegacyConfig(
          storeFile,
          {
            update: (patch) => service.update(SETTINGS_NS, patch),
            readUser: () => this.readUser().user,
          },
          ctx.logger,
        ).catch((err) => {
          ctx.logger.warn(`dsh-notifier: 存量配置迁移异常 — ${errorMessage(err)}`);
        });
      },
    });
  }

  getCurrent = (): NotifyConfig => this.current;

  /** ConfigPort 面：resolve 是 getCurrent 的别名（装配层 current() 单刻快照源）。 */
  resolve = (): NotifyConfig => this.getCurrent();

  getSource = (): NotifyConfig => this.source();

  isWritable = (): boolean => this.attachedService !== undefined;

  /** ConfigPort 面：writable 是 isWritable 的别名。 */
  writable = (): boolean => this.isWritable();

  getScope = (): OwnerScopeLike | undefined => this.attachedScope;

  getService = (): SettingsServiceLike | undefined => this.attachedService;

  readUser = (): { user: Record<string, unknown>; revision?: number } => {
    if (!this.attachedService) return { user: {}, revision: undefined };
    try {
      const descriptor = this.attachedService.describe({ redactSecrets: true }).find((d) => d.ns === SETTINGS_NS);
      return {
        user: (descriptor?.user && typeof descriptor.user === "object" ? descriptor.user : {}) as Record<string, unknown>,
        revision: descriptor?.revision,
      };
    } catch {
      return { user: {}, revision: undefined };
    }
  };

  updateConfig = (patch: object, expectedRevision?: number): Promise<void> => {
    const service = this.attachedService;
    if (!service) {
      const err = new Error("settings service unavailable") as Error & { code?: string };
      err.code = "SETTINGS_UNAVAILABLE";
      return Promise.reject(err);
    }
    return service.update(SETTINGS_NS, patch, expectedRevision);
  };

  /** ConfigPort 面：update 是 updateConfig 的别名（路由 PUT 写面）。 */
  update = (patch: object, expectedRevision?: number): Promise<void> => this.updateConfig(patch, expectedRevision);

  confirmKindToConfig = async (kind: string, confirmed: boolean): Promise<void> => {
    const MAX_CONFLICT_RETRIES = 2;
    for (let attempt = 0; ; attempt += 1) {
      const { user, revision } = this.readUser();
      const resolved = this.source();
      const baseAllowed = Array.isArray(user.allowKinds)
        ? user.allowKinds
        : Array.isArray(resolved.allowKinds)
          ? resolved.allowKinds
          : [];
      const allowed = new Set<string>(baseAllowed);
      if (confirmed) allowed.add(kind);
      else allowed.delete(kind);
      try {
        await this.updateConfig({ allowKinds: [...allowed] }, revision);
      } catch (err) {
        const code = (err as { code?: unknown })?.code;
        if (code === "SETTINGS_CONFLICT" && attempt < MAX_CONFLICT_RETRIES) continue;
        throw err;
      }
      this.current = this.source();
      return;
    }
  };

  /** ConfigPort 面：confirmKind 是 confirmKindToConfig 的别名（CAS 重试 ≤2）。 */
  confirmKind = (kind: string, confirmed: boolean): Promise<void> => this.confirmKindToConfig(kind, confirmed);
}

/**
 * 创建并装配 settings 状态镜像与官方命名空间桥接。
 */
export function createSettingsBridge(ctx: Context, config: NotifierApplyConfig = {}): SettingsBridge {
  return new NotifierSettingsBridge(ctx, config);
}
