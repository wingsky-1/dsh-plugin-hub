/**
 * dsh-mem0 — 官方 settings 命名空间接线（薄包装，收敛自 shared）。
 *
 * 职责：插件在官方 settings 服务中的命名空间（SETTINGS_NS）、
 * installMem0Settings 注册与 scope 移交。
 */

import type { Context } from "@deepseek-ai/cordis";
import { installSettingsNamespace } from "../../../shared/settings-namespace.js";
import { Config, SETTINGS_NS, type Mem0Config } from "./config.ts";

export interface OwnerScopeLike {
  get(): Mem0Config;
  watch(cb: (next: Mem0Config, prev: Mem0Config) => void): () => void;
  update(patch: object, expectedRevision?: number): Promise<void>;
  replace(section: object, expectedRevision?: number): Promise<void>;
}

export interface SettingsServiceLike {
  register(ns: string, schema: unknown, options?: { base?: unknown }): OwnerScopeLike;
  describe(options?: { redactSecrets?: boolean }): Array<{ ns: string; user?: unknown; revision: number }>;
}

export interface Mem0SettingsHooks {
  setSource(source: () => Mem0Config): void;
  onChange(): void;
  onScope?(scope: OwnerScopeLike, service: SettingsServiceLike): void;
}

export function installMem0Settings(ctx: Context, entry: Mem0Config, hooks: Mem0SettingsHooks): void {
  installSettingsNamespace(ctx, SETTINGS_NS, Config, entry, {
    setSource: hooks.setSource as (source: () => unknown) => void,
    onChange: hooks.onChange,
    onScope: hooks.onScope as ((scope: unknown, service: unknown) => void) | undefined,
  });
}
