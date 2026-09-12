/**
 * dsh-notifier api 域 —— 编排：把端点挂上宿主，把帧接进流，卸载时全部收回。
 *
 * 端点表是本域对外的**完整承诺**：路径由客户端锁定，改一处就要两端同改，所以它摆在
 * 一处、一眼看得完。分派与围栏在 `route` 块，这里只声明「有哪些」。
 *
 * 依赖方向：只引用本目录、各端点块与 `../../deps.ts`，不引用 `interface.ts`。
 */
import type { ApiDeps } from "../../deps.ts";
import * as journal from "../journal/index.ts";
import * as probe from "../probe/index.ts";
import { registerEndpoints } from "../route/index.ts";
import type { Endpoint } from "../route/type.ts";
import * as settings from "../settings/index.ts";
import { streamHub } from "../stream/index.ts";

/**
 * 端点表：路径 → 方法 → 处理函数。
 *
 * 路径与客户端 `ROUTES` 一一对应；那边少一条、这里多一条都不会报错，只会表现为
 * 「某个面板一直转圈」，所以这张表要能被逐条对照着读。
 */
const ENDPOINTS: Endpoint[] = [
  { path: "/api/dsh-notifier/config", methods: { GET: settings.readSettings, PUT: settings.writeSettings } },
  { path: "/api/dsh-notifier/history", methods: { GET: journal.readJournal, DELETE: journal.clearJournal } },
  { path: "/api/dsh-notifier/status", methods: { GET: journal.readChannelStatus } },
  { path: "/api/dsh-notifier/test", methods: { POST: probe.sendTest } },
  { path: "/api/dsh-notifier/health", methods: { GET: probe.reportHealth } },
  // 包一层而不是裸传 streamHub.handle：那个方法要用 this，裸传会在回调时丢掉。
  { path: "/api/dsh-notifier/events", methods: { GET: (req, res) => streamHub.handle(req, res) } },
];

/** 浏览器出口：路由注册与帧订阅的生命周期。 */
class ApiService {
  /** 是否已装配；单例实例重复装配是编程错误，当场暴露。 */
  private installed = false;
  /** 摘除器：路由与帧订阅混在一起，卸载时逐个调用。 */
  private disposers: Array<() => void> = [];

  /** 装配：挂路由、接帧。 */
  install(deps: ApiDeps): void {
    if (this.installed) throw new Error("dsh-notifier: api 域只能装配一次");
    this.installed = true;
    streamHub.install({ logger: deps.logger });
    this.disposers.push(
      ...registerEndpoints(deps.register, ENDPOINTS, deps.logger),
      deps.frames.onFrame((payload) => streamHub.publish(payload)),
    );
  }

  /** 卸载：摘路由、退订帧、停掉流。重复调用无害——卸载链可能走到不止一次。 */
  release(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    streamHub.release();
  }
}

/** 本域唯一的编排实例：类不外放，外面 `new` 不出第二份路由表。 */
export const apiService = new ApiService();
