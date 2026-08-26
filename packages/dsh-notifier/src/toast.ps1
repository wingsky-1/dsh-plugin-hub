param(
  [string]$Title = "DSH",
  [string]$Message = "",
  [string]$Payload = "",
  [switch]$Silent
)
# dsh-notifier 系统 toast（Windows WinRT，PowerShell 5.1+ 兼容）。
# 失败静默退出（exit 1），宿主只记录日志；不抛出阻塞调用方。
#
# 参数优先级（issue #238）：宿主端经 -Payload 传 base64(UTF-8 JSON {title,message,silent})。
# 单 token 纯 base64 字母表（永不出现在 token 首、无空格无引号），规避 PS 5.1 -File
# 的全部命令行解析歧义：-Name=Value 等号形式不绑定、裸 dash token 被误认成参数名、
# 嵌入引号经两层 quoting 错配。同 PowerShell 官方 -EncodedCommand 思路。
# -Title/-Message/-Silent 仅保留供手动调试与自定义 toastScript 用户兼容；
# payload 存在时以其为准（silent 取 payload.silent 与 -Silent 任一为真）。
#
# 本文件必须保存为 UTF-8 with BOM（前 3 字节 EF BB BF）：宿主走 powershell.exe
# （5.1）入口——WinRT 投影仅 5.1 可用，不可换 pwsh——而无 BOM 时 5.1 按 ANSI 码页
# 解码本文件的中文注释，整个脚本解析失败。构建期 copyClientResources 会强制补写
# BOM 兜底，但请勿依赖该兜底抹平编辑器行为。
$ErrorActionPreference = "Stop"
$hasPayload = $false
if ($Payload) {
  try {
    $d = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json
    $Title = [string]$d.title
    $Message = [string]$d.message
    $hasPayload = $true
  } catch {
    exit 1
  }
}
$useSilent = if ($hasPayload) { [bool]$d.silent -or $Silent.IsPresent } else { $Silent.IsPresent }
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
  if ($useSilent) {
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
