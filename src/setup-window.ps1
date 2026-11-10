<#
  setup-window.ps1 -- the phone setup window (WinForms, Windows PowerShell 5.1, no modules). USER INTERFACE ONLY.

  It renders what the notifier tells it and reports button clicks back. It never writes a setting, a file or the network; every
  state change (creating a topic, sending the test, turning phone notifications on) is done by the notifier (setup-controller.js ->
  onboarding.js), which is the single writer. The window title and the process arguments never contain the topic.

  Appearance: the notifier sends the colours (palette.js) in a `theme` command; this window only applies them, and can be re-themed
  while it is open. No colour value lives in this file except the fixed QR code (black on white). High Contrast: no palette is sent
  (or Windows reports High Contrast itself) and the window uses plain Windows system colours and native buttons.

  Protocol: one JSON object per line.
    stdin  (from the notifier): theme | model | result | notice | page | focus | close | exit
    stdout (to the notifier)  : ready | action | closed | page | themed | error
  Every control has a stable Name (= its UI Automation id) so the window can be driven by tests.
  NOTE: this file must stay pure ASCII (Windows PowerShell 5.1 reads BOM-less files as ANSI); symbols are built from char codes.
#>
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
# one compilation: DPI + window helpers, the dark title bar (Windows 10 1809+/11, harmless elsewhere) and the themed button
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Windows.Forms;
namespace Native {
  public static class Dpi {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
    /// <summary>true when Windows accepted the dark title bar; false (and nothing changes) on versions without it</summary>
    public static bool SetDarkTitleBar(IntPtr h, bool dark) {
      int v = dark ? 1 : 0;
      try { if (DwmSetWindowAttribute(h, 20, ref v, 4) == 0) return true; return DwmSetWindowAttribute(h, 19, ref v, 4) == 0; }
      catch (Exception) { return false; }
    }
  }
  /// <summary>focus rings are drawn after keyboard use only (Tab, arrows, Space, Enter), not after a mouse click</summary>
  public class CueFilter : IMessageFilter {
    public static bool Keyboard = false;
    static CueFilter inst;
    public static void Install() { if (inst == null) { inst = new CueFilter(); Application.AddMessageFilter(inst); } }
    static void Repaint() {
      foreach (Form f in Application.OpenForms) { if (f.ActiveControl != null) f.ActiveControl.Invalidate(); }
    }
    public bool PreFilterMessage(ref Message m) {
      if (m.Msg == 0x100 || m.Msg == 0x104) {
        int k = (int)m.WParam;
        if (k == 9 || (k >= 0x25 && k <= 0x28) || k == 0x20 || k == 0x0D) { if (!Keyboard) { Keyboard = true; Repaint(); } }
      } else if (m.Msg == 0x201 || m.Msg == 0x204) {
        if (Keyboard) { Keyboard = false; Repaint(); }
      }
      return false;
    }
  }
  public class ThemedButton : Button {
    public Color Face = SystemColors.Control, FaceHover = SystemColors.Control, FacePressed = SystemColors.Control, FaceDisabled = SystemColors.Control;
    public Color Border = SystemColors.ControlDark, BorderDisabled = SystemColors.ControlDark;
    public Color TextColor = SystemColors.ControlText, TextDisabled = SystemColors.GrayText;
    public Color FocusRing = SystemColors.Highlight, InnerRing = Color.Empty;
    public bool Primary = false, UseSystem = true;
    bool hover = false, down = false;
    public ThemedButton() {
      SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.Selectable, true);
      FlatStyle = FlatStyle.Standard;
    }
    protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { hover = false; down = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnMouseDown(MouseEventArgs e) { if (e.Button == MouseButtons.Left) down = true; Invalidate(); base.OnMouseDown(e); }
    protected override void OnMouseUp(MouseEventArgs e) { down = false; Invalidate(); base.OnMouseUp(e); }
    protected override void OnKeyDown(KeyEventArgs e) { if (e.KeyCode == Keys.Space) { down = true; Invalidate(); } base.OnKeyDown(e); }
    protected override void OnKeyUp(KeyEventArgs e) { if (e.KeyCode == Keys.Space) { down = false; Invalidate(); } base.OnKeyUp(e); }
    protected override void OnGotFocus(EventArgs e) { Invalidate(); base.OnGotFocus(e); }
    protected override void OnLostFocus(EventArgs e) { down = false; Invalidate(); base.OnLostFocus(e); }
    protected override void OnEnabledChanged(EventArgs e) { Invalidate(); base.OnEnabledChanged(e); }
    protected override void OnTextChanged(EventArgs e) { Invalidate(); base.OnTextChanged(e); }
    static GraphicsPath Round(Rectangle r, int d) {
      GraphicsPath p = new GraphicsPath(); int a = d * 2;
      p.AddArc(r.X, r.Y, a, a, 180, 90); p.AddArc(r.Right - a, r.Y, a, a, 270, 90);
      p.AddArc(r.Right - a, r.Bottom - a, a, a, 0, 90); p.AddArc(r.X, r.Bottom - a, a, a, 90, 90);
      p.CloseFigure(); return p;
    }
    protected override void OnPaint(PaintEventArgs e) {
      if (UseSystem) { base.OnPaint(e); return; }          // High Contrast: the native button with Windows' own colours
      Graphics g = e.Graphics; g.SmoothingMode = SmoothingMode.AntiAlias;
      g.Clear(Parent != null ? Parent.BackColor : SystemColors.Control);
      Color face, border, text;
      if (!Enabled) { face = FaceDisabled; border = BorderDisabled; text = TextDisabled; }
      else if (down) { face = FacePressed; border = Primary ? FacePressed : Border; text = TextColor; }
      else if (hover) { face = FaceHover; border = Primary ? FaceHover : Border; text = TextColor; }
      else { face = Face; border = Border; text = TextColor; }
      Rectangle r = new Rectangle(0, 0, Width - 1, Height - 1);
      using (GraphicsPath p = Round(r, 4)) {
        using (SolidBrush b = new SolidBrush(face)) g.FillPath(b, p);
        using (Pen pen = new Pen(border, 1)) g.DrawPath(pen, p);
      }
      if (Enabled && Focused && CueFilter.Keyboard) {
        using (GraphicsPath p2 = Round(new Rectangle(1, 1, Width - 3, Height - 3), 3)) using (Pen ring = new Pen(FocusRing, 2)) g.DrawPath(ring, p2);
        if (InnerRing != Color.Empty) { using (GraphicsPath p3 = Round(new Rectangle(3, 3, Width - 7, Height - 7), 2)) using (Pen inner = new Pen(InnerRing, 1)) g.DrawPath(inner, p3); }
      }
      TextRenderer.DrawText(g, Text, Font, ClientRectangle, text, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix);
    }
  }
  /// <summary>the 60-second clipboard clean-up: one non-blocking attempt that clears ONLY while the clipboard still holds exactly our text</summary>
  public static class Clip {
    [DllImport("user32.dll")] static extern bool OpenClipboard(IntPtr h);
    [DllImport("user32.dll")] static extern bool CloseClipboard();
    [DllImport("user32.dll")] static extern bool EmptyClipboard();
    [DllImport("user32.dll")] static extern bool IsClipboardFormatAvailable(uint fmt);
    [DllImport("user32.dll")] static extern IntPtr GetClipboardData(uint fmt);
    [DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr h);
    [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr h);
    public const int Cleared = 0, NotOurs = 1, Busy = 2, Failed = 3;
    /// <summary>Cleared: it was our text and is gone. NotOurs: something else (or nothing) is there, left alone. Busy: another program
    /// has the clipboard open right now (try again later). Failed: unexpected error. Never waits: a single OpenClipboard call.</summary>
    public static int ClearIfEquals(string text) {
      if (String.IsNullOrEmpty(text)) return NotOurs;
      if (!OpenClipboard(IntPtr.Zero)) return Busy;
      try {
        if (!IsClipboardFormatAvailable(13)) return NotOurs;          // CF_UNICODETEXT
        IntPtr h = GetClipboardData(13); if (h == IntPtr.Zero) return Failed;
        IntPtr p = GlobalLock(h); if (p == IntPtr.Zero) return Failed;
        string s; try { s = Marshal.PtrToStringUni(p); } finally { GlobalUnlock(h); }
        if (!String.Equals(s, text, StringComparison.Ordinal)) return NotOurs;
        return EmptyClipboard() ? Cleared : Failed;
      } catch (Exception) { return Failed; } finally { CloseClipboard(); }
    }
  }
}
'@
[void][Native.Dpi]::SetProcessDPIAware()          # crisp text on high-DPI screens
[System.Windows.Forms.Application]::EnableVisualStyles()
[Native.CueFilter]::Install()

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
    $q.Enqueue('{"cmd":"exit"}')   # the notifier closed our stdin => it is gone
})
[void]$psr.BeginInvoke()

