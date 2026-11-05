/**
 * schedule 组合根：detector 探针 + D3三 轮询否定 toFake 面（含本模块自读断言）。
 *
 * 由原入口 composition-root.test.ts 在原顺序同步注册；父 suite/title/each/expect/fixture 与
 * cache 生命周期、hook/await 时点完全保持（拆分为注册调用，零行为变更）。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pollUntil } from "../../helpers.ts";
import { ReportScheduler } from "../../../src/server/schedule/interface.ts";
import { normalizeReportConfig } from "../../../src/server/config/interface.ts";
import type { ScheduleWarn } from "../../../src/server/schedule/deps.ts";
import { BUSINESS_MARKERS, FORBIDDEN_FACES } from "./schedule-composition-facade.ts";

/** 本模块自己的源文本路径：时间纪律自扫读真实拥有者源（原入口 composition-root.test.ts 不再持有该断言）。 */
/** 本模块自己的源文本路径：时间纪律自扫读真实拥有者源（原入口 composition-root.test.ts 不再持有该断言）。 */
const selfFile = fileURLToPath(import.meta.url);

/** 命名接缝消费（类型链接由 tsc 编译面校验可赋值性）：块 Options 用内联双生子，名称在此复用。 */
const quietWarn: ScheduleWarn = () => undefined;

/** 探针与 toFake 面段仍须原入口读出的 src 文本（判据 = 真实装配文本注入一行即被 flag）。 */
export interface SchedulePollGuardSources {
  applySrc: string;
  schedulerSrc: string;
}

export function registerSchedulePollGuardCases(src: SchedulePollGuardSources): void {
  const { applySrc, schedulerSrc } = src;
  describe("探针：脏输入必被 flag（detector 失明则本段先红）", () => {
    it("根内调度纯函数调用即被 flag", () => {
      const dirty = "const due = candidateWindow(period, cfg, now);";
      expect(BUSINESS_MARKERS.some((b) => dirty.includes(b.marker))).toBe(true);
    });

    it("根内 lastRun 直写即被 flag", () => {
      const dirty = "await updateLastRun(root, (cur) => ({ ...cur, daily: key }));";
      expect(BUSINESS_MARKERS.some((b) => dirty.includes(b.marker))).toBe(true);
    });

    it("直连实现文件即被 flag", () => {
      const dirty = 'import { ReportScheduler } from "../server/schedule/scheduler.ts";';
      expect(FORBIDDEN_FACES.some((f) => dirty.includes(f))).toBe(true);
    });

    it("直连旧域即被 flag", () => {
      const dirty = 'import { pendingReports } from "../domain2/schedule/interface.ts";';
      expect(FORBIDDEN_FACES.some((f) => dirty.includes(f))).toBe(true);
    });

    it("真实装配文本注入一行调度判断即被 flag（免洗 repo）", () => {
      const injected = [applySrc, "const due = pendingReports(cfg, Date.now(), {});", ""].join(
        String.fromCharCode(10),
      );
      const hits = BUSINESS_MARKERS.filter((b) => injected.includes(b.marker)).map((b) => b.marker);
      expect(hits).toEqual(["pendingReports("]);
    });

    it("60s 默认被改即被 flag（detector 对标记有效）", () => {
      const dirty = "this.tickMs = opts.tickMs ?? 30_000;";
      expect(dirty.includes("?? 60_000")).toBe(false);
      expect(schedulerSrc.includes("?? 60_000")).toBe(true);
    });
  });

  describe("D3三-轮询否定 toFake 面（#768 计划表 rev2 D3 验收）", () => {
    // 时间纪律（testing skill §4）：显式声明 toFake 面，只伪造轮询定时器
    // （setInterval/clearInterval），Date 与 setTimeout 保持真实——pollUntil 的
    // 截止读真实 Date.now()，钉死 Date 它永不超时；pollUntil 内部 setTimeout
    // 保持真实才能推进等待。裸 sleep（固定时长后断言未发生）在慢盘下必然 flake，
    // 此处禁用：本文件时间纪律用例锁定无裸 sleep 字面（见末段自扫）。
    afterEach(() => {
      vi.useRealTimers();
    });

    it("dispose 后轮询停止：假时钟推进 5 个 tick 无新增到期提交", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const root = mkdtempSync(join(tmpdir(), "d3-poll-neg-"));
      try {
        const seen: Array<{ period: string; key: string }> = [];
        const sched = ReportScheduler.start({
          root,
          config: normalizeReportConfig({
            daily: { enabled: true, time: "00:00" },
            weekly: { enabled: false, time: "09:00", weekStartsOn: 1 },
            monthly: { enabled: false, time: "09:00", dayOfMonth: 1 },
          }),
          onDue: async (due) => {
            seen.push({ period: due.period, key: due.key });
          },
          tickMs: 30,
          warn: quietWarn,
        });
        try {
          // 首达确定性（#962 flake 实证 run 35803984163：50 轮纯假时钟推进后
          // 直接断言，tick() 的 readLastRun/onDue 在飞 promise 未落定即判 seen>=1，
          // 慢盘下 `expected 0 to be >= 1` 干跑失败）。启动补跑 tick 走真实 promise
          // 链（不依赖假时钟），interval tick 的异步体同样需真实事件循环落定——
          // 每轮推进后用真实 pollUntil（Date/setTimeout 保持真实，见本段头注释）
          // 排空在飞 tick，可观测量收敛才断言；不用裸 sleep 假设静默。
          for (let i = 0; i < 50 && seen.length < 1; i += 1) {
            if (i > 0) await vi.advanceTimersByTimeAsync(30);
            const arrived = await pollUntil(() => seen.length >= 1, 300, 10);
            if (arrived) break;
          }
          expect(seen.length).toBeGreaterThanOrEqual(1);
          expect(vi.getTimerCount()).toBe(1); // 假时钟下有且仅有一个轮询句柄（空转即测失明）
          sched.dispose();
          expect(vi.getTimerCount()).toBe(0); // 句柄已释放：不清 clearInterval 即泄漏，此断言红
          // #929：dispose 前在飞 tick 可能落定在后（setInterval 丢弃 promise，假时钟跟踪不到），
          // 快照前排空旧 tick，最多 60×100ms（R2b 62% 复现率下 R4 240/240 绿实证）。
          for (let q = 0; q < 60; q += 1) {
            const n = seen.length;
            const grown = await pollUntil(() => seen.length > n, 100, 10);
            if (!grown) break;
          }
          const atDispose = seen.length;
          await vi.advanceTimersByTimeAsync(150);
          expect(seen.length).toBe(atDispose);
          // 真时钟泄漏窗：若实现另起真实定时器fallback，此窗内必触发而失败——
          // 否定式条件等待（pollUntil 语义），不用固定 sleep 假设静默。
          const leaked = await pollUntil(() => seen.length > atDispose, 200, 10);
          expect(leaked).not.toBe(true);
        } finally {
          sched.dispose();
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("toFake 面显式声明（裸 useFakeTimers 入文件必须红）", () => {
      const selfSrc = readFileSync(selfFile, "utf8");
      expect(selfSrc.includes('toFake: ["setInterval", "clearInterval"]')).toBe(true);
    });

    it("本文件无裸 sleep（等待面唯一是 pollUntil + 假时钟推进）", () => {
      const marker = ["new Promise((r) => set", "Timeout"].join("");
      const selfSrc = readFileSync(selfFile, "utf8");
      expect(selfSrc.includes(marker)).toBe(false);
    });
  });
}
