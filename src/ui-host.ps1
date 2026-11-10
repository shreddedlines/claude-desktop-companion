<#
  ui-host.ps1 — thin Windows UI layer (tray icon + toasts + sounds), driven by notifier.js.
  Windows PowerShell 5.1, no modules/dependencies: System.Windows.Forms NotifyIcon + WinRT toast API.

  Protocol: one JSON object per line.
    stdin  (from notifier.js): init | toast | retract | menu | theme | history | showmenu | hidemenu | exit
    stdout (to notifier.js)  : ready | menu | toastShown | toastHistory | menuShown | error
  Appearance: `theme` carries the palette colours (Light / Dark) or none (High Contrast => Windows draws the menu itself). Windows toasts
  are drawn by Windows and keep following the Windows theme.
  Reads no files other than the WAV paths it is told to play. Sends nothing over the network.
#>
param(
  [string]$Aumid = 'ClaudeNotifier.Companion',
  [string]$DisplayName = 'Claude Notifier'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
Add-Type -Namespace Native -Name Icons -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool DestroyIcon(System.IntPtr h);'
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Windows.Forms;
namespace Native {
  public static class Dwm {
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
    /// <summary>colour of the 1-pixel window border Windows 11 draws around pop-ups (COLORREF 0x00BBGGRR); -2 = Windows' own (default)</summary>
    public static int BorderRef = -2;
    public static int ToRef(Color c) { return (c.B << 16) | (c.G << 8) | c.R; }
    /// <summary>Windows 11: rounded corners and a border in our colour for a pop-up window (ignored on versions without these attributes)</summary>
    public static void Round(IntPtr h) {
      try { int v = 2; DwmSetWindowAttribute(h, 33, ref v, 4); int b = BorderRef; DwmSetWindowAttribute(h, 34, ref b, 4); } catch (Exception) { }
    }
  }
  /// <summary>Draws the tray menu and its sub-menus from a few colours. Colours are public fields so a theme change repaints live.</summary>
  public class MenuTheme : ToolStripProfessionalRenderer {
    public Color Bg = Color.White, Hover = Color.Gainsboro, Pressed = Color.Silver, Border = Color.Gray, Text = Color.Black, TextDisabled = Color.Gray, TextSecondary = Color.DimGray, TextError = Color.Firebrick, Separator = Color.Gainsboro;
    public MenuTheme() : base() { RoundedEdges = false; }
    static GraphicsPath Round(Rectangle r, int d) {
      GraphicsPath p = new GraphicsPath(); int a = d * 2;
      p.AddArc(r.X, r.Y, a, a, 180, 90); p.AddArc(r.Right - a, r.Y, a, a, 270, 90);
      p.AddArc(r.Right - a, r.Bottom - a, a, a, 0, 90); p.AddArc(r.X, r.Bottom - a, a, a, 90, 90);
      p.CloseFigure(); return p;
    }
    protected override void OnRenderToolStripBackground(ToolStripRenderEventArgs e) { using (SolidBrush b = new SolidBrush(Bg)) e.Graphics.FillRectangle(b, e.AffectedBounds); }
    protected override void OnRenderToolStripBorder(ToolStripRenderEventArgs e) { using (Pen p = new Pen(Border)) e.Graphics.DrawRectangle(p, 0, 0, e.ToolStrip.Width - 1, e.ToolStrip.Height - 1); }
    protected override void OnRenderImageMargin(ToolStripRenderEventArgs e) { /* no separate shade for the check gutter */ }
    protected override void OnRenderMenuItemBackground(ToolStripItemRenderEventArgs e) {
      ToolStripItem it = e.Item; if (!it.Enabled) return;
      Color c;
      if (it.Pressed && (Control.MouseButtons & MouseButtons.Left) == MouseButtons.Left) c = Pressed;
      else if (it.Selected || it.Pressed) c = Hover;
      else return;
      e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
      using (GraphicsPath p = Round(new Rectangle(3, 1, it.Width - 7, it.Height - 3), 4)) using (SolidBrush b = new SolidBrush(c)) e.Graphics.FillPath(b, p);
    }
    protected override void OnRenderSeparator(ToolStripSeparatorRenderEventArgs e) {
      int y = e.Item.Height / 2; using (Pen p = new Pen(Separator)) e.Graphics.DrawLine(p, 8, y, e.Item.Width - 8, y);
    }
    Color TextFor(ToolStripItem it) {
      string tag = it.Tag as string;
      if (tag == "error") return TextError;
      if (tag == "secondary") return TextSecondary;
      if (tag == "text") return Text;
      return it.Enabled ? Text : TextDisabled;
    }
    protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e) {
      TextRenderer.DrawText(e.Graphics, e.Text, e.TextFont, e.TextRectangle, TextFor(e.Item), e.TextFormat);
    }
    protected override void OnRenderItemCheck(ToolStripItemImageRenderEventArgs e) {
      Rectangle r = e.ImageRectangle; Graphics g = e.Graphics; g.SmoothingMode = SmoothingMode.AntiAlias;
      float cx = r.X + r.Width / 2f, cy = r.Y + r.Height / 2f;
      using (Pen p = new Pen(e.Item.Enabled ? Text : TextDisabled, 2f)) { p.StartCap = LineCap.Round; p.EndCap = LineCap.Round; p.LineJoin = LineJoin.Round;
        g.DrawLines(p, new PointF[] { new PointF(cx - 4.5f, cy + 0.5f), new PointF(cx - 1.5f, cy + 3.5f), new PointF(cx + 4.5f, cy - 3.5f) }); }
    }
    protected override void OnRenderArrow(ToolStripArrowRenderEventArgs e) {
      Rectangle r = e.ArrowRectangle; Graphics g = e.Graphics; g.SmoothingMode = SmoothingMode.AntiAlias;
      float cx = r.X + r.Width / 2f, cy = r.Y + r.Height / 2f;
      using (Pen p = new Pen(e.Item.Enabled ? Text : TextDisabled, 1.6f)) { p.StartCap = LineCap.Round; p.EndCap = LineCap.Round;
        g.DrawLines(p, new PointF[] { new PointF(cx - 2f, cy - 4f), new PointF(cx + 2f, cy), new PointF(cx - 2f, cy + 4f) }); }
    }
  }
}
'@
[System.Windows.Forms.Application]::EnableVisualStyles()

