<#
  app-shortcut.ps1 — creates the per-user Start Menu shortcut that gives this unpackaged app a toast identity.
  Windows only shows banners for desktop apps whose AppUserModelID is attached to a Start Menu shortcut
  (the registry entry alone makes toasts post to the Action Center but not pop up).

  Dot-source and call:  Ensure-AppShortcut -Aumid ... -Name 'Claude Notifier' -Target <exe> -Arguments <args>
  Writes exactly one file: %APPDATA%\Microsoft\Windows\Start Menu\Programs\<Name>.lnk  (no admin).
  Remove with: node notifier.js --unregister
#>
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

public static class AppShortcut {
  [ComImport, Guid("00021401-0000-0000-C000-000000000046")] class CShellLink { }

  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
  interface IShellLinkW {
    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder f, int c, IntPtr d, int fl);
    void GetIDList(out IntPtr p); void SetIDList(IntPtr p);
    void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder f, int c);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string s);
    void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder f, int c);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string s);
    void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder f, int c);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string s);
    void GetHotkey(out short h); void SetHotkey(short h);
    void GetShowCmd(out int s); void SetShowCmd(int s);
    void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder f, int c, out int i);
    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string f, int i);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string s, int r);
    void Resolve(IntPtr w, int f);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string s);
  }

  [StructLayout(LayoutKind.Sequential, Pack = 4)] struct PropertyKey { public Guid fmtid; public uint pid; }
  [StructLayout(LayoutKind.Explicit, Size = 24)] struct PropVariant {
    [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr ptr;
  }

  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
  interface IPropertyStore {
    void GetCount(out uint c); void GetAt(uint i, out PropertyKey k);
    void GetValue(ref PropertyKey k, out PropVariant v);
    void SetValue(ref PropertyKey k, ref PropVariant v);
    void Commit();
  }

  [DllImport("ole32.dll")] static extern int PropVariantClear(ref PropVariant pv);

  public static void Create(string lnkPath, string target, string arguments, string workDir, string description, string aumid) {
    var link = (IShellLinkW)new CShellLink();
    link.SetPath(target); link.SetArguments(arguments ?? ""); link.SetWorkingDirectory(workDir ?? ""); link.SetDescription(description ?? "");
    var store = (IPropertyStore)link;
    var key = new PropertyKey { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };  // System.AppUserModel.ID
    var pv = new PropVariant { vt = 31, ptr = Marshal.StringToCoTaskMemUni(aumid) };                   // VT_LPWSTR
    store.SetValue(ref key, ref pv); store.Commit(); PropVariantClear(ref pv);
    ((IPersistFile)link).Save(lnkPath, true);
  }
}
'@

function Ensure-AppShortcut([string]$Aumid, [string]$Name, [string]$Target, [string]$Arguments, [string]$WorkDir) {
  $dir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
  $lnk = Join-Path $dir ($Name + '.lnk')
  if (-not (Test-Path $lnk)) { [AppShortcut]::Create($lnk, $Target, $Arguments, $WorkDir, 'Claude Notifier tray app', $Aumid) }
  return $lnk
}