# ---------- symbols (ASCII-safe) ----------
$CHECK = [string][char]0x2713; $WARN = [string][char]0x26A0; $DOTS = [string][char]0x2026; $DASH = [string][char]0x2014; $APOS = [string][char]0x2019

# ---------- colours: tokens from the notifier's palette, or plain Windows system colours (High Contrast) ----------
# tones (semantic text colours) are token names: text | textSecondary | success | warning | error
$GREEN = 'success'; $AMBER = 'warning'; $GRAY = 'textSecondary'; $RED = 'error'
$script:Pal = $null          # token -> Color; $null = system colours
$script:themeMode = 'light'  # light | dark | contrast
$script:dialog = $null
$SYS = @{
  bg = [System.Drawing.SystemColors]::Control; surface = [System.Drawing.SystemColors]::Window; text = [System.Drawing.SystemColors]::ControlText
  textSecondary = [System.Drawing.SystemColors]::ControlText; textDisabled = [System.Drawing.SystemColors]::GrayText
  border = [System.Drawing.SystemColors]::ControlDark; borderStrong = [System.Drawing.SystemColors]::ControlText
  accent = [System.Drawing.SystemColors]::Highlight; accentText = [System.Drawing.SystemColors]::HighlightText
  accentHover = [System.Drawing.SystemColors]::HotTrack; accentPressed = [System.Drawing.SystemColors]::HotTrack
  link = [System.Drawing.SystemColors]::HotTrack; focus = [System.Drawing.SystemColors]::Highlight
  hover = [System.Drawing.SystemColors]::Control; pressed = [System.Drawing.SystemColors]::Control
  buttonBg = [System.Drawing.SystemColors]::Control; buttonHover = [System.Drawing.SystemColors]::Control; buttonPressed = [System.Drawing.SystemColors]::Control
  disabledBg = [System.Drawing.SystemColors]::Control
  success = [System.Drawing.SystemColors]::ControlText; warning = [System.Drawing.SystemColors]::ControlText; error = [System.Drawing.SystemColors]::ControlText
  noticeBg = [System.Drawing.SystemColors]::Info; noticeText = [System.Drawing.SystemColors]::InfoText
}
function C([string]$token) {
  if ($script:Pal -and $script:Pal.ContainsKey($token)) { return $script:Pal[$token] }
  if ($SYS.ContainsKey($token)) { return $SYS[$token] }
  return [System.Drawing.SystemColors]::ControlText
}
function Set-Tone($ctl, [string]$tone) { $ctl.Tag = $tone; $ctl.ForeColor = (C $tone) }
function Set-DoubleBuffered($c) { try { $p = $c.GetType().GetProperty('DoubleBuffered', [System.Reflection.BindingFlags]'Instance,NonPublic'); if ($p) { $p.SetValue($c, $true, $null) } } catch { } }

