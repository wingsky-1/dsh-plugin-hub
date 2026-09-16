/** binding 域的磁盘面：读文本交给纯逻辑解析、写走共享层原子写。这里不做判断，只搬运。 */
import { readTextFileSync, writeTextAtomic } from "../../../shared/interface.ts";
import type { FileWrite } from "../../../shared/interface.ts";
import type { BindingsFile } from "../model/type.ts";
import { parseTable, serializeTable } from "../model/index.ts";

/** 读绑定表。文件缺失、不可读、内容损坏一律回落空表（parseTable 自己兜底）。 */
export function loadTable(file: string): BindingsFile {
  const read = readTextFileSync(file);
  if (!read.ok) return parseTable("");
  return parseTable(read.text);
}

/** 原子写绑定表。返回值而不是抛异常——调用方对失败的处置是统一的「内存不前移 + 出声」。 */
export function saveTable(file: string, table: BindingsFile): Promise<FileWrite> {
  return writeTextAtomic(file, serializeTable(table));
}
