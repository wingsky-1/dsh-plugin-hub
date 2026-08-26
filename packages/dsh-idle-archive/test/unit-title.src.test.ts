// @ts-nocheck
/**
 * dsh-idle-archive — unit：标题提取纯函数（titleOfAgent）。
 *
 * #83 剩余缺口结构化单测。覆盖两分支正反例：
 * - 无事件分支：agent undefined/null、无 session、events 缺失/非数组/空数组、
 *   无 session/title 事件；
 * - 有事件分支：正常提取并 trim、倒序取最新一条、data.title 非 string 跳过继续
 *   向前找、空白标题视为无标题、event 元素 null 容错。
 */
import { assert } from "./helpers.ts";
import { titleOfAgent } from "../src/index.ts";

// ---------------------------------------------------------------- 无事件分支

assert.equal(titleOfAgent(undefined), undefined, "agent undefined → undefined");
assert.equal(titleOfAgent(null), undefined, "agent null → undefined");
assert.equal(titleOfAgent({}), undefined, "无 session → undefined");
assert.equal(titleOfAgent({ session: {} }), undefined, "session 无 events → undefined");
assert.equal(titleOfAgent({ session: { events: "not-array" } }), undefined, "events 非数组 → undefined");
assert.equal(titleOfAgent({ session: { events: [] } }), undefined, "events 空数组 → undefined");
assert.equal(
  titleOfAgent({ session: { events: [{ type: "chat/complete", data: {} }, { type: "session/message", data: {} }] } }),
  undefined,
  "有事件但无 session/title → undefined",
);

// ---------------------------------------------------------------- 有事件分支

// 正常提取：取最后一条 session/title 并 trim
assert.equal(
  titleOfAgent({ session: { events: [{ type: "session/title", data: { title: "修复 gzip 压缩" } }] } }),
  "修复 gzip 压缩",
  "单条 title 提取",
);
assert.equal(
  titleOfAgent({
    session: {
      events: [
        { type: "chat/complete", data: {} },
        { type: "session/title", data: { title: "  两侧空白应去除  " } },
      ],
    },
  }),
  "两侧空白应去除",
  "提取时 trim 首尾空白",
);

// 倒序扫描：多条 title 取最新（数组尾部优先）
assert.equal(
  titleOfAgent({
    session: {
      events: [
        { type: "session/title", data: { title: "旧标题" } },
        { type: "chat/complete", data: {} },
        { type: "session/title", data: { title: "新标题" } },
      ],
    },
  }),
  "新标题",
  "多条 title 取最新（倒序扫描）",
);

// data.title 非 string：跳过该条继续向前找更早的合法 title
assert.equal(
  titleOfAgent({
    session: {
      events: [
        { type: "session/title", data: { title: "合法旧标题" } },
        { type: "session/title", data: { title: 42 } },
      ],
    },
  }),
  "合法旧标题",
  "非 string title 跳过后回落更早的合法 title",
);

// 纯空白标题：trim 后为空视为无标题 → undefined
assert.equal(
  titleOfAgent({ session: { events: [{ type: "session/title", data: { title: "   " } }] } }),
  undefined,
  "空白标题视为无",
);

// 最新条为空白标题：不回吞更早的非空标题（trim 后为空即返回 undefined）
assert.equal(
  titleOfAgent({
    session: {
      events: [
        { type: "session/title", data: { title: "旧标题" } },
        { type: "session/title", data: { title: "  " } },
      ],
    },
  }),
  undefined,
  "最新 title 为空白时不向前回吞（跟随实现语义）",
);

// event 元素 null / 缺 data：容错跳过不抛错
assert.equal(
  titleOfAgent({
    session: {
      events: [null, { type: "session/title" }, { type: "session/title", data: {} }, { type: "session/title", data: { title: "兜底标题" } }],
    },
  }),
  "兜底标题",
  "null 事件与缺 data 事件容错跳过",
);

console.log("PASS: dsh-idle-archive unit-title（titleOfAgent 无事件/有事件两分支正反例）");
