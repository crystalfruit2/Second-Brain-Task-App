param(
    [string]$TitleMatch = "Claude"
)

Add-Type @"
using System;
using System.Runtime.InteropServices;

public class WinApi {
    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter,
        int X, int Y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern long GetWindowLong(IntPtr hWnd, int nIndex);

    public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    public static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
    public const uint SWP_NOMOVE = 0x0002;
    public const uint SWP_NOSIZE = 0x0001;
    public const int GWL_EXSTYLE = -20;
    public const long WS_EX_TOPMOST = 0x0008;
}
"@

function Get-WindowTitle([IntPtr]$hwnd) {
    $sb = New-Object System.Text.StringBuilder 256
    [WinApi]::GetWindowText($hwnd, $sb, 256) | Out-Null
    return $sb.ToString()
}

# Terminal apps host Claude Code under a dynamic tab title (e.g. a task summary),
# which never contains "Claude" -- title matching alone can't find these, so fall
# back to "foreground window belongs to a known terminal host process".
$TerminalHosts = @('WindowsTerminal', 'powershell', 'pwsh', 'cmd')

# Prefer the current foreground window if it matches (by title, or by being a terminal
# host when we're looking for "Claude"); else scan processes' main windows by title.
$target = [IntPtr]::Zero
$fg = [WinApi]::GetForegroundWindow()
$fgProc = Get-Process | Where-Object { $_.MainWindowHandle -eq $fg } | Select-Object -First 1
if ((Get-WindowTitle $fg) -like "*$TitleMatch*") {
    $target = $fg
} elseif ($fgProc -and $TitleMatch -eq "Claude" -and $TerminalHosts -contains $fgProc.ProcessName) {
    $target = $fg
} else {
    $proc = Get-Process | Where-Object {
        $_.MainWindowTitle -like "*$TitleMatch*" -and $_.MainWindowHandle -ne [IntPtr]::Zero
    } | Select-Object -First 1
    if ($proc) { $target = $proc.MainWindowHandle }
}

if ($target -eq [IntPtr]::Zero) {
    Write-Output "NOTFOUND"
    exit 1
}

$exStyle = [WinApi]::GetWindowLong($target, [WinApi]::GWL_EXSTYLE)
$isTopmost = ($exStyle -band [WinApi]::WS_EX_TOPMOST) -ne 0

if ($isTopmost) {
    [WinApi]::SetWindowPos($target, [WinApi]::HWND_NOTOPMOST, 0, 0, 0, 0,
        [WinApi]::SWP_NOMOVE -bor [WinApi]::SWP_NOSIZE) | Out-Null
    Write-Output "UNPINNED"
} else {
    [WinApi]::SetWindowPos($target, [WinApi]::HWND_TOPMOST, 0, 0, 0, 0,
        [WinApi]::SWP_NOMOVE -bor [WinApi]::SWP_NOSIZE) | Out-Null
    Write-Output "PINNED"
}