# ---------- small UI helpers ----------
$FONT = New-Object System.Drawing.Font('Segoe UI', 10)
$FONT_B = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
$FONT_S = New-Object System.Drawing.Font('Segoe UI', 9)
$FONT_T = New-Object System.Drawing.Font('Segoe UI', 16, [System.Drawing.FontStyle]::Bold)
$FONT_M = New-Object System.Drawing.Font('Consolas', 13)
$TEXTW = 440
function New-Label([string]$name, [string]$text, $font = $FONT, [string]$tone = 'text') {
  $l = New-Object System.Windows.Forms.Label; $l.Name = $name; $l.Text = $text; $l.Font = $font; $l.AutoSize = $true
  $l.MaximumSize = New-Object System.Drawing.Size($TEXTW, 0); $l.Margin = New-Object System.Windows.Forms.Padding(0, 0, 0, 8)
  Set-Tone $l $tone
  return $l
}
function New-Button([string]$name, [string]$text, [bool]$primary = $false) {
  $b = New-Object Native.ThemedButton; $b.Name = $name; $b.Text = $text; $b.Font = $(if ($primary) { $FONT_B } else { $FONT }); $b.Primary = $primary
  $b.AutoSize = $true; $b.AutoSizeMode = 'GrowAndShrink'; $b.Padding = New-Object System.Windows.Forms.Padding(8, 3, 8, 3)
  $b.Margin = New-Object System.Windows.Forms.Padding(8, 8, 0, 8)
  return $b
}
function New-Page([string]$name) {
  $p = New-Object System.Windows.Forms.Panel; $p.Name = $name; $p.Dock = 'Fill'; $p.Visible = $false
  $foot = New-Object System.Windows.Forms.FlowLayoutPanel; $foot.Name = "$name.buttons"; $foot.Dock = 'Bottom'; $foot.FlowDirection = 'RightToLeft'; $foot.Height = 56; $foot.Padding = New-Object System.Windows.Forms.Padding(12, 4, 12, 4)
  $body = New-Object System.Windows.Forms.FlowLayoutPanel; $body.Name = "$name.body"; $body.Dock = 'Fill'; $body.FlowDirection = 'TopDown'; $body.WrapContents = $false; $body.AutoScroll = $true; $body.Padding = New-Object System.Windows.Forms.Padding(24, 20, 24, 8)
  Set-DoubleBuffered $p; Set-DoubleBuffered $foot; Set-DoubleBuffered $body
  $p.Controls.Add($body); $p.Controls.Add($foot)
  $script:form.Controls.Add($p)
  return @{ panel = $p; body = $body; foot = $foot }
}
function Add-Foot($page, $btn) { [void]$page.foot.Controls.Add($btn) }   # buttons are added right-to-left: add the PRIMARY one first
function Add-Body($page, $ctl) { [void]$page.body.Controls.Add($ctl) }
function New-QrBox([string]$name) {
  # the QR code is NEVER themed: black modules on a white box in every appearance (scanners need that contrast)
  $pb = New-Object System.Windows.Forms.PictureBox; $pb.Name = $name; $pb.SizeMode = 'CenterImage'; $pb.BackColor = [System.Drawing.Color]::White
  $pb.Size = New-Object System.Drawing.Size(240, 240); $pb.Margin = New-Object System.Windows.Forms.Padding(0, 4, 0, 8); $pb.AccessibleName = 'QR code'; $pb.AccessibleRole = 'Graphic'
  return $pb
}
# black modules on a white quiet zone, always
function New-QrBitmap($rows, [int]$box) {
  $n = @($rows).Count; $border = 4
  $scale = [Math]::Max(3, [int][Math]::Floor($box / ($n + 2 * $border)))
  $size = ($n + 2 * $border) * $scale
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp); $g.Clear([System.Drawing.Color]::White)
  $black = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::Black)
  for ($y = 0; $y -lt $n; $y++) { $row = [string]@($rows)[$y]; for ($x = 0; $x -lt $n; $x++) { if ($row[$x] -eq [char]'1') { $g.FillRectangle($black, ($x + $border) * $scale, ($y + $border) * $scale, $scale, $scale) } } }
  $g.Dispose(); $black.Dispose()
  return $bmp
}
function Set-Qr($pictureBox, $rows) {
  if (-not $rows -or @($rows).Count -eq 0) { $pictureBox.Image = $null; return }
  $old = $pictureBox.Image; $pictureBox.Image = New-QrBitmap $rows 230; if ($old) { $old.Dispose() }
}
function Open-Link([string]$url) {   # only a few fixed, official https hosts
  if ($url -match '^https://(play\.google\.com|f-droid\.org|claude\.ai)/') { try { Start-Process $url } catch { } }
}

# ---------- the form ----------
$script:form = New-Object System.Windows.Forms.Form
$form.Name = 'SetupWindow'; $form.Text = "Claude Notifier $DASH Phone setup"
$form.ClientSize = New-Object System.Drawing.Size(520, 720); $form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'; $form.MaximizeBox = $false; $form.MinimizeBox = $true; $form.ShowInTaskbar = $true
$form.Font = $FONT; $form.AutoScaleMode = 'Dpi'; $form.AutoScaleDimensions = New-Object System.Drawing.SizeF(96, 96)
$form.Opacity = 0           # invisible until the first theme + model are applied: no flash of the wrong colours
Set-DoubleBuffered $form
$script:lblNotice = New-Object System.Windows.Forms.Label; $lblNotice.Name = 'lblNotice'; $lblNotice.Dock = 'Top'; $lblNotice.AutoSize = $false; $lblNotice.Height = 0
$lblNotice.Font = $FONT_S; $lblNotice.Padding = New-Object System.Windows.Forms.Padding(24, 8, 24, 8); $lblNotice.Visible = $false

