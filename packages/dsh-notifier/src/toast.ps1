param(
  [string]$Title = "DSH",
  [string]$Message = "",
  [switch]$Silent
)
# dsh-notifier 系统 toast（Windows WinRT，PowerShell 5.1+ 兼容）。
# 失败静默退出（exit 1），宿主只记录日志；不抛出阻塞调用方。
# -Silent：在 toast XML 中追加 <audio silent="true"/> 静默弹出（用于 notifySound=false）。
$ErrorActionPreference = "Stop"
# AUMID 自举：CreateToastNotifier("DSH.dsh-notifier") 用的 AppUserModelId 若未在
# HKCU 注册，Win10/11 会静默丢弃 toast（不报错也不弹出）。幂等写 HKCU 键
# （含 DisplayName 供操作中心显示可读名），无需管理员权限；失败不阻断弹窗尝试。
# AUMID 用 Company.Product 形态（HKCU\...\AppUserModelId 是公共命名空间，
# 裸名 DSH 易与其他软件冲突互覆）；历史版本注册的旧键 DSH 残留无害
# （仅一个空注册表条目），可手动清理：
#   Remove-Item -Path "HKCU:\SOFTWARE\Classes\AppUserModelId\DSH"
try {
  $appIdKey = New-Item -Path "HKCU:\SOFTWARE\Classes\AppUserModelId\DSH.dsh-notifier" -Force
  $null = $appIdKey.SetValue("DisplayName", "DSH", "String")
} catch {
  # 注册表不可写等场景仍尝试弹窗（旧版 Windows 未注册也可能成功）
}
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]
  $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
  $texts = $template.GetElementsByTagName("text")
  $texts.Item(0).AppendChild($template.CreateTextNode($Title)) | Out-Null
  $texts.Item(1).AppendChild($template.CreateTextNode($Message)) | Out-Null
  if ($Silent) {
    $audioNode = $template.CreateElement("audio")
    $null = $audioNode.SetAttribute("silent", "true")
    $null = $template.DocumentElement.AppendChild($audioNode)
  }
  $toast = New-Object Windows.UI.Notifications.ToastNotification $template
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("DSH.dsh-notifier").Show($toast) | Out-Null
  exit 0
} catch {
  exit 1
}
