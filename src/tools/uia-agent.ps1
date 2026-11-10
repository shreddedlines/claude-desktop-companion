<#
  tools/uia-agent.ps1 -- TEST SUPPORT (never shipped). A tiny driver controlled over stdin/stdout JSON lines, so the tests can use the
  real setup window like a person would: find controls, click buttons, read their text, take pictures.

  WinForms controls appear to UI Automation as plain "Pane" elements (no Invoke pattern, numeric ids), so controls are found by their
  visible text (UIA Name) and driven through their window handle: BM_CLICK to press a button, WM_GETTEXT to read text.

  stdin : attach {pid,timeoutMs} | list | texts | exists {id} | enabled {id} | text {id} | invoke {id} | shot {id?,file} | dialog {button} | close | exit
          appearance helpers: rect {id?} | pixels {points} | syscolors | mouse {x,y,action} | key {vk,target?} | focused | darktitle {dialog?}
          ({id} is the control's visible text)
  stdout: one JSON reply per command {ok, ...}
  Pure ASCII file (Windows PowerShell 5.1).
#>
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing, System.Windows.Forms
Add-Type -Namespace Native -Name Win -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr h, uint msg, System.IntPtr w, System.IntPtr l);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern System.IntPtr SendMessage(System.IntPtr h, int msg, System.IntPtr w, System.IntPtr l);
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)] public static extern System.IntPtr SendMessage(System.IntPtr h, int msg, System.IntPtr w, System.Text.StringBuilder l);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsWindowEnabled(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, System.UIntPtr extra);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint pid);
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)] public static extern int GetWindowText(System.IntPtr h, System.Text.StringBuilder sb, int n);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr h, System.IntPtr after, int x, int y, int cx, int cy, uint flags);
[System.Runtime.InteropServices.DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(System.IntPtr hwnd, int attr, out int value, int size);
'@
[void][Native.Win]::SetProcessDPIAware()
$out = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), (New-Object System.Text.UTF8Encoding($false))); $out.AutoFlush = $true
function Reply($o) { $out.WriteLine(($o | ConvertTo-Json -Compress -Depth 5)) }
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$script:win = $null; $script:dlgHandle = $null
$BM_CLICK = 0x00F5; $WM_GETTEXT = 0x000D; $WM_GETTEXTLENGTH = 0x000E

