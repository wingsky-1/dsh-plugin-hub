// @ts-nocheck
/**
 * dsh-lan-proxy — 两端路由契约（issue #911，客户端层归属）。
 *
 * CLIENT_ROUTES（客户端镜像）与宿主 ROUTES 值全等：两边各写一份的失败形态
 * 是静默的（对不上只表现成请求 404），故在此处以第二事实源锁定。
 * 本文件居 test/client-unit（客户端纯逻辑层）：test/unit 不得直引 src/client
 * 实现面（verify-dir-imports I8① unitImportFaceViolations），宿主 ROUTES 的
 * 引用方在此层允许（判据面只看客户端常量，宿主侧是被比较的期望源）。
 */
import { describe, expect, it } from "vitest";
import { ROUTES } from "../../src/server/config/impl/routes.ts";
import { CLIENT_ROUTES } from "../../src/client/shared/contract.ts";

describe("两端路由契约", () => {
  it("CLIENT_ROUTES 与宿主 ROUTES 值全等（含 caCert/caGenerate）", () => {
    expect({ ...CLIENT_ROUTES }).toEqual({
      config: ROUTES.config,
      health: ROUTES.health,
      caCert: ROUTES.caCert,
      caGenerate: ROUTES.caGenerate,
    });
  });
});
