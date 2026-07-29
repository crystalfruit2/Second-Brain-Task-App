# Pin-window (always-on-top) integration

Status: implemented, unstaged in working tree, not yet run against a live Claude
window by Alp. Written 2026-07-27.

## Problem

Alp wants to keep a Claude window visible on top of Obsidian while he works,
without manually re-focusing/re-arranging. Electron's `BrowserWindow` has a
native `setAlwaysOnTop()`, but that only applies to windows **this app owns**.
Claude (desktop app or a browser tab) is a separate, unrelated OS process —
Electron/Node has no built-in way to reach into another process's window.

Windows itself also has no user-facing "pin any window on top" toggle (macOS
doesn't either, for what it's worth). So this had to be built at the Win32 API
level.

## Mechanism

Every top-level window on Windows has an extended window style bit,
`WS_EX_TOPMOST`, that the compositor checks to keep it above non-topmost
windows. You flip it with `user32.dll`'s `SetWindowPos`, passing the special
handle `HWND_TOPMOST` (`-1`) or `HWND_NOTOPMOST` (`-2`) as the
"insert-after" window — this is the exact mechanism third-party tools like
PowerToys' "Always on Top" module use.

Node has no built-in FFI to call `user32.dll` directly (that would need a
native addon, rebuilt per Electron ABI — real complexity for a one-button
feature). PowerShell, however, ships on every Windows box and can call Win32
via `Add-Type` + `[DllImport]` inline C#, with zero extra dependencies. So the
implementation is: **a small PowerShell script + a compiled-inline C# shim to
call three `user32.dll` functions**, invoked as a child process from
Electron's main process.

### The three Win32 calls used

| Function | Purpose |
|---|---|
| `GetForegroundWindow` | Get the handle of whatever window currently has focus |
| `GetWindowLong(hwnd, GWL_EXSTYLE)` | Read the window's extended style bits, check `WS_EX_TOPMOST` to know current pinned state |
| `SetWindowPos(hwnd, HWND_TOPMOST \| HWND_NOTOPMOST, ...SWP_NOMOVE\|SWP_NOSIZE)` | Actually flip the pin, without moving/resizing the window |

### Window targeting logic

The script doesn't just grab whatever's focused — that would misfire if you
click the pin button while some other window is active. Instead
(`src/native/pin-window.ps1`):

1. If the **current foreground window's title** contains the match string
   (default `"Claude"`), use it.
2. Otherwise, enumerate all processes via `Get-Process`, filter to those with
   a non-empty `MainWindowTitle` matching the string, and take the first.

This means: focus the Claude window and hit pin → it pins immediately: (1)
above. Hit pin from inside the Second Brain notes widget while Claude is open
somewhere in the background → still finds it via (2), no need to
alt-tab first.

### State read-back, not blind toggle

The script doesn't just always set `HWND_TOPMOST`. It reads the current
`WS_EX_TOPMOST` bit first and flips the opposite way, then prints which state
it landed in:

```
PINNED    — window is now always-on-top
UNPINNED  — window is now normal (topmost cleared)
NOTFOUND  — no window matched the title (exit code 1)
```

This return value round-trips back to the Electron renderer so the UI button
can reflect real state (see below) instead of guessing.

## Two artifacts exist — know which is which

I built this twice, intentionally, at two different points in the
conversation:

1. **`second_brain/scripts/Pin-Window.ps1` + `Pin-Claude.bat`** (vault repo,
   root `scripts/`) — a **standalone** tool. Double-click the `.bat`, or bind
   a Windows shortcut hotkey to it (native OS feature: right-click a
   `.lnk` → Properties → "Shortcut key"). No app dependency; works even if
   the Electron app isn't running. Prints a human-readable message
   (`Write-Host`), not machine-parseable output — it was built to be run
   directly by a person, not by other code.

2. **`second-brain-task-app/src/native/pin-window.ps1`** (this integration)
   — a **near-identical but separate copy**, bundled inside the Electron app
   so the app is self-contained (doesn't reach across into the vault repo's
   `scripts/` folder, which could move or not exist on another machine).
   Output is machine-parseable (`Write-Output "PINNED"` etc.) because
   `main.js` parses `stdout` to update the button state.

