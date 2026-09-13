/**
 * dsh-notifier — 测试共享夹具（支撑模块）。
 *
 * 为什么放在 `test/` 根而不是 `test/unit/` 下：它不是测试条目——不进任何测试层、也不计
 * `--min`（门禁口径是 `test/` 下的全部 `*.test.ts`；同名先例见 dsh-mcp-manager /
 * dsh-provider-usage 的 `test/helpers.ts`）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 临时改写环境变量，返回还原函数。
 *
 * 还原语义按「原本是否存在」分两类：原本不存在则删除而不是写成空串——空串与未设置在
 * `dshHome()` 里同义（空白视同未设置），但在别的读取方那里可能不同义，夹具不该替它们决定。
 */
export function withEnv(overrides: Record<string, string | undefined>): () => void {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/**
 * 隔离 DSH home：本次测试的全部落盘进独占的临时目录，跑完连目录一起删。
 *
 * `dispose` 必须进 `afterEach`/`afterAll`：漏掉会让后续用例继承上一个用例的 `DSH_HOME`，
 * 症状是「单跑绿、连跑红」，而且写出来的文件在仓库外，自查 `git status` 看不见。
 */
export function tempDshHome(): { readonly dir: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "dsh-notifier-test-"));
  const restore = withEnv({ DSH_HOME: dir });
  return {
    dir,
    dispose: () => {
      restore();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
