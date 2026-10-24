/**
 * dsh-mcp-manager — unit：store 落盘域的专属测试支撑（#1174 阶段 2 形状清债）。
 *
 * 随落盘域迁出后，fs.promises rename/rm 接缝与 errno 注入器被原文件与新文件共用，
 * 故提到本支撑文件（专属前缀 unit-shape-，不进 runner、不进变异分母）。
 * 语义逐字沿用原 store.test.ts 的实现：接缝可注入、退出必还原、还原顺序不变。
 */
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

/** Narrow test ports for imported fs/promises bindings; builtin exports and platform are always restored. */
export async function unitShapeWithRenamePort(
  platform: NodeJS.Platform,
  port: (
    from: Parameters<typeof fs.promises.rename>[0],
    to: Parameters<typeof fs.promises.rename>[1],
    original: typeof fs.promises.rename,
  ) => Promise<void>,
  run: () => Promise<void>,
  rmPort?: (
    path: Parameters<typeof fs.promises.rm>[0],
    options: Parameters<typeof fs.promises.rm>[1],
    original: typeof fs.promises.rm,
  ) => Promise<void>,
) {
  const originalRename = fs.promises.rename;
  const originalRm = fs.promises.rm;
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  if (!platformDescriptor) throw new Error("process.platform descriptor missing");
  try {
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform });
    fs.promises.rename = (from, to) => port(from, to, originalRename);
    if (rmPort) {
      fs.promises.rm = (path, options) => rmPort(path, options, originalRm);
    }
    syncBuiltinESMExports();
    await run();
  } finally {
    try {
      fs.promises.rename = originalRename;
    } finally {
      try {
        fs.promises.rm = originalRm;
      } finally {
        try {
          syncBuiltinESMExports();
        } finally {
          Object.defineProperty(process, "platform", platformDescriptor);
        }
      }
    }
  }
}

/** 注入用错误对象：带 errno code 的 Error，message 默认 `injected <code>`。 */
export function unitShapeErrno(code: string, message = `injected ${code}`) {
  return Object.assign(new Error(message), { code });
}