# ---------- stdout (UTF-8, no BOM) ----------
$script:out = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), (New-Object System.Text.UTF8Encoding($false)))
$script:out.AutoFlush = $true
function Send($obj) { $script:out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 6)) }

# ---------- stdin reader on a background runspace -> queue drained by a UI timer ----------
$script:queue = New-Object 'System.Collections.Concurrent.ConcurrentQueue[string]'
$rs = [runspacefactory]::CreateRunspace(); $rs.Open(); $rs.SessionStateProxy.SetVariable('q', $script:queue)
$psr = [powershell]::Create(); $psr.Runspace = $rs
[void]$psr.AddScript({
    $r = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
    while (($l = $r.ReadLine()) -ne $null) { $q.Enqueue($l) }
    $q.Enqueue('{"cmd":"exit"}')   # parent closed our stdin => parent is gone
})
[void]$psr.BeginInvoke()

# ---------- AppUserModelID (HKCU, current user only, no admin) so toasts carry our name ----------
$aumKey = "HKCU:\Software\Classes\AppUserModelId\$Aumid"
if (-not (Test-Path $aumKey)) { New-Item -Path $aumKey -Force | Out-Null }
Set-ItemProperty -Path $aumKey -Name DisplayName -Value $DisplayName
Set-ItemProperty -Path $aumKey -Name IconBackgroundColor -Value 'FF2B2B2B'
# Windows only pops banners up for desktop apps whose AUMID is attached to a Start Menu shortcut
try {
  . (Join-Path $PSScriptRoot 'app-shortcut.ps1')
  $lnk = Ensure-AppShortcut -Aumid $Aumid -Name $DisplayName -Target (Join-Path $env:WINDIR 'System32\wscript.exe') `
         -Arguments ('"' + (Join-Path $PSScriptRoot 'Claude-Notifier.vbs') + '"') -WorkDir $PSScriptRoot
} catch { $lnk = $null; $shortcutError = $_.Exception.Message }

# ---------- is Windows allowed to show this app's notifications? (Enabled | DisabledForUser | DisabledForApplication | ...) ----------
$script:toastNotifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($Aumid)
function Get-ToastSetting { try { return [string]$script:toastNotifier.Setting } catch { return 'Unknown' } }
$script:lastToastSetting = Get-ToastSetting

# ---------- tray icons (drawn at runtime, one per aggregate state) ----------
function New-StateIcon([string]$html, [string]$glyph) {
  $bmp = New-Object System.Drawing.Bitmap 32, 32
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAlias'
  $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml($html))
  $g.FillEllipse($brush, 1, 1, 30, 30)
  $font = New-Object System.Drawing.Font('Segoe UI', 17, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $sf = New-Object System.Drawing.StringFormat; $sf.Alignment = 'Center'; $sf.LineAlignment = 'Center'
  $g.DrawString($glyph, $font, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF(0, 1, 32, 32)), $sf)
  $h = $bmp.GetHicon(); $icon = [System.Drawing.Icon]::FromHandle($h).Clone()
  [Native.Icons]::DestroyIcon($h) | Out-Null
  $g.Dispose(); $bmp.Dispose(); $brush.Dispose(); $font.Dispose()
  return $icon
}
$icons = @{
  idle      = New-StateIcon '#6B7280' 'C'
  working   = New-StateIcon '#D97706' 'C'
  waiting   = New-StateIcon '#7C3AED' '?'
  attention = New-StateIcon '#DC2626' '!'
}

# ---------- tray + menu ----------
$ni = New-Object System.Windows.Forms.NotifyIcon
$ni.Icon = $icons.idle; $ni.Text = 'Claude Notifier'; $ni.Visible = $true
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$ni.ContextMenuStrip = $menu

$miHeader = New-Object System.Windows.Forms.ToolStripMenuItem 'Claude Notifier'; $miHeader.Enabled = $false
$miHeader.Font = New-Object System.Drawing.Font($miHeader.Font, [System.Drawing.FontStyle]::Bold)
$miUsage = New-Object System.Windows.Forms.ToolStripMenuItem 'Usage: no data yet'; $miUsage.Enabled = $false
$miUsageHint = New-Object System.Windows.Forms.ToolStripMenuItem "Open Claude Desktop's tray menu to refresh"; $miUsageHint.Enabled = $false; $miUsageHint.Visible = $false
$miHealth = New-Object System.Windows.Forms.ToolStripMenuItem ''; $miHealth.Enabled = $false; $miHealth.Visible = $false
$miHealthHint = New-Object System.Windows.Forms.ToolStripMenuItem ''; $miHealthHint.Enabled = $false; $miHealthHint.Visible = $false
$miToastStatus = New-Object System.Windows.Forms.ToolStripMenuItem ''; $miToastStatus.Enabled = $false; $miToastStatus.Visible = $false
$miPhoneStatus = New-Object System.Windows.Forms.ToolStripMenuItem ''; $miPhoneStatus.Enabled = $false; $miPhoneStatus.Visible = $false
$miSessions = New-Object System.Windows.Forms.ToolStripMenuItem 'Active sessions'
$miRecent = New-Object System.Windows.Forms.ToolStripMenuItem 'Recent events'
$miNotif = New-Object System.Windows.Forms.ToolStripMenuItem 'Notifications enabled'
$miSound = New-Object System.Windows.Forms.ToolStripMenuItem 'Sounds enabled'
$miTest = New-Object System.Windows.Forms.ToolStripMenuItem 'Send test notification'
$miPhone = New-Object System.Windows.Forms.ToolStripMenuItem 'Phone notifications disabled'
$miPhoneSetup = New-Object System.Windows.Forms.ToolStripMenuItem 'Set up phone notifications...'
$miPhoneTest = New-Object System.Windows.Forms.ToolStripMenuItem 'Send test phone notification'
$miAppearance = New-Object System.Windows.Forms.ToolStripMenuItem 'Appearance'
$miApSystem = New-Object System.Windows.Forms.ToolStripMenuItem 'System'
$miApLight = New-Object System.Windows.Forms.ToolStripMenuItem 'Light'
$miApDark = New-Object System.Windows.Forms.ToolStripMenuItem 'Dark'
[void]$miAppearance.DropDownItems.AddRange(@($miApSystem, $miApLight, $miApDark))
$miFolder = New-Object System.Windows.Forms.ToolStripMenuItem 'Open data folder'
$miExit = New-Object System.Windows.Forms.ToolStripMenuItem 'Exit'
[void]$menu.Items.AddRange(@($miHeader, $miUsage, $miUsageHint, $miHealth, $miHealthHint, $miToastStatus, $miPhoneStatus, (New-Object System.Windows.Forms.ToolStripSeparator), $miSessions, $miRecent,
    (New-Object System.Windows.Forms.ToolStripSeparator), $miNotif, $miSound, $miTest, (New-Object System.Windows.Forms.ToolStripSeparator), $miPhone, $miPhoneSetup, $miPhoneTest, (New-Object System.Windows.Forms.ToolStripSeparator), $miAppearance, $miFolder,
    (New-Object System.Windows.Forms.ToolStripSeparator), $miExit))
$miNotif.add_Click({ Send @{ evt = 'menu'; id = 'toggleNotifications' } })
$miSound.add_Click({ Send @{ evt = 'menu'; id = 'toggleSounds' } })
$miTest.add_Click({ Send @{ evt = 'menu'; id = 'test' } })
$miPhone.add_Click({ Send @{ evt = 'menu'; id = 'togglePhone' } })
$miPhoneSetup.add_Click({ Send @{ evt = 'menu'; id = 'phoneSetup' } })
$miPhoneTest.add_Click({ Send @{ evt = 'menu'; id = 'testPhone' } })
$miApSystem.add_Click({ Send @{ evt = 'menu'; id = 'appearance:system' } })
$miApLight.add_Click({ Send @{ evt = 'menu'; id = 'appearance:light' } })
$miApDark.add_Click({ Send @{ evt = 'menu'; id = 'appearance:dark' } })
$miFolder.add_Click({ Send @{ evt = 'menu'; id = 'openFolder' } })
$miExit.add_Click({ Send @{ evt = 'menu'; id = 'exit' } })

# left-click shows the same menu (NotifyIcon only does that for right-click by default)
$ni.add_MouseClick({
    param($s, $e)
    if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
      $m = [System.Windows.Forms.NotifyIcon].GetMethod('ShowContextMenu', [System.Reflection.BindingFlags]'NonPublic,Instance')
      $m.Invoke($ni, $null) | Out-Null
    }
  })

$script:pendingMenu = $null
function Fill-Sub($item, $entries, [string]$emptyText) {
  $item.DropDownItems.Clear()
  if (-not $entries -or @($entries).Count -eq 0) {
    $e = New-Object System.Windows.Forms.ToolStripMenuItem $emptyText; $e.Enabled = $false; [void]$item.DropDownItems.Add($e); return
  }
  foreach ($t in @($entries)) { [void]$item.DropDownItems.Add((New-Object System.Windows.Forms.ToolStripMenuItem ([string]$t))) }
}
# ---------- appearance ----------
# The themed renderer reads an item's Tag ('error' | 'secondary' | 'text' | none); without a theme (or in High Contrast) Windows draws the
# menu itself and the tags become plain ForeColors (system colours only in High Contrast).
$script:menuTheme = New-Object Native.MenuTheme
$script:themed = $false
$script:highContrast = $false
$script:toneItems = @($miHeader, $miUsage, $miUsageHint, $miHealth, $miHealthHint, $miToastStatus, $miPhoneStatus)
function Get-ToneColor($item) {
  $tag = [string]$item.Tag
  if ($script:highContrast) { return [System.Drawing.SystemColors]::ControlText }
  if ($tag -eq 'error') { return [System.Drawing.Color]::Firebrick }
  if ($tag -eq 'secondary') { return [System.Drawing.SystemColors]::GrayText }
  return [System.Drawing.SystemColors]::ControlText
}
function Update-Tones { foreach ($i in $script:toneItems) { $i.ForeColor = Get-ToneColor $i } }
function Set-StatusItem($item, $text, [bool]$bad) {
  if ($text) { $item.Text = [string]$text; $item.Visible = $true; $item.Tag = $(if ($bad) { 'error' } else { 'secondary' }); $item.ForeColor = Get-ToneColor $item }
  else { $item.Visible = $false }
}
function Color-Of($t, [string]$name, $fallback) {
  $v = [string]$t.colors.$name
  if ($v -match '^#[0-9A-Fa-f]{6}$') { return [System.Drawing.ColorTranslator]::FromHtml($v) }
  return $fallback
}
function Invalidate-Menu { try { $menu.Invalidate(); foreach ($i in $menu.Items) { if ($i.HasDropDownItems -and $i.DropDown.Visible) { $i.DropDown.Invalidate() } } } catch { } }
function Apply-Theme($t) {
  $hc = [bool]$t.highContrast -or [System.Windows.Forms.SystemInformation]::HighContrast
  $script:highContrast = $hc
  $r = $script:menuTheme
  if (-not $hc -and $t.colors -and ([string]$t.colors.surface -match '^#[0-9A-Fa-f]{6}$')) {
    $r.Bg = Color-Of $t 'surface' $r.Bg; $r.Hover = Color-Of $t 'hover' $r.Hover; $r.Pressed = Color-Of $t 'pressed' $r.Pressed; $r.Border = Color-Of $t 'border' $r.Border
    $r.Text = Color-Of $t 'text' $r.Text; $r.TextDisabled = Color-Of $t 'textDisabled' $r.TextDisabled; $r.TextSecondary = Color-Of $t 'textSecondary' $r.TextSecondary
    $r.TextError = Color-Of $t 'error' $r.TextError; $r.Separator = Color-Of $t 'border' $r.Separator
    $menu.Renderer = $r; $script:themed = $true; [Native.Dwm]::BorderRef = [Native.Dwm]::ToRef($r.Border)
  } else {
    $menu.RenderMode = [System.Windows.Forms.ToolStripRenderMode]::ManagerRenderMode      # Windows draws the menu (High Contrast, or no theme yet)
    $script:themed = $false; [Native.Dwm]::BorderRef = -2
  }
  # windows that are open right now get the new border colour too (the menu and an open sub-menu)
  try { if ($menu.Visible) { [Native.Dwm]::Round($menu.Handle) }; foreach ($i in $menu.Items) { if ($i.HasDropDownItems -and $i.DropDown.Visible) { [Native.Dwm]::Round($i.DropDown.Handle) } } } catch { }
  Update-Tones; Invalidate-Menu
}
# the menu windows get Windows 11 rounded corners (no effect on older Windows)
$menu.add_Opened({ try { [Native.Dwm]::Round($menu.Handle) } catch { } })
foreach ($mi in @($miSessions, $miRecent, $miAppearance)) { $mi.add_DropDownOpened({ param($s, $e) try { [Native.Dwm]::Round($s.DropDown.Handle) } catch { } }) }
$miHeader.Tag = 'text'

# test hook (like xmlcheck): pop the menu at a screen position and report where every entry is; optionally highlight one entry and open one sub-menu
function Get-Geometry($strip) {
  $b = $strip.Bounds; $items = @()
  foreach ($i in $strip.Items) {
    if ($i -is [System.Windows.Forms.ToolStripSeparator] -or -not $i.Visible) { continue }
    $r = $strip.RectangleToScreen($i.Bounds); $items += @{ text = $i.Text; x = $r.X; y = $r.Y; w = $r.Width; h = $r.Height; enabled = $i.Enabled; checked = [bool]($i.Checked) }
  }
  $seps = @(); foreach ($i in $strip.Items) { if ($i -is [System.Windows.Forms.ToolStripSeparator]) { $r = $strip.RectangleToScreen($i.Bounds); $seps += @{ x = $r.X; y = $r.Y; w = $r.Width; h = $r.Height } } }
  $strip.PerformLayout(); $sb = $strip.RectangleToScreen($strip.ClientRectangle)      # the real size, after layout
  $bottom = $sb.Bottom; foreach ($i in @($items) + @($seps)) { if (($i.y + $i.h) -gt $bottom) { $bottom = $i.y + $i.h } }
  return @{ x = $sb.X; y = $sb.Y; w = $sb.Width; h = ($bottom - $sb.Y + 3); items = $items; separators = $seps }
}
function Apply-Menu($m) {
  Set-StatusItem $miHealth $m.healthText $true
  Set-StatusItem $miHealthHint $m.healthHint $false
  Set-StatusItem $miToastStatus $m.toastText ([bool]$m.toastBad)
  Set-StatusItem $miPhoneStatus $m.phoneText ([bool]$m.phoneBad)
  if ($m.usageText) { $miUsage.Text = [string]$m.usageText; $miUsage.Visible = $true } else { $miUsage.Visible = $false }
  $miUsageHint.Visible = [bool]$m.usageStale -and [bool]$m.usageHint
  if ($m.usageHint) { $miUsageHint.Text = [string]$m.usageHint }
  $miUsage.Tag = $(if ($m.usageStale) { 'error' } else { $null }); $miUsage.ForeColor = Get-ToneColor $miUsage
  Fill-Sub $miSessions $m.sessions 'No active sessions'
  $miSessions.Text = 'Active sessions (' + @($m.sessions).Count + ')'
  Fill-Sub $miRecent $m.recent 'No events yet'
  $miNotif.Checked = [bool]$m.notificationsEnabled
  $miSound.Checked = [bool]$m.soundsEnabled
  $miNotif.Text = if ($m.notificationsEnabled) { 'Notifications enabled' } else { 'Notifications disabled' }
  $miSound.Text = if ($m.soundsEnabled) { 'Sounds enabled' } else { 'Sounds disabled' }
  $miPhone.Checked = [bool]$m.phoneEnabled
  $miPhone.Text = if (-not $m.phoneConfigured) { 'Phone notifications: not set up yet' } elseif ($m.phoneEnabled) { 'Phone notifications enabled' } else { 'Phone notifications disabled' }
  if ($m.phoneSetupText) { $miPhoneSetup.Text = [string]$m.phoneSetupText }
  $pref = [string]$m.appearance; if ($pref -ne 'light' -and $pref -ne 'dark') { $pref = 'system' }
  $miApSystem.Checked = ($pref -eq 'system'); $miApLight.Checked = ($pref -eq 'light'); $miApDark.Checked = ($pref -eq 'dark')
  $state = if ($icons.ContainsKey([string]$m.state)) { [string]$m.state } else { 'idle' }
  $ni.Icon = $icons[$state]
  $tip = [string]$m.tooltip; if ($tip.Length -gt 63) { $tip = $tip.Substring(0, 63) }
  $ni.Text = $tip
}
$menu.add_Closed({ if ($script:pendingMenu) { Apply-Menu $script:pendingMenu; $script:pendingMenu = $null } })

# ---------- sound + toast ----------
function Play-Sound([string]$path) {
  if ($path -and (Test-Path $path)) { (New-Object System.Media.SoundPlayer $path).Play() }   # async
}
# NOTE: strip control characters in a SEPARATE statement. Writing  Escape(($s) -replace 'x', ' ')  inside the method call makes
# PowerShell read the comma as a second ARGUMENT ("Cannot find an overload for Escape ... 2") and every toast fails.
function ConvertTo-XmlText($s) {
  $clean = ([string]$s) -replace '[\x00-\x08\x0B\x0C\x0E-\x1F]', ' '   # control chars would make LoadXml throw
  return [System.Security.SecurityElement]::Escape($clean)
}
function Build-ToastXml($c) {
  $texts = '<text>' + (ConvertTo-XmlText $c.title) + '</text>'
  foreach ($l in @($c.lines)) { if ($l) { $texts += '<text>' + (ConvertTo-XmlText $l) + '</text>' } }
  if ($c.persistent) {
    $head = '<toast scenario="reminder">'
    $actions = '<actions><action content="Dismiss" arguments="dismiss" activationType="system"/></actions>'
  } else { $head = '<toast>'; $actions = '' }
  # our own WAV is played below (so sounds can be toggled and each state is distinct): keep the toast itself silent
  return $head + '<visual><binding template="ToastGeneric">' + $texts + '</binding></visual>' + $actions + '<audio silent="true"/></toast>'
}
function Show-Toast($c) {
  $xml = Build-ToastXml $c
  $doc = New-Object Windows.Data.Xml.Dom.XmlDocument; $doc.LoadXml($xml)
  $toast = New-Object Windows.UI.Notifications.ToastNotification $doc
  if ($c.tag) { $toast.Tag = [string]$c.tag }
  if ($c.group) { $toast.Group = [string]$c.group }
  if ($c.expireMinutes) { $toast.ExpirationTime = [DateTimeOffset]::Now.AddMinutes([double]$c.expireMinutes) }
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($Aumid).Show($toast)
  Play-Sound ([string]$c.sound)
}

function Handle-Command([string]$line) {
  $c = $line | ConvertFrom-Json
  switch ($c.cmd) {
    'toast' {
      try { Show-Toast $c; Send @{ evt = 'toastShown'; tag = $c.tag; ok = $true; setting = (Get-ToastSetting) } }
      catch { Send @{ evt = 'toastShown'; tag = $c.tag; ok = $false; error = $_.Exception.Message; setting = (Get-ToastSetting) } }
    }
    'xmlcheck' {   # test hook: build + parse the toast XML exactly like a real toast, but show nothing
      try { $d = New-Object Windows.Data.Xml.Dom.XmlDocument; $d.LoadXml((Build-ToastXml $c)); Send @{ evt = 'xmlcheck'; ok = $true } }
      catch { Send @{ evt = 'xmlcheck'; ok = $false; error = $_.Exception.Message } }
    }
    'retract' {
      foreach ($t in @($c.tags)) {
        try { [Windows.UI.Notifications.ToastNotificationManager]::History.Remove([string]$t, [string]$c.group, $Aumid) } catch { }
      }
    }
    'menu' { if ($menu.Visible) { $script:pendingMenu = $c } else { Apply-Menu $c } }
    'theme' { Apply-Theme $c.theme }
    'showmenu' {
      $menu.Show((New-Object System.Drawing.Point([int]$c.x, [int]$c.y)))
      if ($c.select) { foreach ($i in $menu.Items) { if ($i.Text -eq [string]$c.select) { $i.Select() } } }
      $sub = $null
      if ($c.open) { foreach ($i in $menu.Items) { if ($i.Text -like ([string]$c.open + '*') -and $i.HasDropDownItems) { $i.ShowDropDown(); $sub = Get-Geometry $i.DropDown } } }
      Send @{ evt = 'menuShown'; menu = (Get-Geometry $menu); sub = $sub; themed = $script:themed; highContrast = $script:highContrast }
    }
    'hidemenu' { $menu.Close() }
    'history' {
      $tags = @(); try { $tags = @([Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory($Aumid) | ForEach-Object { $_.Tag }) } catch { }
      Send @{ evt = 'toastHistory'; tags = $tags }
    }
    'exit' { $script:timer.Stop(); $ni.Visible = $false; $ni.Dispose(); [System.Windows.Forms.Application]::ExitThread() }
  }
}

$script:timer = New-Object System.Windows.Forms.Timer
$script:timer.Interval = 100
$script:tickCount = 0
$script:timer.add_Tick({
    $script:tickCount++
    if ($script:tickCount % 300 -eq 0) {   # every ~30 s: did the user switch notifications off (or back on) in Windows settings?
      $s = Get-ToastSetting
      if ($s -ne $script:lastToastSetting) { $script:lastToastSetting = $s; Send @{ evt = 'toastSetting'; setting = $s } }
    }
    $line = $null; $n = 0
    while ($n -lt 50 -and $script:queue.TryDequeue([ref]$line)) {
      $n++
      try { Handle-Command $line } catch { Send @{ evt = 'error'; message = $_.Exception.Message } }
    }
  })
$script:timer.Start()
Send @{ evt = 'ready'; aumid = $Aumid; shortcut = $lnk; shortcutError = $shortcutError; toastSetting = $script:lastToastSetting }
[System.Windows.Forms.Application]::Run()
$ni.Visible = $false
