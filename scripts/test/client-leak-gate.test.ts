#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * 客户端产物宿主侧标识符门禁回归测试（issue #690 S1）。
 *
 * 为什么存在：`node:` 前缀依赖已被 build-client 的 browser 平台硬失败拦住，但只含
 * node **全局**的宿主值（`process.env` / `__dirname` / `Buffer`）会构建全绿并进产物，
 * 浏览器运行时才炸。真实产物当前全部干净——「跑出 PASS」无法证明判红有效，故用
 * 纯函数正反双向断言：泄漏形态逐项判红、external 外壳 `require("<bare>")` 放行。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertClientContract, findClientLeaks } from '../lib/client-contract-lib.ts'

test('宿主侧标识符门禁：external 外壳 require("<bare>") 不算泄漏', () => {
  const code = 'var React = __toESM(require("react"), 1);\nvar X = require("react-dom");\n'
  assert.deepEqual(findClientLeaks(code), [], '宿主提供依赖的 external 外壳必须放行')
})

test('宿主侧标识符门禁：node 全局与内置前缀逐项判红', () => {
  const cases = [
    ['node: 内置模块', 'const fs = require("node:fs");'],
    ['process 全局', 'const mode = process.env.NODE_ENV;'],
    ['__dirname', 'const p = __dirname + "/asset";'],
    ['Buffer 全局', 'const buf = Buffer.from("x");'],
  ]
  for (const [label, snippet] of cases) {
    const leaks = findClientLeaks(snippet)
    assert.ok(leaks.length > 0, `${label} 应被判为泄漏：${snippet}`)
    assert.ok(
      leaks.some((l) => l.includes(label.split(' ')[0])),
      `违例文案应点名字面量：${JSON.stringify(leaks)}`,
    )
  }
})

test('宿主侧标识符门禁：下标/别名/globalThis 等绕过写法同样判红', () => {
  // 带 `\.` 限定的匹配会被这些写法绕开（实测漏报），故清单只匹配名字本身。
  const bypasses = ['const e = process["env"];', 'const B = Buffer;', 'const p = globalThis.process;']
  for (const snippet of bypasses) {
    assert.ok(findClientLeaks(snippet).length > 0, `绕过写法应判红：${snippet}`)
  }
})

test('宿主侧标识符门禁：非 external 形态 require( 判红，且与 external 可区分', () => {
  assert.ok(findClientLeaks('const m = require("./local.js");').length > 0, '相对路径 require 应判红')
  assert.ok(findClientLeaks('const m = require("node:path");').length > 0, 'node: require 应判红')
  // 同一份产物里既有合法 external 又有泄漏时，仍必须报出泄漏。
  const mixed = 'var React = __toESM(require("react"), 1);\nconst m = require("./local.js");\n'
  assert.ok(findClientLeaks(mixed).length > 0, '混有 external 时不得整体放行')
})

test('宿主侧标识符门禁：干净产物零违例（防恒真）', () => {
  const clean = [
    'var React = __toESM(require("react"), 1);',
    'var e = React.createElement("div", null, "hi");',
    'function apply(ctx) { ctx.effect(() => () => {}); }',
  ].join('\n')
  assert.deepEqual(findClientLeaks(clean), [], '不含宿主标识符的产物必须零违例')
})

test('宿主侧标识符门禁：external 外壳不得成为绕过通道', () => {
  // `node:` 前缀由 browser 平台构建期拦下，但裸内置名、别名 require、路径 require
  // 都会进产物——它们不是「宿主注入 external」，必须逐项判红。
  const bypasses = [
    'require("fs")',
    'require("child_process")',
    'require("node:fs")',
    '__require("fs")',
    'require("/abs/x.js")',
    'require("./rel.js")',
  ]
  for (const snippet of bypasses) {
    assert.ok(findClientLeaks(snippet).length > 0, `应判红：${snippet}`)
  }
  assert.deepEqual(findClientLeaks('var React = require("react");'), [], '宿主注入依赖应放行')
})

test('宿主侧标识符门禁：__filename 判红，命中计数反映真实次数', () => {
  assert.ok(findClientLeaks('var p = __filename;').length > 0, '__filename 应判红')
  const many = Array.from({ length: 3 }, () => 'process.env.X').join(';\n')
  const leaks = findClientLeaks(many)
  assert.ok(
    leaks.some((l) => l.includes('3 处')),
    `违例文案应反映真实命中数（非恒为 1）：${JSON.stringify(leaks)}`,
  )
})

test('宿主侧标识符门禁：泄漏让契约断言整体失败（接线有效，防写死 true）', () => {
  // 与真实产物同构的最小外壳：注册 factory → materialize 后 apply/inject 合规。
  const product = (body) =>
    `window.__ModuleLoader__.load({ id: "@scope/test-pkg", factory: function (require) { ${body}; return { apply: function () {}, inject: [] } } });`
  const clean = assertClientContract('@scope/test-pkg', product('var React = require("react")'))
  assert.equal(clean.ok, true, `干净产物应整体通过：${JSON.stringify(clean.checks)}`)
  assert.deepEqual(clean.leaks, [], '干净产物不应有违例')
  // 泄漏写在**未执行的函数体**里：沙箱没有 process，直接求值会先抛 ReferenceError，
  // 那样 ok=false 由「执行无异常」提供而非泄漏检查——接线被摘掉也测不出来（假绿）。
  const leaky = assertClientContract('@scope/test-pkg', product('function inner() { return process.env.NODE_ENV }'))
  assert.equal(leaky.checks['执行无异常'], true, '用例前提：产物本身可执行，判红必须来自泄漏检查')
  assert.equal(leaky.ok, false, '泄漏必须让 ok 变成 false（否则门禁接线被摘掉也不会被发现）')
  assert.ok(leaky.leaks.length > 0, '应给出非空违例清单')
})
