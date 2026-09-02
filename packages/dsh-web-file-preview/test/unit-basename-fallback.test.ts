// @ts-nocheck
/**
 * dsh-web-file-preview — unit：basename fallback（basename-fallback 纯函数）。
 *
 * mkdtemp 构造临时目录 + 真实文件（不依赖 git 仓库，走回退黑名单 DFS 遍历），覆盖：
 * - 唯一命中 → 真实绝对路径
 * - 多命中歧义 → null（绝不猜）
 * - dot 目录黑名单跳过
 * - node_modules 黑名单跳过
 * - symlink 不跟随（同名文件仅存在于符号链接目标内时不计数，唯一真实命中仍返回）
 * - walkLimit=0 触顶返回 null
 * - 零命中 → null
 * - bareBasenameOf 全分支：末段提取、Windows 分隔符、尾分隔符、空串、..
 */
import { assert } from "./helpers.ts";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bareBasenameOf, findUniqueByBasename } from "../lib/index.js";

const root = mkdtempSync(join(tmpdir(), "fwp-ut-bf-"));

try {
  mkdirSync(join(root, "a"), { recursive: true });
  mkdirSync(join(root, "b"), { recursive: true });
  mkdirSync(join(root, ".dotdir", "sub"), { recursive: true });
  mkdirSync(join(root, "modules", "node_modules", "sub"), { recursive: true });
  mkdirSync(join(root, "real"), { recursive: true });
  writeFileSync(join(root, "a", "file.txt"), "a");
  writeFileSync(join(root, "b", "file.txt"), "b");
  writeFileSync(join(root, ".dotdir", "sub", "dotfile.txt"), "dot");
  writeFileSync(join(root, "modules", "node_modules", "sub", "ignored.txt"), "ignore");
  writeFileSync(join(root, "real", "linkonly.txt"), "link");
  let linked = false;
  try {
    symlinkSync(join(root, "real"), join(root, "linkdir"), "dir");
    linked = true;
  } catch {
    /* Windows 权限受限 → 跳过 symlink 断言 */
  }

  assert.equal(await findUniqueByBasename(root, "file.txt"), null, "≥2 同名 → null 维持 404");
  assert.equal(await findUniqueByBasename(root, "linkonly.txt", { walkLimit: 0 }), null, "walkLimit=0 触顶 → null");
  assert.equal(await findUniqueByBasename(root, "dotfile.txt"), null, "dot 目录不进入遍历");
  assert.equal(await findUniqueByBasename(root, "ignored.txt"), null, "node_modules 不进入遍历");
  assert.equal(
    await findUniqueByBasename(root, "linkonly.txt"),
    join(root, "real", "linkonly.txt"),
    "唯一命中 → 真实绝对路径",
  );
  if (linked) {
    assert.equal(
      await findUniqueByBasename(root, "linkonly.txt"),
      join(root, "real", "linkonly.txt"),
      "symlink 不跟随 → 仅真实目录命中",
    );
  } else {
    console.log("  (跳过 symlink 断言：symlink 不可用)");
  }
  assert.equal(await findUniqueByBasename(root, "no-such.txt"), null, "零命中 → null");
  assert.equal(await findUniqueByBasename("", "file.txt"), null, "空 cwd → null");
  assert.equal(await findUniqueByBasename(root, ""), null, "空 name → null");

  assert.equal(bareBasenameOf("a/b/c.txt"), "c.txt", "普通路径取末段");
  assert.equal(bareBasenameOf("a\\b\\c.txt"), "c.txt", "Windows 分隔符兼容");
  assert.equal(bareBasenameOf("dir/"), null, "尾分隔符末段为空 → 不兜底");
  assert.equal(bareBasenameOf(""), null, "空串 → 不兜底");
  assert.equal(bareBasenameOf(".."), null, ".. 无末段凭证 → 不兜底");
  assert.equal(bareBasenameOf("."), null, ". 无末段凭证 → 不兜底");
  assert.equal(bareBasenameOf("c.png"), "c.png", "裸名直接作为末段");

  console.log("PASS unit-basename-fallback");
} finally {
  rmSync(root, { recursive: true, force: true });
}
