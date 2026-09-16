/**
 * api 域装配：**浏览器出口**。把宿主端的事实经 HTTP 送到页面；本域不判业务，也不写任何状态。
 *
 * 它是本插件唯一的浏览器入口，所以围栏（回环判定、方法判定、异常收口）也只有一份实现，
 * 少写一处就是多开一个洞。
 *
 * 已挂路由的 disposer 住在实例里；域是**进程内单例**，第二次 `install` 由 `installed` 守卫
 * **显式抛错**（响亮失败优于静默共享/丢数据）。
 */
import type { ApiDeps } from "../../deps.ts";
import { bindingsEndpoint, healthEndpoint } from "../handlers/index.ts";
import { registerEndpoints } from "../route/index.ts";

/** api 域实例：装配的产物只对外给一个释放面。 */
export interface ApiInstance {
  /** 摘掉全部路由。幂等。 */
  release(): void;
}

/** 浏览器出口：唯一实例。 */
class ApiService implements ApiInstance {
  /** 是否已装配；单例实例重复装配是编程错误，当场暴露。 */
  private installed = false;
  /** 已挂路由的摘除器。释放即逐个调用并清空，所以不会叠成两份。 */
  private disposers: Array<() => void> = [];
  /** 路由当前是否在册。释放幂等靠它，也靠它区分「没装过」与「已摘完」。 */
  private live = false;

  /** 装配浏览器出口（组合根在 apply 期调用一次）。重复装配是编程错误，当场暴露。 */
  install(deps: ApiDeps): void {
    if (this.installed) throw new Error("dsh-worktree-sidebar: api 域只能装配一次");
    // 先注册、成功了才算装上：挂在装配标记之后的话，一次中途失败会让这个域停在
    // 「已装配但没路由、也没摘除器」的半装态——组合根的释放链里没有它（它的 push 还没走到），
    // 于是同进程的下一次装配会撞上「只能装配一次」。
    const disposers = registerEndpoints(
      deps.register,
      [bindingsEndpoint(deps.binding, deps.scope), healthEndpoint(deps.binding, deps.scope)],
      deps.logger,
    );
    this.installed = true;
    this.disposers = disposers;
    this.live = true;
  }

  /** 摘掉全部路由并复位装配标记——同进程的下一次 `install` 会重新注册，且只注册一份。 */
  release(): void {
    this.installed = false;
    if (!this.live) return;
    this.live = false;
    for (const dispose of this.disposers) {
      try {
        dispose();
      } catch {
        // 卸载阶段不做失败上报：一个端点的摘除失败不该阻断其余，也不该掩盖首个异常。
      }
    }
    this.disposers = [];
  }
}

/** 本域唯一实例：类不外放，外面 `new` 不出第二份注册。 */
export const apiService = new ApiService();
