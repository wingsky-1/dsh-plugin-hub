// @ts-nocheck
/**
 * dsh-provider-usage — unit：适配器热更新语义（`HotReloadableAdapter`，确定性驱动、零墙钟）。
 *
 * 覆盖：start 装载首版与文件缺失失败、pollOnce 检出变化后原子切换、契约非法的重写保留旧版、
 * 文件删除保留旧版；以及「mtime 未变、size 已变」必须重载的回归用例。
 *
 * 最后一条锁住版本戳形态（#722 实证）：`?t=<13 位毫秒>` 会被 vite 系模块运行器当时间戳
 * 剥离（`/\bt=\d{13}&?\b/`），只剩亚毫秒小数位参与模块标识；内核 coarse 时钟下同一 tick
 * 的两次写入 mtimeMs 完全相同，剥离后 URL 撞成同一个模块 → 模块缓存命中 → 热更新静默
 * 加载旧版（现象为「热更新成功」日志照常打印、路由始终看不到新版）。
 */
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { HotReloadableAdapter, loadAndValidateAdapter } from "../../../src/apply/index.ts";

/** 合法 v2 契约适配器正文；marker 用于制造 size 变化。 */
function adapterBody(label: string, marker = ""): string {
  return `
export const version = 2;
export const name = "hr-unit";
export const label = "${label}";
export const providers = ["opencode-go"];
export async function fetchData() { return { v: 1 }; }
export function formatCapsule() { return "<span>${label}</span>"; }
export function formatPanel() { return "<p>${label}</p>"; }
${marker}
`;
}

describe("HotReloadableAdapter：start 与 pollOnce 确定性驱动", () => {
  it("文件缺失：start 返回失败并回调错误", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dou-hr-unit-"));
    const events = [];
    const hr = new HotReloadableAdapter(join(dir, "missing.mjs"), 60000, (i) => events.push(i));
    const started = await hr.start();
    expect(started.ok).toBe(false);
    expect(started.error ?? "").toMatch(/不存在或不可读/);
    expect(events.length).toBe(1);
    expect(events[0].ok).toBe(false);
    hr.stop();
  });

  it("合法文件：start 装载首版，onReload 收到 ok:true", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dou-hr-unit-"));
    const f = join(dir, "a.mjs");
    writeFileSync(f, adapterBody("v1"), "utf8");
    const events = [];
    const hr = new HotReloadableAdapter(f, 60000, (i) => events.push(i));
    const started = await hr.start();
    expect(started.ok).toBe(true);
    expect(hr.current?.label).toBe("v1");
    expect(events.at(-1)?.ok).toBe(true);
    hr.stop();
  });

  it("mtime 未变、size 已变：pollOnce 仍须切换到新版本（stamp 双因子）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dou-hr-unit-"));
    const f = join(dir, "a.mjs");
    writeFileSync(f, adapterBody("v1"), "utf8");
    const stamp = statSync(f);
    const hr = new HotReloadableAdapter(f, 60000);
    await hr.start();
    expect(hr.current?.label).toBe("v1");

    // 同 mtime 下的重写（mtime 用 utimes 还原到毫秒），只有 size 变化 → stamp 必须不同
    writeFileSync(f, adapterBody("v2-with-longer-content"), "utf8");
    utimesSync(f, stamp.atime, stamp.mtime);

    const polled = await hr.pollOnce();
    expect(polled.ok).toBe(true);
    expect(hr.current?.label).toBe("v2-with-longer-content");
    hr.stop();
  });

  it("版本戳须让模块运行器区分两次加载（#722 缓存命中回归）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dou-hr-unit-"));
    const f = join(dir, "a.mjs");
    writeFileSync(f, adapterBody("v1"), "utf8");

    // 人为固定「13 位毫秒不同、亚毫秒相同」的两枚 stamp：内核 coarse 时钟下真实 mtime
    // 正是这种形态（同一 tick 的写入连亚毫秒都相同），但出现时机随负载漂移，此处钉死。
    const first = await loadAndValidateAdapter(f, { mtimeMs: 1_700_000_000_000.629, size: 1 });
    expect(first.adapter?.label).toBe("v1");

    writeFileSync(f, adapterBody("v2"), "utf8");
    const second = await loadAndValidateAdapter(f, { mtimeMs: 1_700_000_000_004.629, size: 2 });
    // `?t=<mtimeMs>` 形态下 vite 系运行器剥离 13 位毫秒，两次 URL 同为 `?t=.629` →
    // 模块缓存命中 → 这里会拿到 v1（热更新静默失效）。
    expect(second.adapter?.label).toBe("v2");
  });

  it("mtime 变化：pollOnce 切换到新版本", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dou-hr-unit-"));
    const f = join(dir, "a.mjs");
    writeFileSync(f, adapterBody("v1"), "utf8");
    const hr = new HotReloadableAdapter(f, 60000);
    await hr.start();

    const past = new Date(Date.now() - 60000);
    writeFileSync(f, adapterBody("v2"), "utf8");
    utimesSync(f, past, past);

    const polled = await hr.pollOnce();
    expect(polled.ok).toBe(true);
    expect(hr.current?.label).toBe("v2");
    hr.stop();
  });

  it("重写为非法契约：pollOnce 保留旧版并回报错误", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dou-hr-unit-"));
    const f = join(dir, "a.mjs");
    writeFileSync(f, adapterBody("v1"), "utf8");
    const events = [];
    const hr = new HotReloadableAdapter(f, 60000, (i) => events.push(i));
    await hr.start();

    writeFileSync(f, `export const version = 2; export const name = "hr-unit";`, "utf8");
    const polled = await hr.pollOnce();
    expect(polled.ok).toBe(false);
    expect(polled.error ?? "").toMatch(/契约校验失败/);
    expect(hr.current?.label).toBe("v1");
    expect(events.at(-1)?.ok).toBe(false);
    hr.stop();
  });

  it("文件删除：pollOnce 视为无变化并保留旧版", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dou-hr-unit-"));
    const f = join(dir, "a.mjs");
    writeFileSync(f, adapterBody("v1"), "utf8");
    const hr = new HotReloadableAdapter(f, 60000);
    await hr.start();

    rmSync(f);
    const polled = await hr.pollOnce();
    expect(polled.ok).toBe(true);
    expect(hr.current?.label).toBe("v1");
    hr.stop();
  });
});
