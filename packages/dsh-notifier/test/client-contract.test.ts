// @ts-nocheck
/**
 * dsh-notifier — e2e：客户端契约与两端路由一致性。
 *
 * 覆盖：assertClientSourceContract / assertClientProductContract（共享
 * smoke-lib，与 contract-check 同源）；lib/client.js 中出现的路由字面量
 * 与宿主 ROUTES 常量双向一致。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assert } from "./helpers.ts";
import { assertClientProductContract, assertClientSourceContract } from "../../../test/smoke-lib.ts";
import { ROUTES } from "../lib/index.js";

const pkgDir = fileURLToPath(new URL("..", import.meta.url));

{
  const client = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  // 客户端契约（共享 smoke-lib：源形态 + 执行契约，与 contract-check 同源）
  assertClientSourceContract(pkgDir);
  assertClientProductContract(pkgDir);
  const literals = [...client.matchAll(/\/api\/dsh-notifier\/[a-z-]+/g)].map((m) => m[0]);
  const expected = Object.values(ROUTES);
  for (const literal of literals) assert.ok(expected.includes(literal), `client 出现未知路由: ${literal}`);
  for (const route of expected) assert.ok(literals.includes(route), `client 缺少路由: ${route}`);
}
