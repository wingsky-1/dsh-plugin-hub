// @ts-nocheck
/**
 * dsh-web-file-preview — unit：serve token 生命周期（serve-tokens 纯逻辑，无 node:http 依赖）。
 *
 * 覆盖：alloc 全生命周期、get 命中刷新 idle 计时、TTL 超时懒回收、时钟回拨 cutoff
 * 兜底、release 幂等、size / snapshot、LRU 不淘汰活跃、全活跃拒绝、达上限腾位——
 * 与 smoke #73 B 组断言互补（smoke 走真实路由，本文件直测 store 分支）。
 */
import { assert } from "./helpers.ts";
import { createTokenStore } from "../lib/index.js";

// ---------------------------------------------------------------- alloc / get 基础生命周期

{
  let now = 1_000;
  const store = createTokenStore({ now: () => now, ttlMs: 100, maxTokens: 3, activeWindowMs: 20 });
  const token = store.alloc("/root/a");
  assert.equal(typeof token, "string", "alloc 返回 token");
  assert.equal(token.length, 32, "token 为 128-bit hex");
  assert.equal(store.size(), 1, "alloc 后 size=1");
  assert.deepEqual(store.snapshot().get(token), { root: "/root/a", lastHit: 1_000 }, "snapshot 保存完整条目");
  const hit = store.get(token);
  assert.ok(hit !== undefined && hit.root === "/root/a", "get 命中返回 root");
  // 命中刷新 idle 计时：推进到临近 TTL 仍存活，且 lastHit 被刷新
  now = 1_015;
  assert.equal(store.get(token).lastHit, 1_015, "get 命中刷新 lastHit（idle 语义）");
  // snapshot 是独立副本：外部删改不影响 store
  const snap = store.snapshot();
  snap.delete(token);
  assert.equal(store.size(), 1, "snapshot 删改不影响 store");
  // 闲置超过 TTL：访问时懒回收（lastHit 最后一次 get 刷新为 1_015；
  // TTL=100 → 需 now ≥ 1_116 才满足 lastHit < cutoff，即 idle 满 100ms）
  now = 1_116;
  assert.equal(store.get(token), undefined, "闲置超过 TTL → 访问时回收");
  assert.equal(store.size(), 0, "TTL 回收减少 size");
  assert.equal(store.release(token), false, "释放未知 token 返回 false");
  assert.equal(store.release(token), false, "release 幂等（第二次仍 false）");
}

// ---------------------------------------------------------------- 时钟回拨 cutoff 兜底

{
  let now = 2_000;
  const store = createTokenStore({ now: () => now, ttlMs: 100, maxTokens: 2, activeWindowMs: 20 });
  const token = store.alloc("/root/clock");
  // 推进时钟使 maxClockSeen=2_050（alloc 已令 maxClockSeen=2_000，get 后 2_050）
  now = 2_050;
  assert.ok(store.get(token), "推进时钟后 token 可命中");
  // 回拨到 alloc 之前：cutoff=maxClockSeen-TTL=1_950，entry.lastHit=2_050 不 < 1_950
  // ——证明 cutoff 用见过的最大时钟而非当前时钟，回拨不会把"未来"的 token 复活
  now = 1_500;
  const afterRewind = store.get(token);
  assert.ok(afterRewind !== undefined, "回拨后 token 仍按 maxClockSeen 截止不被复活");
  assert.equal(afterRewind.lastHit, 1_500, "回拨后 lastHit 被本次 get 写成回拨后的时间");
}

// ---------------------------------------------------------------- LRU：不淘汰活跃 / 淘汰最久非活跃 / 达上限腾位

{
  let now = 10_000;
  const store = createTokenStore({ now: () => now, ttlMs: 10_000, maxTokens: 2, activeWindowMs: 10 });
  const old = store.alloc("/root/old");
  now += 20;
  const active = store.alloc("/root/active");
  assert.equal(store.size(), 2, "达到上限前两个 token 并存");
  now += 1;
  assert.ok(store.get(active), "活跃 token 命中（刷新 idle）");
  const replacement = store.alloc("/root/new");
  assert.ok(replacement, "达上限且有非活跃项 → 腾位成功");
  assert.equal(store.get(old), undefined, "LRU 淘汰最久未用且非活跃的 token");
  assert.ok(store.get(active), "LRU 不淘汰活跃 token");
  assert.equal(store.size(), 2, "淘汰后 size 仍为上限");
}

// ---------------------------------------------------------------- 全活跃拒绝 / 活跃窗口过后可腾位

{
  let now = 20_000;
  const store = createTokenStore({ now: () => now, ttlMs: 10_000, maxTokens: 2, activeWindowMs: 100 });
  const a = store.alloc("/root/a");
  const b = store.alloc("/root/b");
  assert.equal(store.alloc("/root/c"), null, "全部活跃且达上限 → 拒绝新分配");
  now += 101; // 两个 token 都老化出活跃窗口 → 下次分配可淘汰腾位
  assert.ok(store.alloc("/root/c"), "活跃窗口过去后 → 可淘汰腾位分配");
  // 腾位时淘汰最久未用的非活跃 a（a/b 同为 lastHit=20_000，按插入序先淘汰 a）
  assert.equal(store.get(a), undefined, "腾位时淘汰最久未用且非活跃的 a");
  assert.equal(store.release(a), false, "a 已淘汰 → release false");
  assert.equal(store.release(b), true, "release 存在 token（b）→ true");
  assert.equal(store.release(b), false, "release 同 token 第二次 → false");
}

console.log("PASS unit-serve-tokens");
