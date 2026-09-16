/**
 * dsh-notifier channels 域 —— 宿主能力面形状的**转出**（形状的事实源在 src/shared/capabilities.ts）。
 *
 * 为什么留这一层而不是让域内文件直引共享面：本域实现与同包其他域之间的类型引用按门禁只走本目录
 * 的文件（见 src/server/channels/interface.ts），域内读者因此不必知道共享面的物理位置。形状本身是
 * 跨端契约（客户端读同一份），放共享面才不会漂——两套词表会让「同一组维度状态」在两端得到不同结论。
 */
export type {
  CapabilityDimension,
  CheckedDimension,
  HostCapabilities,
  PackageManager,
  PopupCapability,
  Remediation,
  RemediationCode,
  RemediationParams,
  SoundCapability,
  Verdict,
} from "../../../../shared/interface.ts";
