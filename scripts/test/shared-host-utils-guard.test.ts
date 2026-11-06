// @ts-check
/**
 * shared/host-utils.js — guardLoopbackMethod 守卫单测（issue #473 批 1）。
 *
 * 载体：CI `pnpm test:scripts`（.github/workflows/ci.yml test:scripts 步骤；
 * 本地门禁同命令）。命名与 #472 的 shared-host-utils.test.ts 错开（S1），
 * 各测各的函数互不覆盖。
 *
 * 覆盖（#473 方案 v2 G4①/R6）：
 * - 403 文案逐字节：非 loopback → `{"error":"forbidden: loopback-only"}` + false；
 * - 405 文案逐字节：方法不在白名单 → `{"error":"method not allowed: <METHOD>"}`
 *   + false（多方法插值全覆盖）；
 * - 无 method 字段（fakeReq 缺省覆盖）→ 405 + `method not allowed: undefined`
 *   ——锚定 fail-closed（R6：防未来实现加回 `?? "GET"` 宽松归一化）；
 * - 放行正例：loopback + 白名单内方法 → true 且不写响应。
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  admitLongLivedRequest,
  bindPeerLifecycle,
  guardLoopbackMethod,
  isLoopbackRequest,
  liveConnectionAdmission,
  liveConnectionPeerAdmission,
  routeFenceRejection,
  type RemoteAdmissionSource,
  type RemotePeerAdmissionSource,
} from "../../shared/host-utils.js";

/**
 * 请求桩的最小面：守卫只读 method / socket.remoteAddress / headers，IncomingMessage
 * 其余 65+ 个成员单测既构造不出也不读，故按这个面建桩后经 unknown 收窄。
 */
interface ReqStub {
  method?: string;
  socket: { remoteAddress: string };
  headers: Record<string, string>;
}

/** loopback 合法请求桩；overrides 逐键覆盖顶层字段。 */
function fakeReq(overrides: Partial<ReqStub> = {}): IncomingMessage {
  return {
    method: "GET",
    socket: { remoteAddress: "127.0.0.1" },
    headers: { host: "127.0.0.1:3080", "sec-fetch-site": "same-origin" },
    ...overrides,
  } as unknown as IncomingMessage;
}

/** 响应收集桩：rec.status / rec.body（writeJson 经 writeHead+end 落字）。 */
function fakeRes(): { rec: { status: number; body: string }; res: ServerResponse } {
  const rec = { status: 0, body: "" };
  return {
    rec,
    res: {
      writeHead(status: number) {
        rec.status = status;
      },
      end(payload?: unknown) {
        if (payload !== undefined) rec.body += String(payload);
      },
    } as unknown as ServerResponse,
  };
}

test("非 loopback → 403 + 逐字节文案 + false", () => {
  const { rec, res } = fakeRes();
  const allow = guardLoopbackMethod(fakeReq({ socket: { remoteAddress: "10.0.0.2" } }), res, [
    "GET",
  ]);
  assert.equal(allow, false, "非 loopback 返回 false");
  assert.equal(rec.status, 403);
  assert.equal(rec.body, '{"error":"forbidden: loopback-only"}', "403 body 逐字节");
});

test("loopback Host 不合法 → 403 + 逐字节文案 + false", () => {
  const { rec, res } = fakeRes();
  const allow = guardLoopbackMethod(fakeReq({ headers: { host: "evil.example:3080" } }), res, [
    "GET",
  ]);
  assert.equal(allow, false);
  assert.equal(rec.status, 403);
  assert.equal(rec.body, '{"error":"forbidden: loopback-only"}', "403 body 逐字节");
});

test("loopback + 方法不在白名单 → 405 + 逐字节文案 + false", () => {
  // 用例表显式标注：不标注时解构出的是 string | string[]，会把守卫的方法/白名单入参面逼宽
  const cases: Array<[string, string[]]> = [
    ["POST", ["GET"]],
    ["DELETE", ["GET", "PUT"]],
    ["PATCH", ["GET", "POST"]],
    ["PUT", ["GET", "POST"]],
    ["OPTIONS", ["GET"]],
  ];
  for (const [method, whitelist] of cases) {
    const { rec, res } = fakeRes();
    const allow = guardLoopbackMethod(fakeReq({ method }), res, whitelist);
    assert.equal(allow, false, `${method} 不在 [${whitelist}] 返回 false`);
    assert.equal(rec.status, 405, `${method} → 405`);
    assert.equal(
      rec.body,
      `{"error":"method not allowed: ${method}"}`,
      `${method} 405 body 逐字节`,
    );
  }
});

