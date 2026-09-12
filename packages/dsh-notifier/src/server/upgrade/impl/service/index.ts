/**
 * dsh-notifier upgrade 域 —— 生命周期：跑链，以及把存量迁移挂到服务就绪的那一刻。
 *
 * 两件事分成两种时机，是这一块存在的全部理由：
 *
 * - **升级链**在装配期同步跑完（动的是磁盘上的文件）；
 * - **存量配置的迁移**要等宿主 settings 服务就绪——0.2.3 把配置存在那里，而那个服务可能
 *   晚于本插件装配，宿主也可以根本不装它。等不到就不做，不拦住启动。
 *
 * 迁移只做一件事：把旧配置交给 config 域的写面。旧版本长什么样的知识全在 `../legacy/`，
 * 业务域不认识「0.2.3」「settings 命名空间」这些词。
 *
 * 依赖方向：只引用本目录、`../chain/`、`../legacy/` 与 `../../deps.ts`。
 */
import type { SettingsPatch, UpgradeDeps } from "../../deps.ts";
import { runUpgradeChain } from "../chain/index.ts";
import { readLegacySettings } from "../legacy/index.ts";
import type { LegacySettingsFace } from "../legacy/type.ts";

/** 升级域：装配期一次，此后只在服务就绪时被动响应。 */
class UpgradeRunner {
  /** 是否已装配；单例实例重复装配是编程错误，当场暴露。 */
  private installed = false;
  /** 存量迁移的退订器：服务始终不来时，靠它随卸载一起收掉。 */
  private detach: () => void = () => {};

  /** 装配：先跑链，再把存量迁移挂上。 */
  install(deps: UpgradeDeps): void {
    if (this.installed) throw new Error("dsh-notifier: upgrade 域只能装配一次");
    this.installed = true;
    runUpgradeChain(deps.logger);
    this.detach = deps.legacySettings.whenReady((settings) => {
      this.migrateLegacy(settings, deps);
    });
  }

  /** 卸载：退订。升级链没有留下任何需要释放的东西——它只写了文件。 */
  release(): void {
    this.detach();
    this.detach = () => {};
    this.installed = false;
  }

  /**
   * 存量配置 → 当前配置文件。
   *
   * 只交给 config 域的写面，不自己判「新旧哪个该赢」之外的事：写入是那次调用的全部语义，
   * 而它本身就是幂等的合并（配置为空时才可能产生实际变化）。
   *
   * 失败只出声不抛出：这是装配完成之后的异步回调，抛出去没人接得住，而用户看到的症状
   * 是「升级后设置回到了默认」——他需要一条日志能指向这里。
   */
  private migrateLegacy(settings: LegacySettingsFace, deps: UpgradeDeps): void {
    const legacy = readLegacySettings(settings);
    if (Object.keys(legacy).length === 0) return;
    void deps.config.writeConfig(legacy as SettingsPatch).then((result) => {
      if (result.ok) return;
      deps.logger.warn("dsh-notifier: 存量设置迁移失败，已跳过；原值仍留在旧位置");
    });
  }
}

/** 本域唯一的装配实例：类不外放，外面 `new` 不出第二份升级流程。 */
export const upgradeRunner = new UpgradeRunner();
