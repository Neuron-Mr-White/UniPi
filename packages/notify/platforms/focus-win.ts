/**
 * @pi-unipi/notify — Windows focus detection
 *
 * Checks whether the terminal window is the foreground (active) window
 * by walking the WMI process tree upward from the current process PID
 * and comparing each ancestor against the foreground window's owner PID.
 *
 * This approach works reliably across cmd, PowerShell, and Windows
 * Terminal, unlike GetConsoleWindow which returns NULL in spawned
 * child processes.
 *
 * Requires PowerShell (built-in on Windows 7+).
 */

import { execFile } from "child_process";
import { writeFileSync, rmSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ---------------------------------------------------------------------------
// PowerShell script (embedded)
// ---------------------------------------------------------------------------

const POWERCHECK_SCRIPT = `
param($targetPid)
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WinAPI {
    [DllImport("user32.dll", SetLastError = false)]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", SetLastError = false)]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
}
'@ | Out-Null
$fgHwnd = [WinAPI]::GetForegroundWindow()
[uint32]$fgPid = 0
[void][WinAPI]::GetWindowThreadProcessId($fgHwnd, [ref]$fgPid)
$curPid = $targetPid
$maxDepth = 20
while ($curPid -gt 0 -and $maxDepth-- -gt 0) {
    if ($curPid -eq $fgPid) { Write-Host -NoNewline 'True'; exit }
    $proc = Get-CimInstance -Class Win32_Process -Filter "ProcessId = $curPid" -ErrorAction SilentlyContinue | Select-Object -Property ParentProcessId
    if (-not $proc) { break }
    $curPid = $proc.ParentProcessId
}
Write-Host -NoNewline 'False'
`;

// ---------------------------------------------------------------------------
// Cache — avoid spawning PowerShell on every check
// ---------------------------------------------------------------------------

let cached: { result: boolean; time: number } | null = null;
const CACHE_TTL_MS = 500;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns true when the terminal window that owns the current process is
 * the foreground (active) window on Windows.
 *
 * Works by:
 *   1. Calling Win32 GetForegroundWindow + GetWindowThreadProcessId to
 *      obtain the foreground window's owning PID.
 *   2. Walking the WMI Win32_Process parent chain upward from
 *      process.pid.
 *   3. If any ancestor PID matches the foreground PID the terminal is
 *      considered focused.
 *
 * The result is cached for 500 ms to avoid spawning PowerShell on rapid
 * consecutive checks (e.g. batch notifications).
 */
export async function isWindowFocusedOnWindows(): Promise<boolean> {
  const now = Date.now();
  if (cached && now - cached.time < CACHE_TTL_MS) {
    return cached.result;
  }

  let tmpDir: string | null = null;
  try {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-focus-"));
    const scriptPath = join(tmpDir, "check.ps1");
    writeFileSync(scriptPath, POWERCHECK_SCRIPT, "utf-8");

    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          scriptPath,
          String(process.pid),
        ],
        { timeout: 5000, encoding: "utf-8" },
        (err, out) => {
          if (err) reject(err);
          else resolve(out);
        }
      );
    });

    cached = { result: stdout.trim() === "True", time: Date.now() };
    return cached.result;
  } catch {
    // Detection failure → safe default: assume NOT focused (don't suppress)
    cached = { result: false, time: Date.now() };
    return false;
  } finally {
    if (tmpDir) {
      try {
        rmSync(tmpDir, { recursive: true });
      } catch {
        // Temp file cleanup is non-critical
      }
    }
  }
}
