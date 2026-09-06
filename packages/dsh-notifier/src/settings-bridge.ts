import type { Context } from "@deepseek-ai/cordis";
import { errorMessage } from "../../../shared/host-utils.js";
import { configFile, normalizeConfig, sanitizeSettings } from "./config.ts";
import type { NotifierApplyConfig, NotifyConfig } from "./config.ts";
import { SETTINGS_NS, installNotifierSettings } from "./settings.ts";
import type { OwnerScopeLike, SettingsServiceLike } from "./settings.ts";
import { migrateLegacyConfig } from "./migrate.ts";

export interface SettingsBridge {
  entry: Record<string, unknown>;
  getCurrent: () => NotifyConfig;
  getSource: () => NotifyConfig;
  readUser: () => { user: Record<string, unknown>; revision?: number };
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

  getSource = (): NotifyConfig => this.source();

  isWritable = (): boolean => this.attachedService !== undefined;

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
}

/**
 * 创建并装配 settings 状态镜像与官方命名空间桥接。
 */
export function createSettingsBridge(ctx: Context, config: NotifierApplyConfig = {}): SettingsBridge {
  return new NotifierSettingsBridge(ctx, config);
}
