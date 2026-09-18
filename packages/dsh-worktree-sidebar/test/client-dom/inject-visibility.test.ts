// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { createInjectWrapper, releaseAllSeedings } from "../../src/client/inject.ts";
import type { SessionView } from "../../src/client/shared/ports.ts";

const hiddenDescriptor = Object.getOwnPropertyDescriptor(document, "hidden");
afterEach(() => {
  releaseAllSeedings();
  if (hiddenDescriptor) Object.defineProperty(document, "hidden", hiddenDescriptor);
  else Reflect.deleteProperty(document, "hidden");
});

function fixture() {
  let requests = 0;
  const listeners = new Set<() => void>();
  const view: SessionView = {
    source: { getSnapshot: () => ({}), subscribe: () => () => undefined },
    root: {
      getSnapshot: () => null,
      refresh: async () => {
        requests += 1;
      },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  };
  const face = createInjectWrapper(() => view)(() => ({ start: () => undefined }))("s1");
  const start = face["start"];
  if (typeof start !== "function") throw new Error("Expected wrapped start");
  return {
    start: (id: string, signal?: AbortSignal) => {
      start(id, "/repo", signal);
    },
    requests: () => requests,
    subscriptions: () => listeners.size,
  };
}

function dispatchVisibleEvents() {
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("focus"));
}

describe("visibility refresh lifecycle", () => {
  it("does not refresh while hidden, and refreshes once for each visible event", () => {
    const f = fixture();
    f.start("tab");
    expect(f.requests()).toBe(1);
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    dispatchVisibleEvents();
    expect(f.requests()).toBe(1);
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(f.requests()).toBe(2);
    window.dispatchEvent(new Event("focus"));
    expect(f.requests()).toBe(3);
  });

  it("shares listeners across tabs and removes them after the last abort", () => {
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    const f = fixture();
    const first = new AbortController();
    const second = new AbortController();
    f.start("first", first.signal);
    f.start("second", second.signal);
    expect(f.subscriptions()).toBe(1);
    dispatchVisibleEvents();
    expect(f.requests()).toBe(4);
    first.abort();
    dispatchVisibleEvents();
    expect(f.requests()).toBe(6);
    second.abort();
    expect(f.subscriptions()).toBe(0);
    dispatchVisibleEvents();
    expect(f.requests()).toBe(6);
  });

  it("tracks cleanup again when the same face opens a new tab after its last abort", () => {
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    const f = fixture();
    const first = new AbortController();
    f.start("first", first.signal);
    first.abort();
    expect(f.subscriptions()).toBe(0);
    f.start("second");
    expect(f.subscriptions()).toBe(1);
    releaseAllSeedings();
    expect(f.subscriptions()).toBe(0);
    dispatchVisibleEvents();
    expect(f.requests()).toBe(2);
  });

  it("removes listeners on disposal even without an abort signal", () => {
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    const f = fixture();
    f.start("tab");
    releaseAllSeedings();
    releaseAllSeedings();
    expect(f.subscriptions()).toBe(0);
    dispatchVisibleEvents();
    expect(f.requests()).toBe(1);
  });
});
