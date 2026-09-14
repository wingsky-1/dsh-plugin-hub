/**
 * api 域的两个端点。都是只读的：浏览器侧没有写绑定的路径。
 *
 * 两个刻意的取舍：
 * - 绑定查询**不回 repoRoot**。客户端只需要目录根，多回一个字段就多一份「客户端知道主仓库位置」的暴露面。
 * - 缺 `session` 参数判 400 而不是回空。前者是调用方出错（可修），后者会被误读成「该会话没有绑定」。
 *
 * 两个事实来自两个域（修订号来自 binding、生效根来自 scope），故入参是两个窄端口而不是一个拼出来的对象。
 */
import type { Endpoint } from "../route/index.ts";
import type { EffectiveWorktreePort, RevisionPort } from "../../deps.ts";
import { ROUTES } from "../../../../shared/interface.ts";
import type { BindingResponse } from "../../../../shared/interface.ts";
import { writeJson } from "../../../../../../../shared/host-utils.js";

/** 从 `req.url` 取 query 参数。返回 undefined 表示缺席或空串（两者对调用方同义）。 */
function queryParam(url: string | undefined, name: string): string | undefined {
  if (url === undefined) return undefined;
  // 用固定 base 解析相对 URL：路由处理器拿到的是 path?query 形态，不是绝对 URL。
  const value = new URL(url, "http://placeholder.invalid").searchParams.get(name);
  return value === null || value.length === 0 ? undefined : value;
}

/** `GET /api/dsh-worktree-sidebar/bindings?session=<id>` —— 单会话文件根查询。 */
export function bindingsEndpoint(binding: RevisionPort, scope: EffectiveWorktreePort): Endpoint {
  return {
    path: ROUTES.bindings,
    methods: {
      GET: async (req, res) => {
        const session = queryParam(req.url, "session");
        if (session === undefined) {
          writeJson(res, 400, { ok: false, error: { message: "缺少 session 参数" } });
          return;
        }
        // 先生算出生效根、再读 revision：这样报出去的 revision 不会早于它所描述的那个事实。
        const worktreePath = await scope.effectiveWorktree(session);
        const body: BindingResponse = { revision: binding.revision(), worktreePath };
        writeJson(res, 200, body);
      },
    },
  };
}

/** `GET /api/dsh-worktree-sidebar/health` —— 存活探针。带回 revision 让它同时是有用的状态查询。 */
export function healthEndpoint(binding: RevisionPort): Endpoint {
  return {
    path: ROUTES.health,
    methods: {
      GET: (_req, res) => {
        writeJson(res, 200, { ok: true, revision: binding.revision() });
      },
    },
  };
}