# --- page: check ---
$script:pCheck = New-Page 'pageCheck'
Add-Body $pCheck (New-Label 'lblCheckTitle' 'Set up phone notifications' $FONT_T)
Add-Body $pCheck (New-Label 'lblCheckIntro' "Get a notification on your Android phone when Claude needs you or has finished. This takes about two minutes.")
Add-Body $pCheck (New-Label 'lblCheckHead' 'What Claude Notifier found on this PC:' $FONT_B)
$script:rowTitle = @(); $script:rowDetail = @()
foreach ($i in 1..3) {
  $t = New-Label "row$i" '' $FONT_B; $d = New-Label "rowDetail$i" '' $FONT_S $GRAY; $d.Margin = New-Object System.Windows.Forms.Padding(22, 0, 0, 10)
  Add-Body $pCheck $t; Add-Body $pCheck $d; $script:rowTitle += $t; $script:rowDetail += $d
}
Add-Body $pCheck (New-Label 'lblCheckNote' "These checks never block the phone setup." $FONT_S $GRAY)
$script:btnCheckNext = New-Button 'btnCheckNext' 'Next: connect your phone' $true; Add-Foot $pCheck $btnCheckNext
$script:btnCheckSkip = New-Button 'btnCheckSkip' 'Skip for now'; Add-Foot $pCheck $btnCheckSkip

# --- page: app (install ntfy) ---
$script:pApp = New-Page 'pageApp'
Add-Body $pApp (New-Label 'lblAppTitle' 'Step 1 of 3: Install ntfy on your phone' $FONT_T)
Add-Body $pApp (New-Label 'lblAppText' "ntfy is a free app that shows the notifications. On your Android phone open Google Play (or F-Droid), search for ""ntfy"" and install it. Or scan this code with your phone${APOS}s camera.")
$script:picPlay = New-QrBox 'picPlayQr'; Add-Body $pApp $picPlay
$script:lnkPlay = New-Object System.Windows.Forms.LinkLabel; $lnkPlay.Name = 'lnkPlay'; $lnkPlay.Text = 'Open the Google Play page'; $lnkPlay.AutoSize = $true; $lnkPlay.Font = $FONT_S; $lnkPlay.Margin = New-Object System.Windows.Forms.Padding(0, 0, 0, 4)
$script:lnkFdroid = New-Object System.Windows.Forms.LinkLabel; $lnkFdroid.Name = 'lnkFdroid'; $lnkFdroid.Text = 'Open the F-Droid page'; $lnkFdroid.AutoSize = $true; $lnkFdroid.Font = $FONT_S
Add-Body $pApp $lnkPlay; Add-Body $pApp $lnkFdroid
$script:btnAppNext = New-Button 'btnAppNext' 'I have the ntfy app' $true; Add-Foot $pApp $btnAppNext
$script:btnAppBack = New-Button 'btnAppBack' 'Back'; Add-Foot $pApp $btnAppBack

# --- page: subscribe ---
$script:pSub = New-Page 'pageSubscribe'
Add-Body $pSub (New-Label 'lblSubTitle' 'Step 2 of 3: Subscribe to your private topic' $FONT_T)
Add-Body $pSub (New-Label 'lblSubText' "Scan this code with your phone${APOS}s camera. When your phone asks, tap Open (ntfy), then Subscribe.")
$script:picDeep = New-QrBox 'picDeepQr'; Add-Body $pSub $picDeep
$script:lblQrHidden = New-Label 'lblQrHidden' 'The code is hidden.' $FONT_S $GRAY; $lblQrHidden.Visible = $false; Add-Body $pSub $lblQrHidden
$script:btnToggleQr = New-Button 'btnToggleQr' 'Hide the code'; $btnToggleQr.Margin = New-Object System.Windows.Forms.Padding(0, 0, 0, 8); Add-Body $pSub $btnToggleQr
Add-Body $pSub (New-Label 'lblCantScan' "Can${APOS}t scan? In the ntfy app tap + and type this topic (leave the server as it is):" $FONT_S)
# the topic box: a read-only text box inside a thin frame (the frame turns into the focus colour while the box has the keyboard focus)
$script:txtTopic = New-Object System.Windows.Forms.TextBox; $txtTopic.Name = 'txtTopic'; $txtTopic.ReadOnly = $true; $txtTopic.Font = $FONT_M; $txtTopic.BorderStyle = 'None'; $txtTopic.Width = 318; $txtTopic.AccessibleName = 'Topic'
$script:topicFrame = New-Object System.Windows.Forms.Panel; $topicFrame.Name = 'topicFrame'; $topicFrame.Margin = New-Object System.Windows.Forms.Padding(0, 0, 0, 0)
$txtTopic.Location = New-Object System.Drawing.Point(7, 6); $topicFrame.Size = New-Object System.Drawing.Size(334, ($txtTopic.PreferredHeight + 12)); [void]$topicFrame.Controls.Add($txtTopic)
$txtTopic.add_GotFocus({ $topicFrame.BackColor = (C 'focus') }); $txtTopic.add_LostFocus({ $topicFrame.BackColor = (C 'borderStrong') })
$script:btnCopy = New-Button 'btnCopy' 'Copy'; $btnCopy.Margin = New-Object System.Windows.Forms.Padding(8, 0, 0, 0)
$rowTopic = New-Object System.Windows.Forms.FlowLayoutPanel; $rowTopic.Name = 'rowTopic'; $rowTopic.AutoSize = $true; $rowTopic.FlowDirection = 'LeftToRight'; $rowTopic.WrapContents = $false; $rowTopic.Margin = New-Object System.Windows.Forms.Padding(0, 0, 0, 8)
[void]$rowTopic.Controls.Add($topicFrame); [void]$rowTopic.Controls.Add($btnCopy); Add-Body $pSub $rowTopic
$script:lblCopyInfo = New-Label 'lblCopyInfo' '' $FONT_S $GRAY; Add-Body $pSub $lblCopyInfo
Add-Body $pSub (New-Label 'lblSubWarn' "Anyone who sees this code or topic can read your Claude notifications. Do not share a screenshot of this window." $FONT_S $AMBER)
$script:btnSendTest = New-Button 'btnSendTest' 'Send test notification' $true; Add-Foot $pSub $btnSendTest
$script:btnSubBack = New-Button 'btnSubBack' 'Back'; Add-Foot $pSub $btnSubBack