These two files will drift if one is edited and not the other — there's no
shared module between the two repos. If you want a single source of truth,
options: (a) leave them duplicated (they're ~50 lines, low churn), (b)
have the app's copy be the canonical one and make the vault `.bat` just
shell out to it, or (c) extract to a tiny published npm package /
vault-local module both consume. I left it duplicated for now since it's
cheap and the two have genuinely different callers (human double-click vs.
IPC).

## What changed in `second-brain-task-app`

```
src/native/pin-window.ps1     new — the Win32 shim, machine-parseable output
src/main.js                   + pinExternalWindow(), tray menu item, IPC handler
src/preload.js                + window.brain.pinClaude()
src/renderer/index.html       + 📌 button in the Notes widget header
src/renderer/renderer.js      + click handler, button state sync
src/renderer/styles.css       + .win-btn.active style (reused from dock-btn pattern)
```

### `src/main.js`

```js
const { execFile } = require('child_process');
...
const PIN_SCRIPT = path.join(__dirname, 'native', 'pin-window.ps1');

function pinExternalWindow(titleMatch = 'Claude') {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PIN_SCRIPT, '-TitleMatch', titleMatch],
      { windowsHide: true },
      (err, stdout) => {
        if (err) return resolve('NOTFOUND');   // covers exit code 1 (no match)
        resolve(stdout.trim());
      }
    );
  });
}
```

- `windowsHide: true` suppresses the console flash that a naive
  `child_process.exec('powershell ...')` would otherwise show.
- `-ExecutionPolicy Bypass` is scoped to this one invocation only (a
  `-File` flag, not a system-wide policy change) — doesn't touch Alp's
  actual PowerShell execution policy.
- Exposed two ways: a tray menu item (`Pin Claude on top`) for when the
  Notes widget itself isn't open, and an `ipcMain.handle('window:pinClaude', ...)`
  for the in-widget button.

### `src/preload.js`

```js
pinClaude: () => ipcRenderer.invoke('window:pinClaude'),
```

Standard `contextBridge` pattern already used for every other IPC call in
this app (`appendNote`, `listTasks`, etc.) — no new precedent introduced.

### `src/renderer/renderer.js`

```js
const pinBtn = document.getElementById('pin-claude');
pinBtn.addEventListener('click', async () => {
  pinBtn.disabled = true;
  try {
    const result = await window.brain.pinClaude();
    pinBtn.classList.toggle('active', result === 'PINNED');
    pinBtn.title = result === 'NOTFOUND'
      ? 'No Claude window found — open it first'
      : result === 'PINNED'
        ? 'Claude pinned on top (click to unpin)'
        : 'Pin Claude window on top';
  } finally {
    pinBtn.disabled = false;
  }
});
```

Note this is **optimistic-free** — it doesn't flip local UI state before the
call resolves; it waits for the real `PINNED`/`UNPINNED`/`NOTFOUND` from the
PowerShell child process (typically 200–400ms for `powershell.exe` cold
start) and reflects that. Button is disabled for the duration so a double
click can't race two toggles against each other.

## Known limitations / things worth deciding on

1. **Title matching is substring, case-sensitive-off (`-like "*Claude*"`).**
   If you ever have a browser tab titled something like "How to build a
   Claude agent — Anthropic Docs" focused in the same Chrome window, that
   window would match too (Chrome's title reflects the active tab). Low risk
   in practice but worth knowing — the match isn't scoped to a specific
   process name (e.g. `claude.exe`), just any window title. If you want it
   tightened to only the Claude *desktop app* (excluding browser tabs), I
   can change the process filter to match on `.ProcessName` instead of/in
   addition to title.

2. **No global hotkey inside the Electron app for this specific action** —
   only the header button + tray item. The vault's standalone `.bat` route
   already has the native Windows shortcut-key hotkey option; wiring an
   Electron `globalShortcut` for pin-toggle specifically would be a small
   add if wanted (this app already has one deferred global-shortcut item on
   its roadmap for summoning the Notes widget itself — could bundle both).

3. **`NOTFOUND` state isn't visually distinct from `UNPINNED` beyond the
   tooltip text** — the button just doesn't get `.active`. If you want a
   third visual state (e.g. greyed out / warning color) for "nothing to
   pin", that's a small CSS/JS addition.

4. **Duplication between the two `pin-window.ps1` copies** — see above.

5. **Not committed.** Per the working agreement for this repo
   (`Projects/Second-Brain-Task-App.md` → "Working agreement": Claude edits,
   Alp commits & pushes, no `Co-Authored-By: Claude`), everything above is
   sitting unstaged in the working tree. Review, adjust, `git add` / commit
   yourself when satisfied.

## How to test manually

```powershell
cd C:\Users\User\Desktop\Projects\second-brain-task-app
npm start
```

Open (or focus) a Claude window somewhere, then in the Notes widget click
📌. It should visibly toggle Claude above/below Obsidian and other windows,
and the button should highlight when pinned. Tray menu → "Pin Claude on top"
does the same without needing the widget open.

To test the raw mechanism in isolation (bypassing Electron entirely):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File src\native\pin-window.ps1 -TitleMatch "Claude"
```
