param(
  [string]$Title = "DSH",
  [string]$Message = "",
  [switch]$Silent
)
# dsh-notifier 系统 toast（Windows WinRT，PowerShell 5.1+ 兼容）。
# 失败静默退出（exit 1），宿主只记录日志；不抛出阻塞调用方。
# -Silent：在 toast XML 中追加 <audio silent="true"/> 静默弹出（用于 notifySound=false）。
$ErrorActionPreference = "Stop"
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
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("DSH").Show($toast) | Out-Null
  exit 0
} catch {
  exit 1
}