# --- page: test ---
$script:pTest = New-Page 'pageTest'
Add-Body $pTest (New-Label 'lblTestTitle' 'Step 3 of 3: Check your phone' $FONT_T)
$script:lblTestState = New-Label 'lblTestState' '' $FONT_B; Add-Body $pTest $lblTestState
$script:lblTestText = New-Label 'lblTestText' '' $FONT; Add-Body $pTest $lblTestText
Add-Body $pTest (New-Label 'lblTestNote' "Phone notifications stay OFF until you tell us the test arrived." $FONT_S $GRAY)
$script:btnGotIt = New-Button 'btnGotIt' 'I got it' $true; $btnGotIt.Enabled = $false; Add-Foot $pTest $btnGotIt
$script:btnNotGot = New-Button 'btnNotGot' "I didn${APOS}t get it"; $btnNotGot.Enabled = $false; Add-Foot $pTest $btnNotGot
$script:btnSendAgain = New-Button 'btnSendAgain' 'Send again'; Add-Foot $pTest $btnSendAgain
$script:btnTestBack = New-Button 'btnTestBack' 'Back to the code'; Add-Foot $pTest $btnTestBack

# --- page: help ---
$script:pHelp = New-Page 'pageHelp'
Add-Body $pHelp (New-Label 'lblHelpTitle' "Let${APOS}s find out why" $FONT_T)
Add-Body $pHelp (New-Label 'lblHelpText' ("1. In the ntfy app, check that you tapped Subscribe for your topic.`r`n`r`n2. If you typed the topic, check every letter. It is safer to use Copy and paste.`r`n`r`n3. On Android 13 or newer, allow ntfy to show notifications (Settings > Apps > ntfy > Notifications).`r`n`r`n4. Make sure the phone is online.`r`n`r`n5. Phone notifications stay OFF until a test arrives and you confirm it."))
$script:btnHelpAgain = New-Button 'btnHelpAgain' 'Send the test again' $true; Add-Foot $pHelp $btnHelpAgain
$script:btnHelpQr = New-Button 'btnHelpQr' 'Show the code again'; Add-Foot $pHelp $btnHelpQr
$script:btnHelpSkip = New-Button 'btnHelpSkip' 'Skip for now'; Add-Foot $pHelp $btnHelpSkip

# --- page: done ---
$script:pDone = New-Page 'pageDone'
Add-Body $pDone (New-Label 'lblDoneTitle' 'Phone notifications are ON' $FONT_T $GREEN)
Add-Body $pDone (New-Label 'lblDoneText' "You will get a notification on your phone when Claude needs your input or permission, finishes a task, or runs into a problem.`r`n`r`nThey only say which project and what kind of event. They never include your conversation.`r`n`r`nYou can turn this off, send another test or create a new topic any time from the Claude Notifier icon in the system tray ($DASH Phone setup$DOTS).")
$script:btnDone = New-Button 'btnDone' 'Close' $true; Add-Foot $pDone $btnDone

# --- page: status (reopened after setup) ---
$script:pStatus = New-Page 'pageStatus'
Add-Body $pStatus (New-Label 'lblStatusTitle' 'Phone notifications' $FONT_T)
$script:lblStatusLine = New-Label 'lblStatusLine' '' $FONT_B; Add-Body $pStatus $lblStatusLine
$script:lblStatusText = New-Label 'lblStatusText' '' $FONT; Add-Body $pStatus $lblStatusText
$script:btnStatusClose = New-Button 'btnStatusClose' 'Close' $true; Add-Foot $pStatus $btnStatusClose
$script:btnRotate = New-Button 'btnRotate' "Create a new topic$DOTS"; Add-Foot $pStatus $btnRotate
$script:btnStatusQr = New-Button 'btnStatusQr' 'Show the code again'; Add-Foot $pStatus $btnStatusQr
$script:btnStatusTest = New-Button 'btnStatusTest' 'Send a test'; Add-Foot $pStatus $btnStatusTest
$script:btnTogglePhone = New-Button 'btnTogglePhone' 'Turn off'; Add-Foot $pStatus $btnTogglePhone
$pStatus.foot.Height = 112      # five buttons do not fit on one row: the second row used to be cut off, so "Send a test" and "Turn off" were hidden

# --- page: problem (damaged settings) ---
$script:pProblem = New-Page 'pageProblem'
Add-Body $pProblem (New-Label 'lblProblemTitle' 'The saved phone settings are damaged' $FONT_T $RED)
Add-Body $pProblem (New-Label 'lblProblemText' "Claude Notifier will not change them by itself.`r`n`r`nIf you start over, the damaged file is kept next to it as a backup and a new private topic is created. You will then set up your phone again.")
$script:btnRecover = New-Button 'btnRecover' 'Start over' $true; Add-Foot $pProblem $btnRecover
$script:btnProblemClose = New-Button 'btnProblemClose' 'Close'; Add-Foot $pProblem $btnProblemClose

$form.Controls.Add($lblNotice); $lblNotice.BringToFront()
$script:pages = @{ check = $pCheck; app = $pApp; subscribe = $pSub; test = $pTest; help = $pHelp; done = $pDone; status = $pStatus; problem = $pProblem }

