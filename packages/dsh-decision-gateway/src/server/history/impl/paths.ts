/** history 域实现：本域文件布局（history/<rootHash>/<sessionId>.jsonl）。 */
/** 本域布局自有，不直引 config 域实现（跨域值边零新增，由组合根各自装配）。 */
import { dshHome } from "../../../../../../shared/dsh-home.js";
import { pluginHome } from "../../../../../../shared/paths.js";
import { PACKAGE_DIR } from "../../../shared/interface.ts";

/** 历史根目录。 */
export function historyRoot(home?: string): string {
  return pluginHome(home ?? dshHome(), PACKAGE_DIR, "history");
}