test("无 method 字段 → 405 + method not allowed: undefined（fail-closed，R6）", () => {
  const { rec, res } = fakeRes();
  const { method, ...noMethod } = fakeReq();
  assert.equal(method, "GET", "前置：桩本有 method，此处刻意删除");
  // 刻意喂「无 method 字段」的畸形请求来锚定 fail-closed（R6）：畸形输入单测里必须存在，
  // 故经 unknown 显式收窄回 IncomingMessage，而不是改小被测物的入参面。
  const allow = guardLoopbackMethod(noMethod as unknown as IncomingMessage, res, ["GET"]);
  assert.equal(allow, false, "无 method 字段不放行（fail-closed）");
  assert.equal(rec.status, 405);
  assert.equal(
    rec.body,
    '{"error":"method not allowed: undefined"}',
    "405 body 逐字节锚定 undefined 插值",
  );
});

test("loopback + 白名单内方法 → true 放行且不写响应", () => {
  const cases: Array<[string, string[]]> = [
    ["GET", ["GET"]],
    ["GET", ["GET", "PUT"]],
    ["PUT", ["GET", "PUT"]],
    ["POST", ["GET", "POST"]],
    ["DELETE", ["GET", "DELETE"]],
  ];
  for (const [method, whitelist] of cases) {
    const { rec, res } = fakeRes();
    const allow = guardLoopbackMethod(fakeReq({ method }), res, whitelist);
    assert.equal(allow, true, `${method} ∈ [${whitelist}] 放行`);
    assert.equal(rec.status, 0, "放行时不写任何响应");
    assert.equal(rec.body, "", "放行时不写任何 body");
  }
});

// ---- issue #549：serve 围栏放宽（cross-site no-cors 子资源）----

/** 构造带指定 Fetch Metadata 头的回环请求；site / mode 为 undefined 时即该头缺席。 */
function metaReq(site?: string, mode?: string): IncomingMessage {
  const headers: Record<string, string> = { host: "127.0.0.1:3080" };
  if (site !== undefined) headers["sec-fetch-site"] = site;
  if (mode !== undefined) headers["sec-fetch-mode"] = mode;
  return {
    method: "GET",
    socket: { remoteAddress: "127.0.0.1" },
    headers,
  } as unknown as IncomingMessage;
}

test("#549 默认（无 options）拒绝一切 cross-site", () => {
  for (const mode of ["no-cors", "cors", "navigate", undefined]) {
    assert.equal(
      isLoopbackRequest(metaReq("cross-site", mode)),
      false,
      `cross-site + mode=${mode} 默认拒绝`,
    );
  }
});

test("#549 allowCrossSiteNoCors：显式 no-cors 跨站子资源放行", () => {
  const allow = isLoopbackRequest(metaReq("cross-site", "no-cors"), { allowCrossSiteNoCors: true });
  assert.equal(allow, true, "cross-site + no-cors → 放行（serve 子资源）");
});

test("#549 allowCrossSiteNoCors：cross-site 但非 no-cors 仍拒绝（fail-closed）", () => {
  for (const mode of ["cors", "navigate", undefined]) {
    assert.equal(
      isLoopbackRequest(metaReq("cross-site", mode), { allowCrossSiteNoCors: true }),
      false,
      `cross-site + mode=${mode} 即使允许 no-cors 也拒绝`,
    );
  }
});

test("#549 非跨站（same-origin / same-site / none / 无头）行为不变", () => {
  for (const site of ["same-origin", "same-site", "none", undefined]) {
    for (const opts of [undefined, { allowCrossSiteNoCors: true }]) {
      assert.equal(isLoopbackRequest(metaReq(site, "no-cors"), opts), true, `site=${site} 放行`);
    }
  }
});

test("#549 guardLoopbackMethod 透传 allowCrossSiteNoCors（serve 路由形态）", () => {
  const { rec, res } = fakeRes();
  const allow = guardLoopbackMethod(
    fakeReq({
      headers: {
        host: "127.0.0.1:3080",
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "no-cors",
      },
    }),
    res,
    ["GET"],
    { allowCrossSiteNoCors: true },
  );
  assert.equal(allow, true, "serve 路由经守卫透传放行 cross-site no-cors");
  assert.equal(rec.status, 0, "放行时不写响应");
});

