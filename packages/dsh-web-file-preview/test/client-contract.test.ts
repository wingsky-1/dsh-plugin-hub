// @ts-nocheck
/**
 * dsh-web-file-preview — 宿主入口与客户端产物契约（issue #698 重定位后）。
 *
 * 插件只剩一件事：把对话内「用默认应用打开」的文件请求改写成官方右侧栏预览。宿主不再
 * 注册路由、不读文件，故此处只覆盖：宿主入口契约、客户端产物契约与收口所需的字面量。
 * 收口逻辑本身的断言在 unit-present-open（纯函数）与 client-present-redirect（vm 夹具
 * 跑真实 lib/client.js）中——两者已由包内 `test/*.test.ts` glob 直接执行，故此处不再
 * import 聚合（#690 S2 迁 node --test 后聚合入口已删除，重复 import 会让同一文件在同进程内跑两遍）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { ROUTES } from "../lib/index.js";
import { assertClientProductContract, assertClientSourceContract } from "../../../test/smoke-lib.ts";

const pkgDir = fileURLToPath(new URL("..", import.meta.url));

assert.deepEqual(ROUTES, {}, "#698 宿主不再注册任何路由（自建数据面已随重定位删除）");

// 客户端产物契约（load id / IIFE 外壳 / apply+inject 装配 / factory 形态）
assertClientSourceContract(pkgDir);
assertClientProductContract(pkgDir);

// 收口依赖的三处官方契约字面量必须进产物：官方打开路由、官方地址前缀、官方卡片锚点。
const client = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
assert.ok(client.includes("/api/present.open"), "#698 client 含官方打开路由字面量");
assert.ok(client.includes("dsh-resource://file/"), "#698 client 含官方地址前缀");
assert.ok(client.includes("data-presented-file"), "#698 client 含官方卡片锚点");
assert.ok(client.includes("sidebarRight"), "#698 client 引用官方右侧栏导航服务");

// 宿主入口只保留契约面：不得再注入 webServer，也不得出现任何自建路由路径。
const host = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
assert.ok(/ROUTES/.test(host), "#698 宿主入口保留 ROUTES 契约字面量（verify:npmlayout）");
assert.ok(!host.includes("webServer"), "#698 宿主不再注入 webServer（无路由可注册）");
assert.ok(!host.includes("/api/dsh-file-preview/"), "#698 宿主不再含自建路由路径");

console.log("PASS dsh-web-file-preview client-contract");
