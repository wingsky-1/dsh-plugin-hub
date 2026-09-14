/**
 * dsh-notifier channels 域 —— 能力自检面的**数据表**。
 * 表是数据不是决策：这里只写「哪一格的 `checked` 允许出现哪些取值」「哪个发行版属于哪个包管理器族」，
 * 判定仍留在实现里。门禁与测试断言的是「实际产出 ⊆ 本表」。
 */
import type { CheckedDimension, PackageManager } from "./type.ts";

/** 一个平台下两个维度各自允许产出的 `checked` 子集。 */
export interface DimensionChecks {
  readonly popup: readonly CheckedDimension[];
  readonly sound: readonly CheckedDimension[];
}

/**
 * 平台 × 维度 → 允许的 `checked` 取值。
 *
 * 为什么需要这张表：单一 flat 闭集跨平台共享一套词，会让「darwin 产出 `afplay`」这类错误**没有规则可拦**
 * （darwin 与 `afplay` 无关的取值同属那个闭集）；拆成六套契约又会各自漂移。值域保持一套、合法性用表约束。
 * darwin/win32 的两格为空：这两条路走系统自带工具，没有需要探测的依赖——空数组本身就是「什么都没验」的如实暴露。
 */
export const ALLOWED_CHECKED: Readonly<Record<string, DimensionChecks>> = {
  linux: {
    popup: ["notify-send", "dbus-name-owner", "dbus-activatable", "session-bus"],
    sound: ["players", "tone-file"],
  },
  darwin: { popup: [], sound: ["tone-file"] },
  win32: { popup: [], sound: ["tone-file"] },
};

/**
 * 认不出的平台（freebsd 等）退到 POSIX 一档：它们与 linux 走同一条 `notify-send` 弹窗路径、
 * 没有需要探测的音色基目录，故弹窗词表相同、声音词表为空。
 */
export const POSIX_CHECKS: DimensionChecks = {
  popup: ["notify-send", "dbus-name-owner", "dbus-activatable", "session-bus"],
  sound: [],
};

/**
 * 发行版标识（`/etc/os-release` 的 `ID=`）→ 包管理器族。
 * 不承诺穷尽：认不出来时不给 `packagemanager`，客户端退到不带包名的建议，而不是猜一个族名。
 */
export const PACKAGE_FAMILIES: Readonly<Record<string, PackageManager>> = {
  debian: "apt",
  ubuntu: "apt",
  linuxmint: "apt",
  pop: "apt",
  raspbian: "apt",
  kali: "apt",
  fedora: "dnf",
  rhel: "dnf",
  centos: "dnf",
  rocky: "dnf",
  almalinux: "dnf",
  arch: "pacman",
  archarm: "pacman",
  manjaro: "pacman",
  endeavouros: "pacman",
};

/**
 * 「没有可用的非服务型播放器」时建议装的包。两项都直连 ALSA、**不依赖 sound server**——正因如此才配得上
 * 这一格（装 `pipewire-bin` 在无声音服务的宿主上不解决问题）：`alsa-utils` 提供 `aplay`，
 * `ffmpeg` 提供 `ffplay`（回退链的最后一道，最不挑环境）。`alsa-utils` 保持第一项。
 *
 * `ffmpeg` 在 dnf 族（Fedora/RHEL 系）来自 **RPM Fusion**：默认仓库里装不上，用户可见文案必须说出来，
 * 否则照抄这条建议会直接失败。
 */
export const PLAYER_PACKAGES: Readonly<Record<PackageManager, readonly string[]>> = {
  apt: ["alsa-utils", "ffmpeg"],
  dnf: ["alsa-utils", "ffmpeg"],
  pacman: ["alsa-utils", "ffmpeg"],
};
