/**
 * dsh-notifier — unit：server 域 seq 计数器存储直测（#733 M1-F2）。
 *
 * createSeqStore 的实现自组合根（src/index.ts 的 loadSeq/saveSeq）**逐行等价**迁入
 * server/sse-bus.ts，本文件锁定搬迁不得改变的语义：
 * - 缺文件（ENOENT）= 首启静默回退 0，**不告警**；
 * - **合法 JSON 但值非法**（负数/小数/字符串/null/布尔/对象）→ warn「seq 计数文件损坏」+ 回退 0；
 * - **非法 JSON（解析失败）** 与其他非 ENOENT 读取失败 → warn「seq 计数文件读取失败」+ 回退 0
 *   （既有控制流：损坏文案只在 JSON.parse 成功、值校验失败时命中）；
 * - 写入为同步 tmp+rename 原子写（createSseHub 的 dispose 同步补写依赖此同步性），
 *   失败只 warn 不抛。
 *
 * 落盘全部进 mkdtempSync 隔离目录（#218 产物零污染）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSeqStore } from "../../src/server/interface.ts";

/** 记录告警的 fake logger。 */
function makeWarn() {
  const warns: string[] = [];
  return { warns, warn: (message: string) => warns.push(message) };
}

describe("(h) createSeqStore：load 续计数与回退语义", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "notifier-seq-store-"));
    file = join(dir, "seq.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("缺文件（ENOENT）→ 回退 0 且不告警（首启静默）", () => {
    const log = makeWarn();
    expect(createSeqStore({ file, warn: log.warn }).load()).toBe(0);
    expect(log.warns).toEqual([]);
  });

  it("合法非负整数 → 原样续计数", () => {
    writeFileSync(file, "42", "utf8");
    const log = makeWarn();
    expect(createSeqStore({ file, warn: log.warn }).load()).toBe(42);
    expect(log.warns).toEqual([]);
  });

  it("0 → 原样返回（边界合法）", () => {
    writeFileSync(file, "0", "utf8");
    expect(createSeqStore({ file, warn: makeWarn().warn }).load()).toBe(0);
  });

  it("非法 JSON（解析失败）→ warn「读取失败」+ 回退 0（既有控制流：损坏文案只在值校验失败时命中）", () => {
    writeFileSync(file, "{not json", "utf8");
    const log = makeWarn();
    expect(createSeqStore({ file, warn: log.warn }).load()).toBe(0);
    expect(log.warns.length).toBe(1);
    expect(log.warns[0].includes("seq 计数文件读取失败")).toBe(true);
    // 逐字等价：告警文本就是 JSON.parse 的解析错误摘要，不含额外诊断前缀
    expect(log.warns[0].startsWith("dsh-notifier: seq 计数文件读取失败，回退 0：")).toBe(true);
  });

  for (const [label, raw] of [
    ["负数", "-1"],
    ["小数", "1.5"],
    ["字符串", '"7"'],
    ["null", "null"],
    ["布尔", "true"],
    ["对象", '{"seq":3}'],
  ] as const) {
    it(`合法 JSON 但值非法（${label}）→ warn「损坏」+ 回退 0`, () => {
      writeFileSync(file, raw, "utf8");
      const log = makeWarn();
      expect(createSeqStore({ file, warn: log.warn }).load()).toBe(0);
      expect(log.warns.length).toBe(1);
      // 逐字等价：文案 + 文件路径，无额外诊断文本
      expect(log.warns[0]).toBe(`dsh-notifier: seq 计数文件损坏，回退 0：${file}`);
    });
  }

  it("读取失败非 ENOENT（路径是目录）→ warn（文案含「读取失败」）+ 回退 0", () => {
    const log = makeWarn();
    // 目录路径触发 EISDIR（非 ENOENT 分支）
    expect(createSeqStore({ file: dir, warn: log.warn }).load()).toBe(0);
    expect(log.warns.length).toBe(1);
    expect(log.warns[0].includes("seq 计数文件读取失败")).toBe(true);
  });
});

describe("(i) createSeqStore：save 原子写与失败 fail-soft", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "notifier-seq-store-"));
    file = join(dir, "seq.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("save → load 往返（同实例）", () => {
    const store = createSeqStore({ file, warn: makeWarn().warn });
    store.save(7);
    expect(store.load()).toBe(7);
  });

  it("save → load 往返（跨实例：重启续计数）", () => {
    createSeqStore({ file, warn: makeWarn().warn }).save(9);
    expect(createSeqStore({ file, warn: makeWarn().warn }).load()).toBe(9);
  });

  it("写入内容即十进制字符串（与迁出前逐字等价）", () => {
    createSeqStore({ file, warn: makeWarn().warn }).save(123);
    expect(readFileSync(file, "utf8")).toBe("123");
  });

  it("覆盖写（第二次 save 覆盖第一次，无残留）", () => {
    const store = createSeqStore({ file, warn: makeWarn().warn });
    store.save(1);
    store.save(2);
    expect(store.load()).toBe(2);
  });

  it("写入成功后目录内无 .tmp 残留（rename 原子落位）", () => {
    createSeqStore({ file, warn: makeWarn().warn }).save(5);
    expect(readdirSync(dir)).toEqual(["seq.json"]);
  });

  it("写入失败（父目录不存在）→ warn（文案含「写入失败」）且不抛", () => {
    const log = makeWarn();
    const store = createSeqStore({ file: join(dir, "missing", "seq.json"), warn: log.warn });
    expect(() => store.save(3)).not.toThrow();
    expect(log.warns.length).toBe(1);
    expect(log.warns[0].includes("seq 计数写入失败")).toBe(true);
  });
});
