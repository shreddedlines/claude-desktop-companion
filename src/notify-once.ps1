<#
  notify-once.ps1 — shows ONE Windows toast and exits. Used by supervisor.js when it has to give up restarting the
  notifier (the tray app itself is not running at that point, so it cannot show the notice).
  Reuses the app's toast identity; no network, no file writes.
#>
param([string]$Title = 'Claude Notifier', [string]$Body = '', [string]$Aumid = 'ClaudeNotifier.Companion', [switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
# strip control characters in a separate statement (a comma inside the method call would be read as a 2nd argument)
function ConvertTo-XmlText($s) { $clean = ([string]$s) -replace '[\x00-\x08\x0B\x0C\x0E-\x1F]', ' '; return [System.Security.SecurityElement]::Escape($clean) }
$xml = '<toast scenario="reminder"><visual><binding template="ToastGeneric"><text>' + (ConvertTo-XmlText $Title) + '</text><text>' + (ConvertTo-XmlText $Body) + '</text></binding></visual><actions><action content="Dismiss" arguments="dismiss" activationType="system"/></actions></toast>'
$doc = New-Object Windows.Data.Xml.Dom.XmlDocument; $doc.LoadXml($xml)
if ($CheckOnly) { 'xml-ok'; exit 0 }   # test hook: parse only, show nothing
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($Aumid).Show((New-Object Windows.UI.Notifications.ToastNotification $doc))
