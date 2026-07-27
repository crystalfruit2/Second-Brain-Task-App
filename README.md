# Second Brain Task App

Electron desktop companion for the [second_brain](../second_brain) vault.

A small, frameless, always-on-top window that floats over whatever you're
reading. Two tabs:

- **Notes** — type a note, hit Enter, and it appends a timestamped bullet to
  today's `Daily/YYYY-MM-DD.md` under `## Quick Notes`, so Claude picks it up as
  vault content and manages it from there.
- **Timer** — Focus (count-up) and Pomodoro (25/5 cycles) modes. Completed and
  partial sessions are written to `AI/pomodoro-log.json` (`logged:false`), so the
  vault's existing `/pomodoro` **"log session"** flow syncs them into the daily
  note + matched Learning note untouched.

**Window:** dock it flush to any edge via the footer (`⇤ ⤒ ⤓ ⇥ ⧉`) or the tray
"Dock" menu; left/right give a full-height side panel, top/bottom a centered
card, float a top-right card. Position/size are remembered between launches.
`–` hides to the tray, `×` quits.

Planned next: the 3-panel **Tasks / Reading / Projects** dashboard, and a global
hotkey to summon the widget (see the vault note `Projects/Second-Brain-Task-App.md`).

## Run

```powershell
npm install
npm start
```

The app lives in the system tray. Click the tray icon (or use the menu) to
show/hide the notes window. `Esc` hides it; `Enter` sends, `Shift+Enter` adds a
line.

## Config

The vault path defaults to `~/Desktop/Projects/second_brain`. Override it:

```powershell
$env:SECOND_BRAIN_VAULT = "D:\path\to\second_brain"; npm start
```

## Layout

- `src/main.js` — Electron main process: window, tray, IPC.
- `src/preload.js` — contextBridge exposing `window.brain`.
- `src/vault.js` — all vault filesystem read/write (Quick Notes append/read).
- `src/config.js` — vault path resolution.
- `src/renderer/` — the widget UI.
