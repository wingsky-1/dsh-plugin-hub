/**
 * dsh-provider-usage — server/config 域：报告配置服务（reportCfg 双源收口，#768 D1）。
 *
 * 内存权威 + 串行写链（复用 updateLastRun 的 per-root promise 链模式）：
 * 并发 POST report-config 的「写盘 + 内存 + scheduler 热更」不再交错（原 apply 闭包
 * setReportCfg/writeReportConfig 无串行化，与 lastRun 曾有 lost-update 同类）。
 * 磁盘读（GET/启动）仍以文件为权威——进程外修改可见；写路径统一走 update() 串行。
 *
 * 构造只收 root + initial + onUpdate（组合根三纪律 D1③）：initial 由组合根经
 * store.ts 读面装配前解析，热更回调由组合根注入 scheduler 面；本类不读磁盘、不做
 * 归一化判断——归一化单答案归 normalize.ts，调用方（路由写侧/组合根装配）负责传合法值。
 */
import { writeReportConfig } from "./store.ts";
import type { ReportConfig, ReportPrompts } from "./shape.ts";
import { DEFAULT_PROMPTS } from "./prompts.ts";

export interface ReportConfigServiceOptions {
  root: string;
  initial: ReportConfig;
  /** 提交回调（装配注入 reportScheduler.updateConfig，热更下轮 tick 生效）。 */
  onUpdate?: (cfg: ReportConfig) => void;
}

export class ReportConfigService {
  private cfg: ReportConfig;
  private chain: Promise<void> = Promise.resolve();
  private readonly root: string;
  private readonly onUpdate?: (cfg: ReportConfig) => void;
  /** 默认模板表（#768 B2：随服务返回，路由 GET 回显不直引 config 门面值边）。 */
  readonly promptDefaults: ReportPrompts = DEFAULT_PROMPTS;

  constructor(opts: ReportConfigServiceOptions) {
    this.root = opts.root;
    this.cfg = opts.initial;
    this.onUpdate = opts.onUpdate;
  }

  /** 内存权威当前值（executor/调度启动读取）。 */
  get(): ReportConfig {
    return this.cfg;
  }

  /** 串行写盘 → 内存 → 回调；并发调用按提交序落盘，不交错。 */
  update(next: ReportConfig): Promise<void> {
    this.chain = this.chain.then(async () => {
      await writeReportConfig(this.root, next);
      this.cfg = next;
      this.onUpdate?.(next);
    });
    return this.chain;
  }
}
