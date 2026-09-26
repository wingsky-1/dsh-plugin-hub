import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { installSettingsNamespace } from "../settings-namespace.js";

const NAMESPACE = "dsh-mcp-manager";

interface Descriptor {
  readonly ns: string;
  readonly value: { readonly position: string };
  readonly revision: number;
}

test("dsh-mcp-manager 同 namespace 事件在值变化后更新 source 并通知 onChange", () => {
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