function Find-Window([int]$procId, [int]$timeoutMs) {
  $cond = New-Object System.Windows.Automation.PropertyCondition($AE::ProcessIdProperty, $procId)
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt $timeoutMs) {
    foreach ($w in $AE::RootElement.FindAll($TS::Children, $cond)) { if ($w.Current.ControlType.ProgrammaticName -eq 'ControlType.Window' -and $w.Current.ClassName -notlike '#32770') { return $w } }
    Start-Sleep -Milliseconds 150
  }
  return $null
}
# controls are found by their visible text; hidden controls (other wizard pages) are not in the tree
function Find-Id([string]$name) {
  if (-not $script:win) { return $null }
  $cond = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $name)
  return $script:win.FindFirst($TS::Descendants, $cond)
}
function Get-HwndText($h) {
  $len = [int][Native.Win]::SendMessage($h, $WM_GETTEXTLENGTH, [IntPtr]::Zero, [IntPtr]::Zero)
  $sb = New-Object System.Text.StringBuilder ($len + 2)
  [void][Native.Win]::SendMessage($h, $WM_GETTEXT, [IntPtr]($len + 1), $sb)
  return $sb.ToString()
}
# bring the window under test (the open dialog, else the main window) to the front so that nothing covers it before pixels are read
function Raise-Window {
  if (-not $script:win) { return }      # nothing attached (e.g. a tray menu is being photographed): leave the windows alone
  $h = [IntPtr]$script:win.Current.NativeWindowHandle
  if ($script:dlgHandle -and [Native.Win]::IsWindowVisible([IntPtr]$script:dlgHandle)) { $h = [IntPtr]$script:dlgHandle }
  # topmost (test only): Windows refuses SetForegroundWindow while another program has the input focus, but a topmost window is never covered
  [void][Native.Win]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x13)
  if ([Native.Win]::GetForegroundWindow() -ne $h) {   # another program has the input focus: the classic Alt-tap lets SetForegroundWindow through
    [Native.Win]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [Native.Win]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    [void][Native.Win]::SetForegroundWindow($h)
  }
  Start-Sleep -Milliseconds 200
}
function Save-Shot($rect, [string]$file) {
  $bmp = New-Object System.Drawing.Bitmap ([int]$rect.Width), ([int]$rect.Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen([int]$rect.X, [int]$rect.Y, 0, 0, $bmp.Size); $g.Dispose()
  $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
}

$r = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
while (($line = $r.ReadLine()) -ne $null) {
  $c = $null
  try {
    $c = $line | ConvertFrom-Json
    switch ($c.cmd) {
      'attach' {
        $script:win = Find-Window ([int]$c.pid) ([int]$(if ($c.timeoutMs) { $c.timeoutMs } else { 15000 }))
        if ($script:win) { Reply @{ ok = $true; name = $script:win.Current.Name } } else { Reply @{ ok = $false; error = 'window not found' } }
      }
      'list' {   # every visible control with text: name, enabled
        $items = @()
        foreach ($e in $script:win.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
          $h = [IntPtr]$e.Current.NativeWindowHandle
          if ($e.Current.Name -and $h -ne [IntPtr]::Zero) { $items += @{ name = $e.Current.Name; enabled = [Native.Win]::IsWindowEnabled($h); offscreen = $e.Current.IsOffscreen } }
        }
        Reply @{ ok = $true; items = $items }
      }
      'texts' {
        $t = @($script:win.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition) | Where-Object { $_.Current.Name -and $_.Current.NativeWindowHandle -ne 0 } | ForEach-Object { $_.Current.Name })
        Reply @{ ok = $true; texts = $t }
      }
      'exists' { $e = Find-Id ([string]$c.id); Reply @{ ok = $true; exists = [bool]($e -and -not $e.Current.IsOffscreen) } }
      'enabled' {
        $e = Find-Id ([string]$c.id)
        if ($e) { Reply @{ ok = $true; enabled = [Native.Win]::IsWindowEnabled([IntPtr]$e.Current.NativeWindowHandle) } } else { Reply @{ ok = $false; error = 'no such control' } }
      }
      'text' {   # the control's own text (WM_GETTEXT), e.g. what is typed in a text box
        $e = Find-Id ([string]$c.id)
        if ($e) { Reply @{ ok = $true; text = (Get-HwndText ([IntPtr]$e.Current.NativeWindowHandle)) } } else { Reply @{ ok = $false; error = 'no such control' } }
      }
      'invoke' {   # press a button (BM_CLICK, posted so a modal dialog opened by the click cannot block this agent)
        $e = Find-Id ([string]$c.id)
        if (-not $e) { Reply @{ ok = $false; error = 'no such control' } }
        else {
          $h = [IntPtr]$e.Current.NativeWindowHandle
          if (-not [Native.Win]::IsWindowEnabled($h)) { Reply @{ ok = $false; error = 'control is disabled' } }
          else { [void][Native.Win]::PostMessage($h, $BM_CLICK, [IntPtr]::Zero, [IntPtr]::Zero); Reply @{ ok = $true } }
        }
      }
      'shot' {
        Raise-Window
        $target = if ($c.id) { Find-Id ([string]$c.id) } else { $script:win }
        if ($c.region) { Save-Shot @{ X = $c.region.x; Y = $c.region.y; Width = $c.region.w; Height = $c.region.h } ([string]$c.file); Reply @{ ok = $true; width = [int]$c.region.w; height = [int]$c.region.h } }
        elseif (-not $target) { Reply @{ ok = $false; error = 'no such control' } }
        else { $rc = $target.Current.BoundingRectangle; Save-Shot @{ X = $rc.X; Y = $rc.Y; Width = $rc.Width; Height = $rc.Height } ([string]$c.file); Reply @{ ok = $true; width = [int]$rc.Width; height = [int]$rc.Height } }
      }
      'dialog' {   # a dialog of the window's process (the themed confirmation form, or a native message box): read its text, click the button with this name
        $sw = [Diagnostics.Stopwatch]::StartNew(); $done = $false
        while (-not $done -and $sw.ElapsedMilliseconds -lt 8000) {
          $pidCond = New-Object System.Windows.Automation.PropertyCondition($AE::ProcessIdProperty, [int]$script:win.Current.ProcessId)
          $winCond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
          $cands = @($AE::RootElement.FindAll($TS::Children, $pidCond)) + @($script:win.FindAll($TS::Descendants, $winCond))
          foreach ($w in $cands) {
            if ($w.Current.NativeWindowHandle -eq $script:win.Current.NativeWindowHandle -or $w.Current.ControlType.ProgrammaticName -ne 'ControlType.Window') { continue }
            $b = $w.FindFirst($TS::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, [string]$c.button)))
            if ($b) {
              $txt = (@($w.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition) | Where-Object { $_.Current.Name -and $_.Current.NativeWindowHandle -ne 0 } | ForEach-Object { $_.Current.Name }) -join ' ')
              $ttl = $w.Current.Name; $script:dlgHandle = [IntPtr]$w.Current.NativeWindowHandle
              if ($c.noClick) { Reply @{ ok = $true; title = $ttl; text = $txt; handle = [int64]$script:dlgHandle } } else { [void][Native.Win]::PostMessage([IntPtr]$b.Current.NativeWindowHandle, $BM_CLICK, [IntPtr]::Zero, [IntPtr]::Zero); Reply @{ ok = $true; title = $ttl; text = $txt } }
              $done = $true; break
            }
          }
          if ($done) { break }
          # an owned message box is listed by UI Automation as a DESCENDANT window of its owner (not as a top-level window)
          $dlgCond = New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, '#32770')
          foreach ($w in $script:win.FindAll($TS::Descendants, $dlgCond)) {
            if ($w.Current.ClassName -like '#32770') {
              $b = $w.FindFirst($TS::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, [string]$c.button)))
              # UI Automation does not expose a message box's title or text: read them from the window handles (WM_GETTEXT)
              $txt = (@($w.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition) | Where-Object { $_.Current.ClassName -eq 'Static' -and $_.Current.NativeWindowHandle -ne 0 } | ForEach-Object { Get-HwndText ([IntPtr]$_.Current.NativeWindowHandle) }) -join ' ')
              $ttl = Get-HwndText ([IntPtr]$w.Current.NativeWindowHandle)
              if ($b) { $p = $null; if ($b.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { $p.Invoke() } else { [void][Native.Win]::PostMessage([IntPtr]$b.Current.NativeWindowHandle, $BM_CLICK, [IntPtr]::Zero, [IntPtr]::Zero) }; Reply @{ ok = $true; title = $ttl; text = $txt }; $done = $true; break }
            }
          }
          if (-not $done) { Start-Sleep -Milliseconds 150 }
        }
        if (-not $done) { Reply @{ ok = $false; error = 'no dialog' } }
      }
      'rect' {   # screen rectangle of the window or of a control
        $t = if ($c.id) { Find-Id ([string]$c.id) } else { $script:win }
        if ($c.dialog -and $script:dlgHandle) { $t = $AE::FromHandle($script:dlgHandle) }
        if (-not $t) { Reply @{ ok = $false; error = 'no such control' } } else { $rc = $t.Current.BoundingRectangle; Reply @{ ok = $true; x = [int]$rc.X; y = [int]$rc.Y; w = [int]$rc.Width; h = [int]$rc.Height } }
      }
      'pixels' {   # colours of screen points -> "#RRGGBB"
        Raise-Window
        $res = @(); $bmp = New-Object System.Drawing.Bitmap 1, 1; $g = [System.Drawing.Graphics]::FromImage($bmp)
        foreach ($p in @($c.points)) { $g.CopyFromScreen([int]$p[0], [int]$p[1], 0, 0, (New-Object System.Drawing.Size 1, 1)); $px = $bmp.GetPixel(0, 0); $res += ('#{0:X2}{1:X2}{2:X2}' -f $px.R, $px.G, $px.B) }
        $g.Dispose(); $bmp.Dispose(); Reply @{ ok = $true; colors = $res }
      }
      'syscolors' {
        $h = @{}; foreach ($n in 'Menu', 'MenuText', 'Control', 'ControlText', 'Window', 'WindowText', 'GrayText', 'Highlight', 'HighlightText', 'Info', 'InfoText', 'HotTrack') { $col = [System.Drawing.SystemColors]::$n; $h[$n] = ('#{0:X2}{1:X2}{2:X2}' -f $col.R, $col.G, $col.B) }
        Reply @{ ok = $true; colors = $h }
      }
      'mouse' {   # move the pointer / press / release the left button
        switch ([string]$c.action) {
          'move' { [void][Native.Win]::SetCursorPos([int]$c.x, [int]$c.y) }
          'down' { [Native.Win]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero) }
          'up' { [Native.Win]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero) }
        }
        Reply @{ ok = $true }
      }
      'key' {   # post a key press to the window (the same path as typing; the window's message loop does the Tab navigation)
        Raise-Window
        $h = if ($c.dialog -and $script:dlgHandle) { $script:dlgHandle } else { [IntPtr]$script:win.Current.NativeWindowHandle }
        [void][Native.Win]::PostMessage($h, 0x0100, [IntPtr][int]$c.vk, [IntPtr]0); [void][Native.Win]::PostMessage($h, 0x0101, [IntPtr][int]$c.vk, [IntPtr]0xC0000001)
        Reply @{ ok = $true }
      }
      'focused' {   # which control has the keyboard focus (UIA name), '' if none
        $n = ''; try { $fe = $AE::FocusedElement; if ($fe) { $n = $fe.Current.Name } } catch { }
        Reply @{ ok = $true; name = $n }
      }
      'fg' {   # diagnostics: which program has the foreground (title and process name)
        $h = [Native.Win]::GetForegroundWindow(); $sb = New-Object System.Text.StringBuilder 200; [void][Native.Win]::GetWindowText($h, $sb, 200)
        $p = [uint32]0; [void][Native.Win]::GetWindowThreadProcessId($h, [ref]$p); $pn = ''; try { $pn = (Get-Process -Id $p).ProcessName } catch { }
        Reply @{ ok = $true; title = $sb.ToString(); process = $pn }
      }
      'dpi' { $g = [System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero); $d = $g.DpiX; $g.Dispose(); Reply @{ ok = $true; scale = ($d / 96.0) } }   # the agent is DPI aware: physical pixels
      'foreground' { Raise-Window; Reply @{ ok = $true; set = ([Native.Win]::GetForegroundWindow() -eq [IntPtr]$script:win.Current.NativeWindowHandle) } }
      'darktitle' {   # DWMWA_USE_IMMERSIVE_DARK_MODE of the window (20, or 19 on early Windows 10 builds)
        $h = if ($c.dialog -and $script:dlgHandle) { $script:dlgHandle } else { [IntPtr]$script:win.Current.NativeWindowHandle }
        $v = 0; $hr = [Native.Win]::DwmGetWindowAttribute($h, 20, [ref]$v, 4); if ($hr -ne 0) { $hr = [Native.Win]::DwmGetWindowAttribute($h, 19, [ref]$v, 4) }
        Reply @{ ok = $true; hr = $hr; dark = ($v -ne 0) }
      }
      'close' { $p = $null; if ($script:win.TryGetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern, [ref]$p)) { $p.Close() }; Reply @{ ok = $true } }
      'exit' { Reply @{ ok = $true } }
      default { Reply @{ ok = $false; error = 'unknown command' } }
    }
  } catch { Reply @{ ok = $false; error = $_.Exception.Message } }
  if ($c -and $c.cmd -eq 'exit') { break }
}
