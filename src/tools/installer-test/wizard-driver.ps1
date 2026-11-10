# wizard-driver.ps1 -- (test tooling, not shipped) drives the Inno Setup GRAPHICAL wizard of the TEST identity. One action per call, JSON on stdout.
#   info | button <name> | click <x> <y> | shot <file> | dialog [buttonName] | blue <x> <y>   (blue = number of accent-blue pixels in a 13x13 square: a ticked checkbox)
param([string]$Action, [string]$A1 = '', [string]$A2 = '')
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class W {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
}
'@
[void][W]::SetProcessDPIAware()
$UIA = [System.Windows.Automation.AutomationElement]; $root = $UIA::RootElement
function Find-Wizard {
  foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
    if ($w.Current.ClassName -eq 'TWizardForm' -and $w.Current.Name -like '*installer test*') { return $w }
  }
  return $null
}
function Top-Dialogs($pid0) {
  $r = @()
  foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
    if ($w.Current.ProcessId -eq $pid0 -and $w.Current.ClassName -ne 'TWizardForm' -and $w.Current.ClassName -match 'TMessageForm|#32770|TForm') { $r += $w }
  }
  return $r
}
function Walk($e, $acc, $d) {
  foreach ($c in $e.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
    $rc = $c.Current.BoundingRectangle
    $acc.Add([pscustomobject]@{ cls = $c.Current.ClassName; name = $c.Current.Name; en = $c.Current.IsEnabled; x = [int]$rc.X; y = [int]$rc.Y; w = [int]$rc.Width; h = [int]$rc.Height; el = $c }) | Out-Null
    if ($d -lt 6) { Walk $c $acc ($d + 1) }
  }
}
function Raise($w) {
  $h = [IntPtr]$w.Current.NativeWindowHandle
  [void][W]::ShowWindow($h, 9); [void][W]::SetWindowPos($h, [IntPtr]-1, 0, 0, 0, 0, 0x43)   # TOPMOST, no move/size
  [void][W]::SetForegroundWindow($h)
}
function Click-El($owner, $el) {
  Raise $owner; Start-Sleep -Milliseconds 300
  $r = $el.Current.BoundingRectangle
  [void][W]::SetCursorPos([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2)); Start-Sleep -Milliseconds 120
  [W]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60; [W]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
}
$win = Find-Wizard
if ($Action -eq 'dialog') {
  $found = $null
  if ($win) { $found = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, '#32770'))) }
  if (-not $found) { foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) { if ($w.Current.ClassName -eq '#32770' -or $w.Current.ClassName -eq 'TMessageForm') { $found = $w; break } } }
  if (-not $found) { '{"ok":false,"error":"no dialog"}'; exit 0 }
  $acc = New-Object System.Collections.ArrayList; Walk $found $acc 1
  $texts = @($acc | Where-Object { $_.cls -match 'Static' -and $_.name } | ForEach-Object { $_.name })
  $btns = @($acc | Where-Object { $_.cls -eq 'Button' } | ForEach-Object { $_.name })
  if ($A1) { $b = $acc | Where-Object { $_.cls -eq 'Button' -and $_.name -like "$A1" } | Select-Object -First 1; if ($b) { Click-El $(if ($win) { $win } else { $found }) $b.el } }
  @{ ok = $true; title = $found.Current.Name; texts = $texts; buttons = $btns } | ConvertTo-Json -Compress; exit 0
}
if (-not $win) { '{"ok":false,"error":"no wizard window"}'; exit 0 }
$acc = New-Object System.Collections.ArrayList; Walk $win $acc 1
switch ($Action) {
  'info' {
    $list = $acc | Where-Object { $_.cls -eq 'TNewCheckListBox' } | Select-Object -First 1
    $wr = $win.Current.BoundingRectangle
    @{ ok = $true; title = $win.Current.Name; pid = $win.Current.ProcessId; win = @([int]$wr.X, [int]$wr.Y, [int]$wr.Width, [int]$wr.Height)
       header = @($acc | Where-Object { $_.cls -eq 'TNewStaticText' -and $_.name } | Select-Object -First 3 | ForEach-Object { $_.name })
       texts = @($acc | Where-Object { $_.cls -eq 'TNewStaticText' -and $_.name } | ForEach-Object { $_.name })
       buttons = @($acc | Where-Object { $_.cls -eq 'TNewButton' } | ForEach-Object { @{ name = $_.name; enabled = $_.en } })
       list = if ($list) { @($list.x, $list.y, $list.w, $list.h) } else { $null } } | ConvertTo-Json -Compress -Depth 5
  }
  'button' {
    $b = $acc | Where-Object { $_.cls -eq 'TNewButton' -and $_.name -like "$A1" } | Select-Object -First 1
    if (-not $b) { '{"ok":false,"error":"no such button"}'; exit 0 }
    Click-El $win $b.el
    '{"ok":true}'
  }
  'click' {
    Raise $win; Start-Sleep -Milliseconds 300
    [void][W]::SetCursorPos([int]$A1, [int]$A2); Start-Sleep -Milliseconds 120
    [W]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60; [W]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
    '{"ok":true}'
  }
  'blue' {
    $cx = [int]$A1; $cy = [int]$A2; $bmp = New-Object System.Drawing.Bitmap(13, 13); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($cx - 6, $cy - 6, 0, 0, $bmp.Size); $g.Dispose()
    $n = 0; for ($yy = 0; $yy -lt 13; $yy++) { for ($xx = 0; $xx -lt 13; $xx++) { $p = $bmp.GetPixel($xx, $yy); if ($p.B -gt $p.R + 60 -and $p.B -gt 120) { $n++ } } }
    $bmp.Dispose(); @{ ok = $true; blue = $n } | ConvertTo-Json -Compress
  }
  'shot' {
    Raise $win; Start-Sleep -Milliseconds 400
    $r = $win.Current.BoundingRectangle; $bmp = New-Object System.Drawing.Bitmap([int]$r.Width, [int]$r.Height)
    $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen([int]$r.X, [int]$r.Y, 0, 0, $bmp.Size); $g.Dispose(); $bmp.Save($A1, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
    '{"ok":true}'
  }
}
