/**
 * api 域编排：把端点挂上宿主、把帧接进流，卸载时全部收回。端点表是本域对外的**完整承诺**（路径由客户端锁定，
 * 改一处就要两端同改）；它在装配期构造而不是模块级常量——写成常量各端点就得自己去别处找依赖，而症状是测试里换不掉真实现。
 */
import type { ApiDeps } from "../../deps.ts";
import { JournalEndpoints } from "../journal/index.ts";
import { KindsEndpoints } from "../kinds/index.ts";
import { ProbeEndpoints } from "../probe/index.ts";
import { registerEndpoints } from "../route/index.ts";
import type { Endpoint } from "../route/type.ts";
import { SettingsEndpoints } from "../settings/index.ts";
import { streamHub } from "../stream/index.ts";

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

    const settings = new SettingsEndpoints(deps.config);
    const journal = new JournalEndpoints(deps.stores);
    const probe = new ProbeEndpoints(deps.pipeline, deps.channels, deps.logger);
    const kinds = new KindsEndpoints(deps.kinds);
    const endpoints: Endpoint[] = [
      { path: "/api/dsh-notifier/config", methods: { GET: settings.read, PUT: settings.write } },
      { path: "/api/dsh-notifier/history", methods: { GET: journal.read, DELETE: journal.clear } },
      { path: "/api/dsh-notifier/status", methods: { GET: journal.readStatus } },
      { path: "/api/dsh-notifier/kinds", methods: { GET: kinds.read, POST: kinds.confirm } },
      { path: "/api/dsh-notifier/test", methods: { POST: probe.test } },
      { path: "/api/dsh-notifier/health", methods: { GET: probe.health } },
      { path: "/api/dsh-notifier/diagnostics", methods: { GET: probe.diagnostics } },
      // 包一层而不是裸传 streamHub.handle：那个方法要用 this，裸传会在回调时丢掉。
      {
        path: "/api/dsh-notifier/events",
        methods: { GET: (req, res) => streamHub.handle(req, res) },
      },
    ];

    this.disposers.push(
      ...registerEndpoints(deps.register, endpoints, deps.logger),
      deps.frames.onFrame((payload) => streamHub.publish(payload)),
    );
  }

  /** 卸载：摘路由、退订帧、停掉流。重复调用无害——卸载链可能走到不止一次。 */
  release(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    streamHub.release();
    this.installed = false;
  }
}

/** 本域唯一的编排实例：类不外放，外面 `new` 不出第二份路由表。 */
export const apiService = new ApiService();
