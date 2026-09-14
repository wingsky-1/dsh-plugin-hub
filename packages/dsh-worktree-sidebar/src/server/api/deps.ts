/** api 域依赖声明：只声明「我需要外部什么」，声明面只有类型。 */
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import type * as bindingApi from "../binding/interface.ts";
import type * as scopeApi from "../scope/interface.ts";
import type { LoggerPort } from "../shared/interface.ts";

/** 宿主路由注册口：与宿主契约同源，不在两侧各写一遍。 */
export type RegisterRoute = (route: WebRoute) => () => void;

/** binding 域给本域的能力面：客户端以修订号判定「宿主侧是否变了」。 */
export type RevisionPort = Pick<typeof bindingApi, "revision">;

/**
 * scope 域给本域的能力面：只读**生效**的文件根。
 *
 * 这里刻意**不**直接读绑定表：绑定表是「用户登记了什么」，而客户端需要的是「宿主现在按哪个根解析」。
 * 两者在失效绑定（目录没了、已不是该仓库的 worktree）上会分叉——分叉的表现是客户端把树指向 worktree、
 * 而宿主按 cwd 解析，于是每次列目录都得到 outside-workspace。所以本域只认 scope 域算出来的**生效值**。
 */
export type EffectiveWorktreePort = Pick<typeof scopeApi, "effectiveWorktree">;

/** 装配入参：一个提供方一行，两个提供方互不搭界（一个给修订号，一个给生效根）。 */
export interface ApiDeps {
  /** 宿主路由注册口：只有组合根够得着 `ctx.webServer`。 */
  readonly register: RegisterRoute;
  /** 失败出口（端点内的异常一律在这里出声，不静默吞）。 */
  readonly logger: LoggerPort;
  /** 绑定表修订号。本域**不能**写任何状态，所以它不含 put/drop。 */
  readonly binding: RevisionPort;
  /** 该会话当前生效的 worktree 根；null 表示按会话 cwd 走。 */
  readonly scope: EffectiveWorktreePort;
}
