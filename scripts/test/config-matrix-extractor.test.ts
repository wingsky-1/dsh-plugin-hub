#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * config-matrix-extractor 提取器自检（issue #471 P1-4：防提取器静默失效→矩阵假绿）。
 *
 * 用已知键集 fixture（迷你 TS 片段）对照提取结果，锁定三条提取路径：
 *   A. 顶层对象键提取（objOf：普通对象 / z.object 下钻 / 带类型注解 export 被
 *      esbuild 拆成普通 const + 尾部 export list / TSAs 包装 / Parenthesized）；
 *   B. 数组键提取（一维字符串数组 CONFIG_KEYS 形态 / 二维首列 EVENT_KEYS 形态）；
 *   C. normalizeConfig 分支目标键提取（base.<key> 赋值 / src.<key> 读取 /
 *      qh 子键 / === 排除表字面量——须不含 typeof 类型串误报）。
 * 另有 sourceLineOf 行号定位、booleanKeysOfObject 布尔键推导、diffKeys 差异。
 *
 * 运行：node --test scripts/test/config-matrix-extractor.test.ts（随 pnpm test:scripts）
 * 零落盘：纯内存 fixture，无任何文件写入。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseTs, findTopVar, findTopFn, objectKeysOf, arrayStringKeys, arrayFirstColKeys,
  extractNamedKeys, collectNormalizeBranchKeys, collectClientUiKeys, booleanKeysOfObject, sourceLineOf, diffKeys,
  extractReadmeConfigKeys,
} from '../lib/config-matrix-lib.ts'

// 简单 fixture：普通对象 + 数组
test('fixture: 普通对象与数组字面量键', () => {
  const ast = parseTs('const A = { x: 1, y: 2 };\nconst B = ["m", "n"];\n')
  assert.deepEqual(objectKeysOf(findTopVar(ast, 'A')), ['x', 'y'])
  assert.deepEqual(arrayStringKeys(findTopVar(ast, 'B')), ['m', 'n'])
  assert.deepEqual(extractNamedKeys('const A = { x: 1 };\n', 'A', 'object').keys, ['x'])
  assert.deepEqual(extractNamedKeys('const A = { x: 1 };\n', 'A', 'arrayStrings').keys, [])
})

// z.object 下钻（CallExpression 第一实参 ObjectExpression）
test('z.object 嵌套下钻提取（CallExpression 剥壳）', () => {
  const src = `
import z from "schemastery";
const Config = z.object({
  enabled: z.boolean().default(true),
  host: z.string(),
  nested: z.object({ a: z.string() }).default({ a: "x" }),
});
`
  const keys = extractNamedKeys(src, 'Config', 'object').keys
  assert.deepEqual(keys, ['enabled', 'host', 'nested'], '嵌套 z.object 的默认对象不得混入顶层键')
})

// 带类型注解 export const：esbuild 拆成普通 const + 尾部 export list——顶层收集须不依赖 export 形态
test('带类型注解 export const（esbuild 拆分形态）仍可提取', () => {
  const src = `
interface T { a?: boolean; b?: string }
export const Config: z<T> = z.object({
  a: z.boolean().default(true),
  b: z.string(),
});
`
  const ast = parseTs(src)
  // esbuild 拆后：顶层 VariableDeclaration（const Config）+ 尾部 export list
  assert.ok(findTopVar(ast, 'Config'), '拆后仍为顶层普通 const')
  assert.deepEqual(extractNamedKeys(src, 'Config', 'object').keys, ['a', 'b'])
})

// TSAs / Satisfies / 括号包装剥壳
test('TSAs/Satisfies/Parenthesized 包装剥壳', () => {
  const src = `
const A = { p: 1, q: 2 } as const;
const B = ({ r: 1 } satisfies Record<string, number>);
const C = ({ s: 1 });
`
  const ast = parseTs(src)
  assert.deepEqual(objectKeysOf(findTopVar(ast, 'A')), ['p', 'q'], 'as const 剥壳')
  assert.deepEqual(objectKeysOf(findTopVar(ast, 'B')), ['r'], 'satisfies 剥壳')
  assert.deepEqual(objectKeysOf(findTopVar(ast, 'C')), ['s'], '括号剥壳')
})

