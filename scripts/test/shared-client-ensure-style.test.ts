#!/usr/bin/env node
// @ts-nocheck
'use strict'

/**
 * shared/client/ensure-style.js 单测（issue #477 验收 2）。
 *
 * 自写 DOM 桩（无 jsdom，复用 #487 documentStub 形态延伸）：head 为容器数组、
 * createElement 返回最小 Element（id/dataset/textContent 记录 + remove() 从
 * 容器摘除并计数）、getElementById 按 id 索引。
 *
 * 覆盖七项契约（对照方案 v2 验收 2）：
 *   1. 首次注入（head append 1 节点，textContent=cssText）；
 *   2. 同 id 幂等（重复调用仅 1 节点，不重建）；
 *   3. version 变化 → 旧节点 remove 重建（热更新失效语义）；
 *   4. 同 version → 不重建（节点引用不变、cssText 不覆盖）；
 *   5. 无 version → 不写 dataset.version；
 *   6. head 缺失 → 静默 return 不抛（no-op）；
 *   7. remove（disposer 卸载）后再 ensureStyle → 重新注入。
 *
 * 运行：node --test scripts/test/shared-client-ensure-style.test.ts（或 pnpm test:scripts）
 * 零落盘：纯内存行为测试，无任何文件写入。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ensureStyle } from '../../shared/client/ensure-style.js'

/** 最小 DOM 桩：head 容器数组 + 按 id 索引 + createElement/remove 计数。 */
function makeDom() {
  const counts = { created: 0, removed: 0, appended: 0 }
  const byId = new Map()
  const nodes = []
  const head = []
  function makeNode(tag) {
    const node = {
      tag,
      id: '',
      textContent: '',
      dataset: {},
      parentElement: null,
      remove() {
        counts.removed += 1
        const i = nodes.indexOf(node)
        if (i !== -1) nodes.splice(i, 1)
        const hi = head.indexOf(node)
        if (hi !== -1) head.splice(hi, 1)
        if (node.id !== '' && byId.get(node.id) === node) byId.delete(node.id)
        node.parentElement = null
      },
    }
    return node
  }
  const documentStub = {
    head,
    getElementById(id) {
      return byId.get(id) ?? null
    },
    createElement(tag) {
      counts.created += 1
      const node = makeNode(tag)
      nodes.push(node)
      return node
    },
  }
  // appendChild 由 head 容器承接（ensureStyle 只用 document.head.appendChild）
  documentStub.head.appendChild = (node) => {
    counts.appended += 1
    node.parentElement = head
    head.push(node)
    if (node.id !== '') byId.set(node.id, node)
  }
  return { document: documentStub, counts, head, nodes }
}

/** 在桩环境下跑一步（临时替换全局 document，跑完还原）。 */
function withDom(dom, fn) {
  const prev = globalThis.document
  globalThis.document = dom.document
  try {
    fn()
  } finally {
    globalThis.document = prev
  }
}

const CSS_A = '.x{color:red}'
const CSS_B = '.x{color:blue}'

test('首次注入：head 挂 1 个 style 节点，id/cssText 落位', () => {
  const dom = makeDom()
  withDom(dom, () => {
    const dispose = ensureStyle({ id: 'dsh-demo-style', cssText: CSS_A })
    assert.equal(typeof dispose, 'function', '返回 disposer')
    assert.equal(dom.head.length, 1)
    assert.equal(dom.nodes[0].tag, 'style')
    assert.equal(dom.nodes[0].id, 'dsh-demo-style')
    assert.equal(dom.nodes[0].textContent, CSS_A)
  })
})

test('同 id 幂等：重复调用仅 1 节点，不重建', () => {
  const dom = makeDom()
  withDom(dom, () => {
    ensureStyle({ id: 'dsh-demo-style', cssText: CSS_A })
    ensureStyle({ id: 'dsh-demo-style', cssText: CSS_A })
    assert.equal(dom.head.length, 1)
    assert.equal(dom.counts.created, 1, '只 createElement 一次')
    assert.equal(dom.counts.removed, 0, '未触发重建 remove')
  })
})

test('version 变化 → 旧节点 remove 后重建（热更新失效）', () => {
  const dom = makeDom()
  withDom(dom, () => {
    ensureStyle({ id: 'dsh-demo-style', cssText: CSS_A, version: '1' })
    const first = dom.nodes[0]
    assert.equal(first.dataset.version, '1')
    ensureStyle({ id: 'dsh-demo-style', cssText: CSS_B, version: '2' })
    assert.equal(dom.head.length, 1, '重建后仍单节点')
    assert.equal(dom.counts.removed, 1, '旧节点被 remove')
    assert.notEqual(dom.nodes[0], first, '节点已换新')
    assert.equal(dom.nodes[0].textContent, CSS_B, '新 cssText 生效')
    assert.equal(dom.nodes[0].dataset.version, '2')
  })
})

test('同 version → 不重建（节点引用不变、cssText 不覆盖）', () => {
  const dom = makeDom()
  withDom(dom, () => {
    ensureStyle({ id: 'dsh-demo-style', cssText: CSS_A, version: '1' })
    const first = dom.nodes[0]
    ensureStyle({ id: 'dsh-demo-style', cssText: CSS_B, version: '1' })
    assert.equal(dom.nodes[0], first, '同一节点')
    assert.equal(dom.nodes[0].textContent, CSS_A, 'cssText 未被覆盖')
    assert.equal(dom.counts.created, 1)
  })
})

test('无 version → 不写 dataset.version', () => {
  const dom = makeDom()
  withDom(dom, () => {
    ensureStyle({ id: 'dsh-demo-style', cssText: CSS_A })
    assert.equal(Object.keys(dom.nodes[0].dataset).length, 0, 'dataset.version 不存在')
  })
})

test('head 缺失 → 静默 return 不抛（no-op），返回函数可安全调用', () => {
  const dom = makeDom()
  dom.document.head = null
  withDom(dom, () => {
    assert.doesNotThrow(() => {
      const dispose = ensureStyle({ id: 'dsh-demo-style', cssText: CSS_A })
      assert.equal(typeof dispose, 'function')
      dispose()
    }, 'head 缺失路径连同返回的 disposer 都不抛')
    assert.equal(dom.counts.created, 0, '未创建节点')
    assert.equal(dom.counts.appended, 0, '未 append')
  })
})

test('remove（disposer 卸载）后再 ensureStyle → 重新注入', () => {
  const dom = makeDom()
  withDom(dom, () => {
    const dispose = ensureStyle({ id: 'dsh-demo-style', cssText: CSS_A })
    assert.equal(dom.head.length, 1)
    dispose()
    assert.equal(dom.head.length, 0, '卸载后节点摘除')
    assert.equal(dom.counts.removed, 1)
    dispose()
    assert.equal(dom.counts.removed, 1, 'disposer 幂等：二次调用 no-op 不抛')
    ensureStyle({ id: 'dsh-demo-style', cssText: CSS_A })
    assert.equal(dom.head.length, 1, '卸载后再次调用重新注入（幂等键复位）')
  })
})

test('参数契约：id/cssText 缺失抛 TypeError（编程错误 fail-loud）', () => {
  assert.throws(() => ensureStyle({ cssText: CSS_A }), TypeError)
  assert.throws(() => ensureStyle({ id: 'x' }), TypeError)
  assert.throws(() => ensureStyle({ id: '', cssText: CSS_A }), TypeError)
})
