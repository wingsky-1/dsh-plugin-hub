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
import type { EffectiveWorktreePort, RevisionPort, ScopeStatePort } from "../../deps.ts";
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

/**
 * `GET /api/dsh-worktree-sidebar/health` —— 存活探针。带回 revision 与接管状态，让它同时是有用的状态查询。
 *
 * `scopeTakeover` 是「文件根为什么没换」的第一手证据：真实启动序里 provider 与插件的先后没有稳定保证，
 * 只报「没换根」会让 waiting / abandoned / 未命中绑定三种成因长得一模一样。
 *
 * `scopeChain` 解的是另一类**无声**故障：已结束会话的父链只能从持久面读，读不出来时本域按「到顶」收口
 * （正确的行为），于是继承悄悄退回 live-only——而真机上插件的 `logger.warn` 不落盘（doc §19.5），
 * 现场除这个读数之外没有任何痕迹。
 */
export function healthEndpoint(binding: RevisionPort, scope: ScopeStatePort): Endpoint {
  return {
    path: ROUTES.health,
    methods: {
      GET: (_req, res) => {
        writeJson(res, 200, {
          ok: true,
          revision: binding.revision(),
          scopeTakeover: scope.takeoverState(),
          scopeChain: scope.chainDiagnostics(),
        });
      },
    },
  };
}