// 数组键：一维（CONFIG_KEYS）+ 二维首列（EVENT_KEYS）
test('一维/二维数组键提取', () => {
  const src = `
const CONFIG_KEYS: readonly string[] = ["a", "b", "c"];
const EVENT_KEYS = [
  ["notifyA", "evtA"],
  ["notifyB", "evtB"],
];
`
  const ast = parseTs(src)
  assert.deepEqual(arrayStringKeys(findTopVar(ast, 'CONFIG_KEYS')), ['a', 'b', 'c'])
  assert.deepEqual(arrayFirstColKeys(findTopVar(ast, 'EVENT_KEYS')), ['notifyA', 'notifyB'])
  assert.deepEqual(extractNamedKeys(src, 'CONFIG_KEYS', 'arrayStrings').keys, ['a', 'b', 'c'])
})

// normalizeConfig 分支目标键：base 赋值 + src 读取 + qh 子键 + === 排除表字面量；
// 不收集 typeof 类型串（object/boolean/string 误报回归锁）
test('normalizeConfig 分支目标键提取（含 typeof 类型串不误收）', () => {
  const src = `
export function normalizeConfig(input: unknown): any {
  const base: any = { ...DEFAULT_CONFIG };
  if (typeof input !== "object" || input === null) return base;
  const src = input as Record<string, unknown>;
  for (const key of CONFIG_KEYS) {
    if (typeof src[key] === "boolean") base[key] = src[key];
  }
  if (Number.isFinite(src.errorMergeWindowMs)) base.errorMergeWindowMs = Math.round(src.errorMergeWindowMs);
  if (typeof src.quietHours === "object" && src.quietHours !== null) {
    const qh = src.quietHours as Record<string, unknown>;
    if (typeof qh.enabled === "boolean") base.quietHours.enabled = qh.enabled;
    if (typeof qh.start === "string") base.quietHours.start = qh.start;
  }
  if (Array.isArray(src.channels)) base.channels = normalizeChannels(src.channels);
  const out = base;
  for (const key of Object.keys(src)) {
    if ((CONFIG_KEYS as readonly string[]).includes(key)) continue;
    if (key === "quietHours" || key === "channels") continue;
    out[key] = src[key];
  }
  return out;
}
`
  const fn = findTopFn(parseTs(src), 'normalizeConfig')
  assert.ok(fn, 'normalizeConfig 声明可定位')
  const branch = collectNormalizeBranchKeys(fn)
  // base 赋值键 = 显式归一化目标（errorMergeWindowMs/quietHours/channels）
  assert.deepEqual([...branch.members.base].sort(), ['channels', 'errorMergeWindowMs', 'quietHours'])
  // qh 子键
  assert.deepEqual([...branch.members.qh].sort(), ['enabled', 'start'])
  // union 含 src 读取键与 === 字面量；但不得含 typeof 类型串
  assert.ok(branch.union.includes('errorMergeWindowMs'))
  assert.ok(branch.union.includes('quietHours'))
  assert.ok(!branch.union.includes('object'), 'typeof 类型串 object 不得被收集')
  assert.ok(!branch.union.includes('boolean'), 'typeof 类型串 boolean 不得被收集')
  assert.ok(!branch.union.includes('string'), 'typeof 类型串 string 不得被收集')
  // eqLiterals = === "键" 判定（排除表）；同样不含类型串
  assert.deepEqual([...branch.eqLiterals].sort(), ['channels', 'quietHours'])
})