# ---------- theming ----------
function Set-Button-Theme($b) {
  if ($null -eq $script:Pal) {
    # High Contrast: the native button, drawn by Windows with the user's own colours
    $b.UseSystem = $true; $b.UseVisualStyleBackColor = $true
  } else {
    $b.UseSystem = $false
    if ($b.Primary) {
      $b.Face = (C 'accent'); $b.FaceHover = (C 'accentHover'); $b.FacePressed = (C 'accentPressed'); $b.Border = (C 'accent'); $b.TextColor = (C 'accentText'); $b.InnerRing = (C 'accentText')
    } else {
      $b.Face = (C 'buttonBg'); $b.FaceHover = (C 'buttonHover'); $b.FacePressed = (C 'buttonPressed'); $b.Border = (C 'borderStrong'); $b.TextColor = (C 'text'); $b.InnerRing = [System.Drawing.Color]::Empty
    }
    $b.FaceDisabled = (C 'disabledBg'); $b.BorderDisabled = (C 'border'); $b.TextDisabled = (C 'textDisabled'); $b.FocusRing = (C 'focus')
  }
  $b.Invalidate()
}
function Set-Control-Theme($c) {
  if ($c -is [Native.ThemedButton]) { Set-Button-Theme $c; return }
  if ($c -is [System.Windows.Forms.Form]) { $c.BackColor = (C 'bg'); $c.ForeColor = (C 'text') }
  elseif ($c -is [System.Windows.Forms.LinkLabel]) {
    $c.LinkColor = (C 'link'); $c.VisitedLinkColor = (C 'link'); $c.ActiveLinkColor = (C 'accentHover'); $c.DisabledLinkColor = (C 'textDisabled'); $c.ForeColor = (C 'text')
  }
  elseif ($c -is [System.Windows.Forms.Label]) {
    if ($c.Name -eq 'lblNotice') { $c.BackColor = (C 'noticeBg'); $c.ForeColor = (C 'noticeText') }
    else { $tone = if ($c.Tag) { [string]$c.Tag } else { 'text' }; $c.ForeColor = (C $tone) }
  }
  elseif ($c -is [System.Windows.Forms.TextBox]) { $c.BackColor = (C 'surface'); $c.ForeColor = (C 'text') }
  elseif ($c -is [System.Windows.Forms.PictureBox]) { }   # the QR code: always black on white
  elseif ($c -is [System.Windows.Forms.Panel]) {
    if ($c.Name -like '*.buttons' -or $c.Name -eq 'dlgFooter') { $c.BackColor = (C 'surface') }
    elseif ($c.Name -eq 'topicFrame') { $c.BackColor = $(if ($txtTopic.Focused) { C 'focus' } else { C 'borderStrong' }) }
    else { $c.BackColor = (C 'bg') }
  }
  foreach ($k in $c.Controls) { Set-Control-Theme $k }
}
function Set-TitleBar($f) { [void][Native.Dpi]::SetDarkTitleBar($f.Handle, ($script:themeMode -eq 'dark')) }
function Apply-Theme($t) {
  $hc = [bool]$t.highContrast -or [System.Windows.Forms.SystemInformation]::HighContrast
  $pal = $null
  if (-not $hc -and $t.colors) {
    $pal = @{}
    foreach ($p in $t.colors.PSObject.Properties) { if ([string]$p.Value -match '^#[0-9A-Fa-f]{6}$') { $pal[[string]$p.Name] = [System.Drawing.ColorTranslator]::FromHtml([string]$p.Value) } }
    if ($pal.Count -eq 0) { $pal = $null }
  }
  $script:Pal = $pal
  $script:themeMode = $(if ($null -eq $pal) { 'contrast' } elseif ([string]$t.mode -eq 'dark') { 'dark' } else { 'light' })
  $form.SuspendLayout()
  try {
    Set-TitleBar $form
    Set-Control-Theme $form
    if ($script:dialog) { Set-TitleBar $script:dialog; Set-Control-Theme $script:dialog }
  } finally { $form.ResumeLayout($true) }
  $form.Refresh()
  Send @{ evt = 'themed'; mode = $script:themeMode }
}

# ---------- the themed confirmation dialog (replaces the native message box) ----------
function Show-Confirm([string]$title, [string]$message) {
  $dlg = New-Object System.Windows.Forms.Form; $dlg.Name = 'dlgConfirm'; $dlg.Text = $title
  $dlg.FormBorderStyle = 'FixedDialog'; $dlg.MaximizeBox = $false; $dlg.MinimizeBox = $false; $dlg.ShowInTaskbar = $false; $dlg.StartPosition = 'CenterParent'
  $dlg.Font = $FONT; $dlg.AutoScaleMode = 'Dpi'; $dlg.AutoScaleDimensions = New-Object System.Drawing.SizeF(96, 96)
  $icon = New-Object System.Windows.Forms.PictureBox; $icon.Name = 'dlgIcon'; $icon.SizeMode = 'CenterImage'; $icon.Size = New-Object System.Drawing.Size(40, 40); $icon.Location = New-Object System.Drawing.Point(22, 22)
  try { $icon.Image = [System.Drawing.SystemIcons]::Warning.ToBitmap() } catch { }
  $text = New-Object System.Windows.Forms.Label; $text.Name = 'dlgText'; $text.Text = $message; $text.Font = $FONT; $text.AutoSize = $false; $text.Location = New-Object System.Drawing.Point(72, 24)
  $w = 372; $h = $text.GetPreferredSize((New-Object System.Drawing.Size($w, 0))).Height + 4
  $text.Size = New-Object System.Drawing.Size($w, $h)
  $foot = New-Object System.Windows.Forms.FlowLayoutPanel; $foot.Name = 'dlgFooter'; $foot.Dock = 'Bottom'; $foot.Height = 56; $foot.FlowDirection = 'RightToLeft'; $foot.Padding = New-Object System.Windows.Forms.Padding(12, 4, 12, 4)
  $no = New-Button 'btnDlgNo' 'No' $true; $yes = New-Button 'btnDlgYes' 'Yes'
  $no.DialogResult = 'No'; $yes.DialogResult = 'Yes'; $yes.TabIndex = 0; $no.TabIndex = 1
  [void]$foot.Controls.Add($no); [void]$foot.Controls.Add($yes)       # right-to-left: reads "Yes  No"
  $dlg.ClientSize = New-Object System.Drawing.Size(468, ([Math]::Max($h, 40) + 24 + 24 + 56))
  $dlg.Controls.Add($icon); $dlg.Controls.Add($text); $dlg.Controls.Add($foot)
  $dlg.AcceptButton = $no; $dlg.CancelButton = $no; $dlg.ActiveControl = $no       # "No" is the default, as before; Esc and the X also mean No
  $script:dialog = $dlg
  $null = $dlg.Handle
  Set-TitleBar $dlg; Set-Control-Theme $dlg
  try { $r = $dlg.ShowDialog($script:form) } finally { $script:dialog = $null; $dlg.Dispose() }
  return ($r -eq [System.Windows.Forms.DialogResult]::Yes)
}

