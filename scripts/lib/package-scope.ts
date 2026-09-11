/**
 * scripts/lib/package-scope.ts — 产物闸的包级切片参数（#722 门禁分层）。
 *
 * 为什么存在：`contract-check` / `pack-check` / `verify-npm-layout` 是「必须读 lib 产物」
 * 的闸，全仓口径在单包 PR 上是纯浪费。分层后 PR 只对 diff 命中包跑这三个闸，全仓口径
 * 移交夜间（observe.yml），本地 `gate:full` 仍走全仓。
 *
 * 切片必须 fail-closed：**未知包名一律判红**。否则「包面写错」（例如把 dsh-notifier
 * 写成 notifier）会退化成静默跳过——比不切片更危险。空列表是合法输入，语义是
 * 「本次无产物闸对象」（纯文档/纯 meta 改动），不视为错误。
 */
import process from 'node:process'

export const PACKAGE_SCOPE_FLAG = '--packages'

/**
 * 解析 `--packages a,b` / `--packages a b`。
 * @param argv 进程参数（不含 node 与脚本路径）
 * @param known 允许的包名全集（调用方枚举口径）
 * @returns { packages: null } 表示不切片（全仓）；{ packages: string[] } 为切片清单（可为空数组）
 * @throws 未知包名或缺失取值（调用方负责打印并 exit 1）
 */
export function resolvePackageScope(argv: string[], known: string[]): { packages: string[] | null } {
  const eq = argv.find((a) => a.startsWith(`${PACKAGE_SCOPE_FLAG}=`))
  let raw: string | undefined
  if (eq !== undefined) {
    raw = eq.slice(PACKAGE_SCOPE_FLAG.length + 1)
  } else {
    const i = argv.indexOf(PACKAGE_SCOPE_FLAG)
    if (i !== -1) raw = argv[i + 1] ?? ''
  }
  if (raw === undefined) return { packages: null }

  const names = raw.split(/[\s,]+/).filter(Boolean)
  const unknown = names.filter((n) => !known.includes(n))
  if (unknown.length > 0) {
    throw new Error(
      `未知包名 ${unknown.join(', ')}（--packages 切片）—— 可用包：${known.join(', ')}`
      + '；包面写错会静默漏检，故 fail-closed',
    )
  }
  return { packages: [...new Set(names)] }
}

/** CLI 便捷包装：解析失败即打印 FAIL 并退出（与各闸脚本的 fail 风格一致）。 */
export function resolvePackageScopeOrExit(argv: string[], known: string[]): string[] | null {
  try {
    return resolvePackageScope(argv, known).packages
  } catch (e) {
    console.log(`FAIL package-scope | ${(e as Error).message}`)
    process.exit(1)
  }
}
