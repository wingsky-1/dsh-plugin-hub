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

  /**
   * 装配：挂路由、接帧。**中途抛错整单回滚**：建面抛错时一条路由都还没挂，注册第 N 条抛错时前 N-1 条
   *  已挂在宿主上，帧订阅抛错时 8 条路由全都挂在宿主上——各种情况的摘除器都得当场摘干净，
   *  不能随异常一起丢失（见下方两张局部表）。
   *
   *  **这是结构性收口，不是修一处已经发生的线上故障**：装的三步今天都找不到可达抛点（建面的真实
   *  实现只建 Map + setInterval、四个端点构造只存字段），所以下面那段回滚在生产上一条也走不到。
   *  写它是为了「任一步将来开始抛错」时边界已经就位；判据由注入建面端口的那条用例撑着
   *  （`test/unit/api/service.test.ts` 的「建面失败」一条），不靠今天能复现。
   */
  install(deps: ApiDeps): void {
    if (this.installed) throw new Error("dsh-notifier: api 域只能装配一次");

    const settings = new SettingsEndpoints(deps.config);
    const journal = new JournalEndpoints(deps.stores);
    const probe = new ProbeEndpoints(deps.pipeline, deps.channels, deps.logger, deps.config);
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

    // 先接后装：摘除器先收在局部表里，整单成功才交给实例。写成 `this.disposers.push(...register(...))`
    // 的话，展开求值一抛错 push 就不发生——已注册的前缀留在宿主上、摘除器却一个都没记住。
    // 路由与帧分两张表是同一件事的另一半：合成一条 `push(...register(...), onFrame(...))` 时，
    // onFrame 抛错会让展开中断、push 根本不发生，8 条路由已挂在宿主上而摘除表仍是空的
    // （实测回滚摘掉 0 条、期望 8）。路由摘除器单列一份，catch 才摘得到它们。
    const routes: Array<() => void> = [];
    const frames: Array<() => void> = [];
    try {
      // 必须留在 try 内的是**能被抛错的东西**：闸的翻面自己不会抛错，它放哪儿都不影响结果——
      // catch 里 `this.installed = false` 是无条件复位（实测只把这一行挪到 try 之外，判据照样全绿）。
      // 它是 try 的第一行，故下面三步任一抛错都走同一条回滚。
      this.installed = true;
      // 建面排在挂路由之前：它是唯一会让本域进入「已有心跳 / 已有连接表」的步骤，排在前面
      // 才能保证回滚时它必定已装配——release() 对未装配的流枢纽是幂等空转，反过来不成立。
      streamHub.install({ logger: deps.logger });
      // registerEndpoints 自己抛错时它内部已整单回滚，routes 留空即可——两条回滚各管一段。
      routes.push(...registerEndpoints(deps.register, endpoints, deps.logger));
      frames.push(deps.frames.onFrame((payload) => streamHub.publish(payload)));
    } catch (error) {
      // 整单回滚：已挂的逐个摘除、不留「已装配」的假记忆。流枢纽与 installed 一起复位，否则
      // 这次半装配会把「可再装配」这个闸焊死（streamHub 自己的「只能装配一次」会先撞上；
      // 实测删掉它，三条「回滚后可再装配」的判据全红）。
      disposeAll([...routes, ...frames]);
      streamHub.release();
      this.installed = false;
      // 首因上抛：清理路径自己抛错也不许顶掉它，调用方要看到的是「为什么装失败」。
      throw error;
    }
    this.disposers = [...routes, ...frames];
  }

  /** 卸载：摘路由、退订帧、停掉流。**先摘空、逆序、逐项隔离**——一条摘除器抛错就跳出循环的写法，
   *  等于把其余路由与帧订阅永久留在宿主上（实测 8 条只摘 3 条、帧订阅 0 条、连 streamHub.release()
   *  都没跑到），而 `installed` 卡在 true 还会让二次装配撞上「api 域只能装配一次」。
   *  重复调用无害：摘出来的是空表（卸载链可能走到不止一次）。 */
  release(): void {
    const pending = this.disposers.splice(0);
    try {
      disposeAll(pending);
    } finally {
      // 与逐项成败无关：SSE hub 的心跳与连接必须停（否则卸载后仍有残留连接），闸必须复位。
      streamHub.release();
      this.installed = false;
    }
  }
}

/** 逆序摘除一串摘除器：后挂的先撤，单条抛错不阻断其余（回滚与正常卸载共用同一条路径）。
 *  清理路径一律不盖首因，也不上报——此时已没有「调用方」在场可接收，静默跳过等于永久残留。
 *  与 `src/shared/disposers.ts` 的清理栈同形（逆序 + 逐项隔离），刻意仍是各自一份：那一处摘除点
 *  挂在 ctx.effect 上、由宿主决定何时跑；这里要的是能整单递给 catch 的裸函数数组。 */
function disposeAll(disposers: readonly (() => void)[]): void {
  for (const dispose of [...disposers].reverse()) {
    try {
      dispose();
    } catch {
      // 一个资源的清理失败不拖垮其余：跳过其余等于把它们都留在宿主上。
    }
  }
}

/** 本域唯一的编排实例：类不外放，外面 `new` 不出第二份路由表。 */
export const apiService = new ApiService();
