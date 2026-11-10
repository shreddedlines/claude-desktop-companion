# stop-notifier.ps1 -- used by the installer and uninstaller (compiled into them; it is NOT part of the application).
# Stops every process that belongs to ONE installation folder (read from the environment variable CN_APPDIR):
#   the watchdog (supervisor) first, so it cannot restart anything, then the runtime and the PowerShell hosts (tray menu, setup window)
#   started from that folder. Processes of any other folder (for example a development copy) are never touched.
# It repeats until nothing of the folder is left (bounded, about 12 s): a program that was started a moment ago may still be starting
# its children, which a single pass could miss.
# Exit code: 0 = nothing was running, 10 = it was running and is stopped now, 20 = something could not be stopped.
$ErrorActionPreference = 'Stop'
try {
  $app = [Environment]::GetEnvironmentVariable('CN_APPDIR')
  if (-not $app) { exit 20 }
  $prefix = $app.TrimEnd('\') + '\'
  $cmp = [StringComparison]::OrdinalIgnoreCase
  function Get-Mine {
    @(Get-CimInstance Win32_Process | Where-Object {
      if ($_.ProcessId -eq $PID) { return $false }
      if ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, $cmp)) { return $true }
      return [bool]($_.Name -eq 'powershell.exe' -and $_.CommandLine -and $_.CommandLine.IndexOf($prefix, $cmp) -ge 0)
    })
  }
  $stopped = $false
  $deadline = [DateTime]::UtcNow.AddSeconds(12)
  while ($true) {
    $mine = Get-Mine
    if ($mine.Count -eq 0) {
      # nothing now; wait a moment and look once more, in case something was just about to appear
      Start-Sleep -Milliseconds 700
      if ((Get-Mine).Count -eq 0) { break }
      continue
    }
    $stopped = $true
    # the watchdogs first (and their whole tree), so nothing is restarted behind our back
    foreach ($s in @($mine | Where-Object { $_.Name -eq 'ClaudeNotifier.exe' -and $_.CommandLine -match 'supervisor\.js' })) {
      & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $s.ProcessId /T /F 2>&1 | Out-Null
    }
    Start-Sleep -Milliseconds 500
    foreach ($p in (Get-Mine)) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch { } }
    Start-Sleep -Milliseconds 500
    if ([DateTime]::UtcNow -gt $deadline) { break }
  }
  if ((Get-Mine).Count -gt 0) { exit 20 }
  if ($stopped) { exit 10 } else { exit 0 }
} catch { exit 20 }
