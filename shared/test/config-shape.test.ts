import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { installSettingsNamespace } from "../settings-namespace.js";
import {
  migrateLegacySettings,
  type LegacySettingsMigrationOptions,
  type LegacySettingsRecord,
} from "../legacy-settings-migration.js";

const NAMESPACE = "ui-dsh-mcp-manager";

type MigrationScope = {
  readonly current?: LegacySettingsRecord;
  update(patch: object, expectedRevision?: number): Promise<void>;
};

interface Descriptor {
  readonly ns: string;
  readonly value: { readonly position: string };
  readonly revision: number;
}

test("ui-dsh-mcp-manager 同 namespace 事件在值变化后更新 source 并通知 onChange", () => {
  const bus = new EventEmitter();
  const subscribedEvents: string[] = [];
  let descriptor: Descriptor = {
    ns: NAMESPACE,
    value: { position: "top-right" },
    revision: 1,
  };
  let source: (() => unknown) | undefined;
  let changes = 0;

  const settings = {
    describe: () => [{ ...descriptor, value: { ...descriptor.value } }],
  };
  const scoped = {
    settings,
    on(event: string, listener: (...args: unknown[]) => void) {
      subscribedEvents.push(event);
      return bus.on(event, listener);
    },
    effect(setup: () => () => void) {
      setup();
    },
  };
  const context = {
    fiber: { state: "active" },
    inject(keys: string[], setup: (value: typeof scoped) => void) {
      assert.deepEqual(keys, ["settings"]);
      setup(scoped);
    },
  };

  installSettingsNamespace(
    context,
    NAMESPACE,
    {},
    { position: "top-left" },
    {
      setSource(next) {
        source = next;
      },
      onChange() {
        changes += 1;
      },
    },
  );

  assert.deepEqual(subscribedEvents, ["settings/document-updated"]);
  assert.deepEqual(source?.(), { position: "top-right" });
  assert.equal(changes, 1);

  bus.emit("settings/document-updated", "other-namespace", 2);
  assert.deepEqual(source?.(), { position: "top-right" });
  assert.equal(changes, 1);

  descriptor = {
    ...descriptor,
    value: { position: "bottom-left" },
    revision: 2,
  };
  bus.emit("settings/document-updated", NAMESPACE, descriptor.revision);

  assert.deepEqual(source?.(), { position: "bottom-left" });
  assert.equal(changes, 2);
});

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "dsh-shared-legacy-settings-"));
  roots.push(root);
  return root;
}

function writeSection(home: string, name: string, section: LegacySettingsRecord): void {
  writeFileSync(join(home, name), JSON.stringify({ "legacy-test": section }), "utf8");
}

function makeScope(current: LegacySettingsRecord = {}) {
  const updates: LegacySettingsRecord[] = [];
  const revisions: Array<number | undefined> = [];
  return {
    updates,
    revisions,
    async update(patch: object, expectedRevision?: number): Promise<void> {
      updates.push(JSON.parse(JSON.stringify(patch)) as LegacySettingsRecord);
      revisions.push(expectedRevision);
    },
    current,
  };
}