// 客户端 UI 引用键（EVENT_KEYS 首列 + builtinCard/switchControl 参数 + patch 对象键 + settings.<键>）
test('客户端 UI 引用键收集（EVENT_KEYS/内置卡/patch/settings 形态）', () => {
  const src = `
var EVENT_KEYS = [
  ["notifyAsk", "evtAsk"],
  ["notifyTurnEnd", "evtTurnEnd"],
];
function apply(ctx: any) {
  function patch(p: any) { setSettings(p); }
  function builtinCard(cfgKey: string, label: string) { return null; }
  function switchControl(key: string) { return null; }
  builtinCard("browserNotify", "x");
  extras.push(row("sound", switchControl("notifySound")));
  patch({ errorMergeWindowMs: Number(x) });
  patch({ quietHours: { enabled: true } });
  var qh = settings.quietHours || {};
  chPatch(idx, { sound: v }); // 频道子键——不得收集
}
`
  const ui = collectClientUiKeys(parseTs(src))
  assert.ok(ui.includes('notifyAsk') && ui.includes('notifyTurnEnd'), 'EVENT_KEYS 首列')
  assert.ok(ui.includes('browserNotify'), 'builtinCard 参数')
  assert.ok(ui.includes('notifySound'), 'switchControl 参数')
  assert.ok(ui.includes('errorMergeWindowMs') && ui.includes('quietHours'), 'patch 字面量对象键')
  assert.ok(ui.includes('quietHours'), 'settings.<键> 引用')
  assert.ok(!ui.includes('sound'), 'chPatch 频道子键不得收集')
})

// sourceLineOf 行号（1-based，含 export 前缀）
test('sourceLineOf 定位声明行号', () => {
  const src = '// 注释\n\nconst A = {};\nexport const Config = z.object({});\nfunction normalizeConfig() {}\n'
  assert.equal(sourceLineOf(src, 'A'), 3)
  assert.equal(sourceLineOf(src, 'Config'), 4)
  assert.equal(sourceLineOf(src, 'normalizeConfig'), 5)
  assert.equal(sourceLineOf(src, 'NotExist'), null)
})

// booleanKeysOfObject：从默认值字面量推导布尔键
test('booleanKeysOfObject 从对象值推导布尔键', () => {
  const src = 'const D = { a: true, b: false, c: 3, d: "x", e: { f: true } };'
  const ast = parseTs(src)
  assert.deepEqual(booleanKeysOfObject(findTopVar(ast, 'D')), ['a', 'b'], '仅顶层布尔字面量键')
})

// diffKeys
test('diffKeys 缺/多键', () => {
  const d = diffKeys(['a', 'b', 'c'], ['a', 'c', 'z'])
  assert.deepEqual(d.missing, ['b'])
  assert.deepEqual(d.extra, ['z'])
})

// README 配置键提取（量级 #12：lan-proxy 表 + notifier JSON + 合并键 + 噪音免疫）
test('README lan-proxy 配置表键提取（含合并键、排除非键 token）', () => {
  const readme = `## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| \`enabled\` | \`true\` | 总开关 |
| \`tlsCertFile\` / \`tlsKeyFile\` | 无 | 证书 |
| \`wsCompressPaths\` | \`/api/remote.mux\` | 白名单（见 \`GET /health\`） |
| \`httpCompressLevel\` | \`1\` | 档位 |
`
  const { keys } = extractReadmeConfigKeys(readme, 'lan-proxy')
  assert.deepEqual(keys, ['enabled', 'tlsCertFile', 'tlsKeyFile', 'wsCompressPaths', 'httpCompressLevel'])
})

test('README notifier JSON 样例键提取（仅顶层键）', () => {
  const readme = `## 配置

\`\`\`json
{
  "notifyAsk": true,
  "quietHours": { "enabled": false },
  "channels": []
}
\`\`\`
`
  const { keys } = extractReadmeConfigKeys(readme, 'notifier')
  assert.deepEqual(keys, ['notifyAsk', 'quietHours', 'channels'])
})