test("#549 guardLoopbackMethod 不透传时 cross-site 仍 403", () => {
  const { rec, res } = fakeRes();
  const allow = guardLoopbackMethod(
    fakeReq({
      headers: {
        host: "127.0.0.1:3080",
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "no-cors",
      },
    }),
    res,
    ["GET"],
  );
  assert.equal(allow, false, "不传 options 的守卫仍拒绝 cross-site");
  assert.equal(rec.status, 403);
});

// ---- rc.1 native LAN：非回环路径复用官方 connection admission ----

function remoteReq(overrides: Partial<ReqStub> = {}): IncomingMessage {
  return fakeReq({
    socket: { remoteAddress: "10.0.0.2" },
    headers: { host: "10.0.0.2:3080" },
    ...overrides,
  });
}

test("非回环：官方 admission undefined 后按方法白名单放行", () => {
  const { rec, res } = fakeRes();
  const allow = guardLoopbackMethod(remoteReq(), res, ["GET"], {
    remoteAdmission: () => () => undefined,
  });
  assert.equal(allow, true);
  assert.equal(rec.status, 0);
  assert.equal(rec.body, "");
});

test("非回环：401/403 原样返回且先于方法白名单", () => {
  for (const status of [401, 403] as const) {
    const { rec, res } = fakeRes();
    const allow = guardLoopbackMethod(remoteReq({ method: "DELETE" }), res, ["GET"], {
      remoteAdmission: () => () => status,
    });
    assert.equal(allow, false, `${status} 不放行`);
    assert.equal(rec.status, status);
    assert.equal(
      rec.body,
      status === 401 ? '{"error":"unauthorized"}' : '{"error":"forbidden: loopback-only"}',
    );
  }
});

test("非回环：认证通过后才检查方法，错方法 405", () => {
  const { rec, res } = fakeRes();
  const allow = guardLoopbackMethod(remoteReq({ method: "POST" }), res, ["GET"], {
    remoteAdmission: () => () => undefined,
  });
  assert.equal(allow, false);
  assert.equal(rec.status, 405);
  assert.equal(rec.body, '{"error":"method not allowed: POST"}');
});

test("非回环：admission 缺失、异常或返回未知值均 fail-closed 403", () => {
  const cases: Array<[string, RemoteAdmissionSource | undefined]> = [
    ["source missing", undefined],
    ["source returns missing", () => undefined],
    [
      "source throws",
      () => {
        throw new Error("connection unloaded");
      },
    ],
    [
      "admission throws",
      () => () => {
        throw new Error("admission failed");
      },
    ],
    ["admission returns unknown", () => (() => 500) as unknown as () => 401 | 403 | undefined],
  ];
  for (const [name, remoteAdmission] of cases) {
    const { rec, res } = fakeRes();
    const allow = guardLoopbackMethod(remoteReq({ method: "GET" }), res, ["GET"], {
      remoteAdmission,
    });
    assert.equal(allow, false, `${name} 不放行`);
    assert.equal(rec.status, 403, `${name} → 403`);
  }
});

test("liveConnectionAdmission 每次请求实时读取 connection，卸载后旧对象不能继续放行", () => {
  let reads = 0;
  let connection: unknown = {
    requestRejection() {
      return undefined;
    },
  };
  const source = liveConnectionAdmission({
    get(name, strict) {
      assert.equal(name, "connection");
      assert.equal(strict, false);
      reads += 1;
      return connection;
    },
  });

  assert.equal(routeFenceRejection(remoteReq(), { remoteAdmission: source }), undefined);
  connection = undefined;
  assert.equal(routeFenceRejection(remoteReq(), { remoteAdmission: source }), 403);
  assert.equal(reads, 2, "每次请求都重新读取 Context");
});

test("liveConnectionAdmission 不丢失 service this，Context 读取抛错时 fail-closed", () => {
  const connection = {
    marker: "current",
    requestRejection(this: { marker: string }) {
      return this.marker === "current" ? undefined : 403;
    },
  };
  const source = liveConnectionAdmission({ get: () => connection });
  assert.equal(routeFenceRejection(remoteReq(), { remoteAdmission: source }), undefined);

  const broken = liveConnectionAdmission({
    get() {
      throw new Error("scope disposed");
    },
  });
  assert.equal(routeFenceRejection(remoteReq(), { remoteAdmission: broken }), 403);
});