# ---------- behaviour ----------
$script:model = $null; $script:page = $null; $script:busy = $false; $script:copiedTopic = $null; $script:ticks = 0
$CLIP_RETRY_MS = 200; $CLIP_RETRIES = 10; $script:clipTries = 0     # a busy clipboard is retried 10 x every 200 ms (2 s in all), never by waiting on the UI thread
function Show-Page([string]$name) {
  foreach ($k in $script:pages.Keys) { $script:pages[$k].panel.Visible = ($k -eq $name) }
  $script:page = $name
  Send @{ evt = 'page'; page = $name }
}
function Show-Notice([string]$text) {
  if ($text) { $lblNotice.Text = $text; $lblNotice.Height = 96; $lblNotice.Visible = $true } else { $lblNotice.Text = ''; $lblNotice.Height = 0; $lblNotice.Visible = $false }
}
function Set-Busy([bool]$busy) {
  $script:busy = $busy
  $form.Cursor = if ($busy) { [System.Windows.Forms.Cursors]::WaitCursor } else { [System.Windows.Forms.Cursors]::Default }
  $btnSendTest.Enabled = -not $busy; $btnSendAgain.Enabled = -not $busy; $btnHelpAgain.Enabled = -not $busy; $btnStatusTest.Enabled = -not $busy; $btnTogglePhone.Enabled = -not $busy; $btnRotate.Enabled = -not $busy
}
function Apply-Model($m) {
  $script:model = $m
  $rows = @($m.rows)
  for ($i = 0; $i -lt 3; $i++) {
    if ($i -lt $rows.Count) {
      $r = $rows[$i]; $ok = ($r.level -eq 'ok')
      $script:rowTitle[$i].Text = ($(if ($ok) { $CHECK } else { $WARN }) + '  ' + [string]$r.title); Set-Tone $script:rowTitle[$i] $(if ($ok) { $GREEN } else { $AMBER })
      $script:rowDetail[$i].Text = [string]$r.detail; $script:rowDetail[$i].Visible = [bool]$r.detail
    }
  }
  if ($m.topic) { $txtTopic.Text = [string]$m.topic }
  $on = [bool]$m.phoneEnabled
  $lblStatusLine.Text = $(if ($on) { "$CHECK  Phone notifications are ON" } else { "Phone notifications are OFF" }); Set-Tone $lblStatusLine $(if ($on) { $GREEN } else { $GRAY })
  $lblStatusText.Text = $(if ($on) { "Your phone gets a notification when Claude needs your input or permission, finishes a task or runs into a problem. Only the project name and the kind of event are sent." } else { "Nothing is sent to your phone right now. Turn it on again, or set up a new topic." })
  $btnTogglePhone.Text = $(if ($on) { 'Turn off' } else { 'Turn on' })
  $btnSendTest.Enabled = [bool]$m.canSendTest -and -not $script:busy
}
function Apply-Qr($qr) { if ($qr) { Set-Qr $picPlay $qr.play; Set-Qr $picDeep $qr.deep } }
function Handle-Result($c) {
  $r = $c.result
  switch ([string]$c.action) {
    'sendTest' {
      Set-Busy $false
      if ($r.ok) {
        $lblTestState.Text = "$CHECK  $($r.title)"; Set-Tone $lblTestState $GREEN; $lblTestText.Text = [string]$r.text
        $btnGotIt.Enabled = $true; $btnNotGot.Enabled = $true; $btnSendAgain.Text = 'Send again'
      } else {
        $lblTestState.Text = "$WARN  $($r.title)"; Set-Tone $lblTestState $AMBER; $lblTestText.Text = [string]$r.text
        $btnGotIt.Enabled = $false; $btnNotGot.Enabled = $false; $btnSendAgain.Text = 'Try again'
      }
      Show-Page 'test'
    }
    'confirm' {
      if ($r.ok) { Show-Page 'done' } else { $lblTestState.Text = "$WARN  Please send a new test"; Set-Tone $lblTestState $AMBER; $lblTestText.Text = 'The last test is too old or was not sent. Press Send again, then tell us if it arrived.'; $btnGotIt.Enabled = $false; $btnNotGot.Enabled = $false }
    }
  }
}
function Close-All { if ($script:dialog) { try { $script:dialog.DialogResult = [System.Windows.Forms.DialogResult]::No } catch { } }; $form.Close() }
function Handle-Command([string]$line) {
  $c = $line | ConvertFrom-Json
  switch ($c.cmd) {
    'theme' { Apply-Theme $c.theme }
    'model' {
      $first = ($null -eq $script:model)
      Apply-Model $c.model; Apply-Qr $c.qr
      if ($first) { $start = if ($c.model.configProblem -and $c.model.configProblem -ne 'missing') { 'problem' } elseif ($c.page) { [string]$c.page } elseif ($c.model.confirmed) { 'status' } else { 'check' }; Show-Page $start; $form.Opacity = 1 }
      elseif ($c.model.configProblem -and $c.model.configProblem -ne 'missing' -and $script:page -ne 'problem') { Show-Page 'problem' }
    }
    'page' { Show-Page ([string]$c.page) }
    'result' { Handle-Result $c }
    'notice' { Show-Notice ([string]$c.text) }
    'focus' { $form.WindowState = 'Normal'; $form.Activate(); $form.BringToFront() }
    'close' { Close-All }
    'exit' { Close-All }
  }
}
function Act([string]$id) { Send @{ evt = 'action'; id = $id } }

