// 聚合包构建：生成最小宿主入口 lib/index.js（聚合包本身无业务逻辑，
// 职责 = dependencies 拉齐子包 + cordis.patch.yml 激活）。
// lib/ 是构建产物，不入库（.gitignore），发布前由 prepare/build 生成。
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "lib");
mkdirSync(root, { recursive: true });

const content = `"use strict";
/**
 * dsh-plugins-all 聚合包宿主入口（构建生成）。
 * 本包无自身业务逻辑：插件激活由 cordis.patch.yml 完成，
 * 子包由 dependencies 拉齐（workspace:* 发布时替换为版本号）。
 */
const name = "dsh-plugins-all";
function apply() {
  // 聚合包不注册任何 service/route/tool；子包各自 apply。
}
module.exports = { name, apply };
`;

writeFileSync(join(root, "index.js"), content, "utf8");
console.log("[dsh-plugins-all] lib/index.js 生成完成");