function options(
  home: string,
  scope: MigrationScope,
  overrides: Partial<LegacySettingsMigrationOptions> = {},
): LegacySettingsMigrationOptions {
  return {
    legacyNamespace: "legacy-test",
    home,
    configDir: join(home, "plugin"),
    markerName: "settings.migrated",
    markerVersion: "1",
    sanitize: (section) => ({ value: section.value }),
    currentUser: scope.current,
    scope,
    label: "shared-test",
    ...overrides,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("imported < settings.yaml，sanitizer 只留下允许的字段", async () => {
  const home = tempRoot();
  writeSection(home, "settings.yaml.imported", {
    value: { fromImported: true, overridden: "old" },
    dropped: 1,
  });
  writeSection(home, "settings.yaml", {
    value: { fromSettings: true, overridden: "new" },
    dropped: 2,
  });
  const scope = makeScope();

  const result = await migrateLegacySettings(options(home, scope, { expectedRevision: 7 }));

  assert.equal(result.status, "migrated");
  assert.deepEqual(scope.updates, [
    { value: { fromImported: true, fromSettings: true, overridden: "new" } },
  ]);
  assert.deepEqual(scope.revisions, [7]);
  assert.equal(readFileSync(join(home, "plugin", "settings.migrated"), "utf8"), "1\n");
});

test("current user 的显式值优先，marker 后旧源不复活", async () => {
  const home = tempRoot();
  writeSection(home, "settings.yaml", { value: { keep: "legacy", replace: "legacy" } });
  const scope = makeScope({ value: { keep: "current" } });

  const first = await migrateLegacySettings(options(home, scope));
  assert.equal(first.status, "migrated");
  assert.deepEqual(scope.updates, [{ value: { replace: "legacy" } }]);

  writeSection(home, "settings.yaml", { value: { keep: "new-legacy" } });
  const second = await migrateLegacySettings(options(home, scope));
  assert.equal(second.status, "already-complete");
  assert.equal(scope.updates.length, 1);
});

test("canonical 写入失败留下 pending receipt，恢复时不重放旧值", async () => {
  const home = tempRoot();
  writeSection(home, "settings.yaml", { value: "at-most-once" });
  const marker = join(home, "plugin", "settings.migrated");
  const pending = `${marker}.pending`;
  let attempts = 0;
  const scope = {
    async update(): Promise<void> {
      attempts += 1;
      throw new Error("temporary settings failure");
    },
  };

  const first = await migrateLegacySettings(options(home, scope));
  assert.equal(first.status, "failed");
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(pending), true);

  const second = await migrateLegacySettings(options(home, scope));
  assert.equal(second.status, "already-complete");
  assert.equal(attempts, 1);
  assert.equal(readFileSync(marker, "utf8"), "1\n");
  assert.equal(existsSync(pending), false);
});

test("明确的 revision 冲突清理 receipt 后允许安全重试", async () => {
  const home = tempRoot();
  writeSection(home, "settings.yaml", { value: "retry-conflict" });
  const marker = join(home, "plugin", "settings.migrated");
  const pending = `${marker}.pending`;
  let attempts = 0;
  const scope = {
    updates: [] as LegacySettingsRecord[],
    async update(patch: object): Promise<void> {
      attempts += 1;
      if (attempts === 1) {
        const error = Object.assign(new Error("settings changed"), { code: "SETTINGS_CONFLICT" });
        throw error;
      }
      this.updates.push(JSON.parse(JSON.stringify(patch)) as LegacySettingsRecord);
    },
  };

  const first = await migrateLegacySettings(options(home, scope, { expectedRevision: 1 }));
  assert.equal(first.status, "failed");
  assert.equal(existsSync(pending), false);
  assert.equal(existsSync(marker), false);

  const second = await migrateLegacySettings(options(home, scope, { expectedRevision: 1 }));
  assert.equal(second.status, "migrated");
  assert.equal(attempts, 2);
  assert.deepEqual(scope.updates, [{ value: "retry-conflict" }]);
  assert.equal(existsSync(pending), false);
});

test("canonical 已写但完成 marker 失败，用户随后 unset 也不会复活旧值", async () => {
  const home = tempRoot();
  writeSection(home, "settings.yaml", { value: "committed" });
  const marker = join(home, "plugin", "settings.migrated");
  const pending = `${marker}.pending`;
  let attempts = 0;
  const scope = {
    async update(): Promise<void> {
      attempts += 1;
      mkdirSync(marker);
    },
  };

  const first = await migrateLegacySettings(options(home, scope));
  assert.equal(first.status, "failed");
  assert.equal(attempts, 1);
  assert.equal(existsSync(pending), true);

  // 模拟用户随后在设置页 unset：canonical user 缺字段；再移除故障注入目录。
  rmSync(marker, { recursive: true, force: true });
  const second = await migrateLegacySettings(options(home, scope));
  assert.equal(second.status, "already-complete");
  assert.equal(attempts, 1);
  assert.equal(readFileSync(marker, "utf8"), "1\n");
  assert.equal(existsSync(pending), false);
});