$btnCheckNext.add_Click({ Show-Page 'app' })
$btnCheckSkip.add_Click({ Act 'dismiss'; $form.Close() })
$btnAppBack.add_Click({ Show-Page 'check' })
$btnAppNext.add_Click({ Show-Page 'subscribe' })
$lnkPlay.add_LinkClicked({ if ($script:model) { Open-Link ([string]$script:model.playUrl) } })
$lnkFdroid.add_LinkClicked({ if ($script:model) { Open-Link ([string]$script:model.fdroidUrl) } })
$btnSubBack.add_Click({ Show-Page 'app' })
$btnToggleQr.add_Click({
    $show = -not $picDeep.Visible; $picDeep.Visible = $show; $lblQrHidden.Visible = -not $show
    $btnToggleQr.Text = $(if ($show) { 'Hide the code' } else { 'Show the code' })
  })
$btnCopy.add_Click({
    if ($txtTopic.Text) {
      try {
        [System.Windows.Forms.Clipboard]::SetText($txtTopic.Text); $script:copiedTopic = $txtTopic.Text
        $lblCopyInfo.Text = 'Copied. It is removed from the clipboard again after one minute.'; Set-Tone $lblCopyInfo $GRAY; $script:clipTries = 0
        $script:clipTimer.Interval = $(if ($script:model -and $script:model.clipMs) { [int]$script:model.clipMs } else { 60000 }); $script:clipTimer.Stop(); $script:clipTimer.Start()
      } catch { $lblCopyInfo.Text = 'Could not copy. Select the topic and press Ctrl+C.' }
    }
  })
$script:clipTimer = New-Object System.Windows.Forms.Timer; $script:clipTimer.Interval = 60000
$script:clipTimer.add_Tick({
    $script:clipTimer.Stop()
    $r = [Native.Clip]::ClearIfEquals($script:copiedTopic)
    if (($r -eq [Native.Clip]::Busy -or $r -eq [Native.Clip]::Failed) -and $script:clipTries -lt $CLIP_RETRIES) {
      $script:clipTries++; $script:clipTimer.Interval = $CLIP_RETRY_MS; $script:clipTimer.Start(); return     # try again shortly, the window stays responsive
    }
    $script:clipTries = 0
    if ($r -eq [Native.Clip]::Busy -or $r -eq [Native.Clip]::Failed) {
      # still locked after all retries: say so, the code may still be on the clipboard
      $lblCopyInfo.Text = "$WARN  The code could not be removed from the clipboard. Copy something else to replace it."; Set-Tone $lblCopyInfo $AMBER
    } else { $lblCopyInfo.Text = '' }
    $script:copiedTopic = $null
  })
function Start-Test {
  Set-Busy $true
  $lblTestState.Text = "Sending$DOTS"; Set-Tone $lblTestState $GRAY; $lblTestText.Text = 'Sending a test notification to the ntfy server.'
  $btnGotIt.Enabled = $false; $btnNotGot.Enabled = $false
  Show-Page 'test'; Act 'sendTest'
}
$btnSendTest.add_Click({ Start-Test })
$btnSendAgain.add_Click({ Start-Test })
$btnHelpAgain.add_Click({ Start-Test })
$btnStatusTest.add_Click({ Start-Test })
$btnGotIt.add_Click({ Act 'confirm' })
$btnNotGot.add_Click({ Act 'reject'; Show-Page 'help' })
$btnTestBack.add_Click({ Show-Page 'subscribe' })
$btnHelpQr.add_Click({ Show-Page 'subscribe' })
$btnHelpSkip.add_Click({ Act 'dismiss'; $form.Close() })
$btnDone.add_Click({ $form.Close() })
$btnStatusClose.add_Click({ $form.Close() })
$btnProblemClose.add_Click({ $form.Close() })
$btnStatusQr.add_Click({ Show-Page 'subscribe' })
$btnTogglePhone.add_Click({ if ($script:model.phoneEnabled) { Act 'disable' } else { Act 'enable' } })
$btnRecover.add_Click({ Act 'recover'; Show-Page 'check' })
$btnRotate.add_Click({
    $msg = "Create a new topic?`r`n`r`nThe ntfy subscription on your phone for the current topic will STOP working, and phone notifications will be switched OFF until you scan the new code and confirm a new test.`r`n`r`nContinue?"
    if (Show-Confirm 'Create a new topic' $msg) { Act 'rotate'; Show-Page 'subscribe' }
  })

$script:timer = New-Object System.Windows.Forms.Timer; $script:timer.Interval = 100
$script:timer.add_Tick({
    $script:ticks++
    if ($form.Opacity -lt 1 -and $script:ticks -gt 30) { $form.Opacity = 1 }     # safety: never stay invisible if no model arrives
    $line = $null; $n = 0
    while ($n -lt 50 -and $script:queue.TryDequeue([ref]$line)) {
      $n++
      try { Handle-Command $line } catch { Send @{ evt = 'error'; message = $_.Exception.Message } }
    }
  })
# colours before the first theme command arrives (the window is still invisible): system colours; then the notifier sends the real theme
Set-Control-Theme $form
# The host process is started hidden (no console). Windows applies that STARTUPINFO "hide" to the FIRST ShowWindow call of the process,
# which would hide this window too. So consume that first call on purpose, then show the window for real.
$form.add_Shown({ [void][Native.Dpi]::ShowWindow($form.Handle, 5); $form.Activate(); $script:timer.Start(); Send @{ evt = 'ready' } })
$form.add_FormClosed({ $script:timer.Stop(); $script:clipTimer.Stop(); Send @{ evt = 'closed'; page = $script:page } })
$null = $form.Handle
[void][Native.Dpi]::ShowWindow($form.Handle, 0)      # first call: absorbs the inherited "hidden" start state
[System.Windows.Forms.Application]::Run($form)
# the stdin reader thread would keep this process alive after the window is gone: leave explicitly
[Environment]::Exit(0)