test("非回环 Host/Origin/cross-site 由官方 admission 继续围栏", () => {
  const officialLikeFence = (req: IncomingMessage): 401 | 403 | undefined => {
    if (req.headers["sec-fetch-site"] === "cross-site") return 403;
    if (req.headers.origin !== undefined) {
      try {
        if (new URL(req.headers.origin).host !== req.headers.host) return 403;
      } catch {
        return 403;
      }
    }
    return 401;
  };
  const options = { remoteAdmission: () => officialLikeFence };
  assert.equal(routeFenceRejection(remoteReq(), options), 401);
  assert.equal(
    routeFenceRejection(
      remoteReq({
        headers: {
          host: "10.0.0.2:3080",
          origin: "https://attacker.example",
        },
      }),
      options,
    ),
    403,
  );
  assert.equal(
    routeFenceRejection(
      remoteReq({
        headers: {
          host: "10.0.0.2:3080",
          "sec-fetch-site": "cross-site",
        },
      }),
      options,
    ),
    403,
  );
});

test("长连接 admission：loopback 不绑定 Peer，非回环保留官方 PeerScope", () => {
  assert.deepEqual(admitLongLivedRequest(fakeReq()), {});

  let peerCleanupCalls = 0;
  const peer = {
    ctx: {
      effect(_execute: () => () => void) {
        peerCleanupCalls += 1;
        return () => {};
      },
    },
  };
  assert.deepEqual(
    admitLongLivedRequest(remoteReq(), {
      remotePeerAdmission: () => () => ({ peer }),
    }),
    { peer },
  );
  assert.equal(peerCleanupCalls, 0, "admission 本身不注册 effect");
});

test("长连接 admission：401/403 保持，缺失/异常/未知结果 fail-closed", () => {
  for (const status of [401, 403] as const) {
    assert.deepEqual(
      admitLongLivedRequest(remoteReq(), {
        remotePeerAdmission: () => () => ({ rejection: status }),
      }),
      { rejection: status },
    );
  }
  const cases: Array<RemotePeerAdmissionSource | undefined> = [
    undefined,
    () => undefined,
    () => {
      throw new Error("connection unloaded");
    },
  ];
  for (const source of cases) {
    assert.deepEqual(admitLongLivedRequest(remoteReq(), { remotePeerAdmission: source }), {
      rejection: 403,
    });
  }
  const invalid = (() => ({ peer: {} })) as unknown as () => { peer: never };
  assert.deepEqual(admitLongLivedRequest(remoteReq(), { remotePeerAdmission: () => invalid }), {
    rejection: 403,
  });
});

test("peer lifecycle：官方 ctx effect 释放与客户端 disposer 都能移除长连接", () => {
  let effectDisposed = false;
  let releasePeer: (() => void) | undefined;
  const peer = {
    ctx: {
      effect(execute: () => () => void, label?: string) {
        assert.equal(label, "probe: stream");
        const cleanup = execute();
        releasePeer = () => {
          if (effectDisposed) return;
          effectDisposed = true;
          cleanup();
        };
        return releasePeer;
      },
    },
  };
  let cleanups = 0;
  const dispose = bindPeerLifecycle(
    peer,
    () => {
      cleanups += 1;
    },
    "probe: stream",
  );
  releasePeer?.();
  assert.equal(cleanups, 1, "Peer 释放执行清理");
  dispose();
  assert.equal(cleanups, 1, "官方 disposer 幂等，客户端断开的 disposer 不重复清理");
});

test("liveConnectionPeerAdmission 每次连接请求现读 connection 并校验 admit 结果", () => {
  let reads = 0;
  const peer = { ctx: { effect: () => () => {} } };
  let connection: unknown = {
    admit(this: { marker: string }, req: IncomingMessage) {
      assert.equal(this.marker, "current");
      return req.headers.cookie === "valid" ? { peer } : { rejection: 401 };
    },
    marker: "current",
  };
  const source = liveConnectionPeerAdmission({
    get() {
      reads += 1;
      return connection;
    },
  });
  assert.deepEqual(source()?.(remoteReq({ headers: { host: "10.0.0.2:3080", cookie: "valid" } })), {
    peer,
  });
  connection = undefined;
  assert.equal(source(), undefined, "connection 卸载后不得复用旧 Peer admission");
  assert.equal(reads, 2);
});
