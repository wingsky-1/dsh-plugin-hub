#!/usr/bin/env node
"use strict";

/**
 * host-contract 派生回归：真实 CLI 必须只汇报唯一目标 rc.2 的当前注册事实。
 * 任何旧 runtime / settings.plugin.item 叙事回流都会打红。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const SCRIPT = join(ROOT, "scripts", "derive", "host-contract.mjs");

function runDerive(args: readonly string[] = []): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const EXPECTED_ROW_CONFIG_SLOTS = [
  {
    file: "packages/dsh-lan-proxy/src/client/index.ts",
    slot: "plugins.row.config",
    bundlePackage: "@wingsky-1/dsh-lan-proxy",
    rowId: "dsh-lan-proxy",
    settingsNamespace: "dsh-lan-proxy",
    key: "@wingsky-1/dsh-lan-proxy#dsh-lan-proxy",
  },
  {
    file: "packages/dsh-mcp-manager/src/client/index.ts",
    slot: "plugins.row.config",
    bundlePackage: "@wingsky-1/dsh-mcp-manager",
    rowId: "dsh-mcp-manager",
    settingsNamespace: "dsh-mcp-manager",
    key: "@wingsky-1/dsh-mcp-manager#dsh-mcp-manager",
  },
];

test("--sample 只输出唯一目标 rc.2 与当前四个 slot 注册事实", () => {
  const result = runDerive(["--sample"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    notifierEvents: [
      "approval/request",
      "user-questions/request",
      "session/event",
      "agent/status",
      "agent/disposed",
      "agent/turn-stopping",
      "agent/error",
    ],
    mcpSectionOrder: "160",
    targetRuntime: "0.1.7-rc.2",
    sessionAnchor:
      '唯一目标 runtime 0.1.7-rc.2 的事实源为 ctx.on("session/event")；结算类型为 assistant/message（内嵌 stream）与 assistant/attempt；无 assistant/chunk',
    slotCount: 4,
    rowConfigSlots: EXPECTED_ROW_CONFIG_SLOTS,
    routeCount: 39,
    domCount: 11,
  });
});

test("完整派生保留 canonical row facts，且不含旧 runtime 兼容叙事", () => {
  const result = runDerive();
  assert.equal(result.status, 0, result.stderr);
  const derived = JSON.parse(result.stdout) as {
    slots: Array<{ slot: string }>;
    sessionFormat: { targetRuntime: string; collectorMentionsChunkRemoval: boolean };
  };

  assert.equal(derived.sessionFormat.targetRuntime, "0.1.7-rc.2");
  assert.equal(derived.sessionFormat.collectorMentionsChunkRemoval, false);
  assert.deepEqual(
    derived.slots.filter(({ slot }) => slot === "plugins.row.config"),
    EXPECTED_ROW_CONFIG_SLOTS.map((row) => ({
      ...row,
      patch: {
        file: row.file.replace("/src/client/index.ts", "/cordis.patch.yml"),
        id: row.rowId,
        name: row.bundlePackage,
      },
    })),
  );
  assert.doesNotMatch(result.stdout, /0\.1\.5|settings\.plugin\.item/);
});
