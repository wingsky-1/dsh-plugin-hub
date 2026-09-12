/**
 * dsh-notifier config 域 —— **对外契约**。
 *
 * ## 职责边界
 *
 * 通知设置的**唯一存取点**：本插件配置文件的读与写。读给出当前生效设置，写接收
 * 用户提交——归一化、校验、密钥掩码往返、原子落盘都在域内完成，调用方不必知道这条
 * 链上有几道工序。
 *
 * **本域不认识通知业务。** 免打扰时段是不是命中了、一条通知该不该静音、某个频道
 * 该不该参与投递、某个音色在某个平台上怎么发声——这些判断的答案属于裁决层与投递
 * 层。本域只把设置原样存下来、原样读出去；把判断塞进来，设置就从「用户说什么」
 * 变成了「系统认为该怎样」。
 *
 * ## 为什么是「装配一次 + 一组动作」
 *
 * 设置是**有状态域**：生效快照、用户层、修订号、写队列都收在实现里，对外只给
 * 动作——外面拿不到句柄就造不出第二份设置状态，「唯一存取点」才有物理含义。
 *
 * ## 为什么有两个读面
 *
 * 它们回答的不是同一个问题：`readConfig()` 回答「现在生效的设置是什么」，供域内
 * 裁决与投递使用，**含明文凭据**；`readSettingsView()` 回答「用户在设置页该看到
 * 什么、能不能改」，**凭据已掩码**。合成一个口子就要靠参数切换行为，而任何一个
 * 忘了传参的调用点都会把明文凭据送到页面上。
 *
 * ## 为什么这里没有声音判定函数
 *
 * 「一个值算不算合法声音设置」「缺键时回落到什么」是设置**读面内部**的工序：
 * 合法性问题在写入口被校验拦下，回落结果并进 `readConfig()` 的返回值。它们没有
 * 域外消费者——设置页经 HTTP 拿到的已是解析后的值，不需要自己再判一遍。把内部
 * 工序摆上契约，等于邀请调用方绕过读面自行解释设置。
 *
 * ## 依赖方向
 *
 * 只引本域 `./impl/`（契约调实现）与本域装配入参申报表 `./deps.ts`（类型面）；
 * 不引任何他域实现。
 */
import type { ConfigDeps } from "./deps.ts";
import type { NotifyConfig, SettingsPatch } from "./impl/model/type.ts";
import { configStore } from "./impl/service/index.ts";
import type { SettingsView, WriteResult } from "./impl/service/type.ts";

// ---------------------------------------------------------------- 入参类型
// 写面要读的原始值，加上升级链要读的存量形态。其余类型经这些签名可达即可，不额外占
// 一个出口名字——多一个出口就是多一份要同步的事实源。

export type { RawSettingValue, SettingsPatch, StoredSettings } from "./impl/model/type.ts";

// ---------------------------------------------------------------- 装配

/**
 * 装配设置存取（组合根在 `apply` 期调用一次）。
 *
 * 装配返回时读面已可用：文件在装配期同步读完，文件不存在即回落默认设置。
 *
 * @param deps 组合层入口层与失败出口。
 */
export function installConfig(deps: ConfigDeps): void {
  configStore.install(deps);
}

/**
 * 卸载设置存取（组合根在卸载期调用）。
 *
 * 与 `installConfig` 配对：放开装配入参、丢掉用户层快照，此后读面回落默认设置。
 * 重复调用无害——卸载链可能走到不止一次。
 */
export function releaseConfig(): void {
  configStore.release();
}

// ---------------------------------------------------------------- 读面

/**
 * 读当前生效设置：组合层入口层与用户层合并、归一化后的完整形态。
 *
 * 归一化在域内完成，因此调用方拿到的一定是一份可以直接用的设置——缺键已补默认、
 * 脏值已回落、声音缺键已按回落链解析，不需要自己判空或补齐。**含明文凭据**：
 * 它服务域内投递，不外发。
 */
export function readConfig(): NotifyConfig {
  return configStore.current();
}

/**
 * 读设置页视图：掩码后的用户层与生效值 + 修订号 + 可写性，一次取齐。
 *
 * 四个事实同一刻取齐，是因为分开取会让界面拿着旧修订号提交，凭空造出一次冲突。
 */
export function readSettingsView(): SettingsView {
  return configStore.view();
}

// ---------------------------------------------------------------- 写面

/**
 * 写用户设置：掩码还原 + 校验 + 合并 + 落盘，四道工序一次完成。
 *
 * 调用方提交掩码占位即表达「保留原值」，不需要知道有还原这一步。契约不认识的键
 * **原样保留**：文件里已有的不受本次保存影响，提交里携带的一并写回。
 *
 * @param expectedRevision 期望的用户层修订号（乐观并发；缺省 = 不做版本校验）。
 */
export async function writeConfig(
  patch: SettingsPatch,
  expectedRevision?: number,
): Promise<WriteResult> {
  return configStore.write(patch, expectedRevision);
}
