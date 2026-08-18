# Second Brain Task App — how I built this

This is my own writeup of the app, in my own voice, so I have one place that
explains what I built and why, without having to re-derive it from the code
every time. If I forget why something is the way it is, this is where I look
first.

## Why I started this

I kept answering "what should I be doing" by having Claude re-derive it live
every session — read today's daily note, read the project notes, read
memory, write it back as prose/checkboxes. That works, but it's ephemeral
and single-day. There's no persistent view I can just *open* and see the
current state of everything without asking Claude to reconstruct it. So I
decided to build that view myself, as a real app, instead of re-explaining
it every session.

I also wanted a way to jot a note down instantly, without switching to
Obsidian, finding today's daily note, and scrolling to the right section —
something that floats over whatever I'm looking at and gets out of the way
immediately.

## What it actually is

A small Electron desktop app with two windows:

1. **The Notes widget** — frameless, always-on-top, small (340×480 floated,
   or docked flush to a screen edge). Three tabs: **Notes** (quick capture),
   **Timer** (Focus / Pomodoro), and **Article** (structured reading notes).
   This is the window that's meant to always be around, tray-toggleable.
2. **The Dashboard** — a normal window, four columns: Tasks, Reading,
   Projects, Sessions. This is the "what should I be doing" view, plus (as
   of 2026-08-10) "what am I actually running right now." Opened from the
   tray or a button in the widget header, not auto-shown on launch.

Both windows read and write my actual vault directly — there's no database,
no API server, no sync step. The vault markdown *is* the data. This was a
deliberate choice: I didn't want a second source of truth that Claude (or
I) would have to remember to keep in sync with the notes themselves.

## Why Electron, why not a web app

I originally scoped this as a standalone web app. Then I added the
requirement that the notes capture widget needs to float on top of
everything else on screen, always-on-top, over a maximized window even —
and a browser tab fundamentally can't do that. That single requirement is
what forced the shell decision. I picked Electron over Tauri because it's
pure JS/TS with no Rust toolchain to install — faster to get moving on a
personal tool I'm the only user of.

## How it talks to the vault

No API layer. The Electron **main process** (Node) reads and writes vault
markdown files directly with `fs` — frontmatter via `gray-matter`,
checkboxes via a small regex-based parser I wrote myself
(`- [ ]` / `- [x]`). The **renderer** (the actual UI, running in a sandboxed
Chromium context) never touches the filesystem directly — it only ever
calls into the main process over IPC, through a `contextBridge` I exposed
as `window.brain`. This is standard Electron security practice
(`contextIsolation: true`, `nodeIntegration: false`) — the UI can't run
arbitrary Node code even if something in the renderer got compromised, it
can only call the specific functions I chose to expose.

Vault path resolution: `src/config.js` defaults to
`~/Desktop/Projects/second_brain`, overridable via `SECOND_BRAIN_VAULT` env
var — useful since I work across machines (Mac for dev, Windows for the
DARE-MOT benchmark runs) and the vault path differs by OS.

## The Notes tab

Type a note, hit Enter (Shift+Enter for a newline), it appends a
timestamped bullet — `- HH:MM — text` — to today's `Daily/YYYY-MM-DD.md`
under a `## Quick Notes` heading. This is all handled in `src/vault.js`:

- If today's daily note doesn't exist yet, it seeds a minimal one (just
  enough frontmatter + a Quick Notes section) rather than clobbering
  whatever the real `/start-day` template would create later if that runs
  after.
- If `## Quick Notes` doesn't exist in an existing note, it inserts the
  section right before `## Pomodoro Log` or `## End of Day` (whichever it
  finds first), so it lands alongside the day's other running logs instead
  of at a random spot.
- New notes stack newest-last under existing ones in the section (it walks
  past the blockquote hint line and any existing bullets before inserting).
- Multi-line captures indent the continuation lines under the bullet.

The widget also reads back and displays today's captures in a scrollable
list under the input, so I can see what I've already logged today without
switching to Obsidian.

## The Timer tab

Native re-implementation of the `/pomodoro` skill's UI, at the same compact
size, with two modes:

- **Focus** — simple count-up stopwatch.
- **Pomodoro** — 25-minute work / 5-minute break cycles, with a dot per
  completed pomodoro (up to 8 shown).

Both need a task name typed in before Start will actually start (forces me
to name what I'm doing, not just start a blank timer).

Completed and partial sessions get written to `AI/pomodoro-log.json` with
`logged: false` — same schema the Python `server.py` behind the `/pomodoro`
skill already writes. That was the key integration decision: I didn't want
to build a second logging pipeline, so the widget's timer just feeds into
the existing one. The existing `/pomodoro` "log session" flow (Claude-side)
picks up anything with `logged: false` and syncs it into the daily note and
the matched Learning note, unchanged from before this app existed.

Logging rules: breaks are never logged. A completed pomodoro logs itself
the moment it finishes (25 min, full pomodoro count so far). Hitting Stop
mid-session logs whatever was actually worked in the current segment
(pause-aware — time spent paused doesn't count), but only if it's at least
a minute; anything shorter is just discarded, not worth a log entry.

## Window behavior (the widget)

- **Frameless, always-on-top** — `alwaysOnTop: true` plus
  `setAlwaysOnTop(true, 'screen-saver')` specifically so it floats above
  fullscreen apps too (e.g. a maximized PDF), not just normal windows.
  `setVisibleOnAllWorkspaces` with `visibleOnFullScreen: true` for the same
  reason.
- **Docking** — footer buttons (`⇤ ⤒ ⤓ ⇥ ⧉`) or the tray "Dock" submenu snap
  it: left/right edges give a full-height 340px-wide side panel, top/bottom
  give a centered 340×340 card flush to that edge, float puts it top-right
  as a 340×480 card. Bounds are computed off `screen.getDisplayNearestPoint`'s
  work area, so it respects the taskbar and lands on whichever monitor it's
  already on.
- **Position memory** — window bounds get written to
  `userData/window-state.json` (debounced 400ms on move/resize) and
  restored on next launch, so I don't have to re-dock it every time I open
  the app.
- **Tray behavior** — clicking the tray icon toggles show/hide. `–` in the
  header hides to tray, `×` fully quits (there's an `isQuitting` flag so
  that closing the window normally doesn't kill the app — it stays running
  in the tray until I explicitly quit).

## The Article tab

Added 2026-07-28. Notes is a flat timestamped log and Timer is a stopwatch —
neither fits sitting down to actually read something and wanting to keep
what mattered. Article is a third mode built for that: not a growing log
like Quick Notes, one real document per article, written straight to
`Resources/` as an actual vault note the moment I save it.

The form, top to bottom:

- **Title** (required), **URL** and **Author/source** (both optional) — the
  metadata header.
- **Highlights** — verbatim quotes/excerpts, kept in its own field, separate
  from **My Thoughts** — my own commentary, reactions, connections to other
  notes. The split matters for the vault's `#needs-review` → `/synthesis`
  workflow later: synthesis wants to know what's *mine* vs. what's *the
  source's*, and a flat notes list loses that distinction.
- **Key Takeaway** (required to save) — forces one line of "the thing worth
  remembering" before the note can be saved, so nothing gets filed as a pile
  of raw highlights with no synthesis at all.

Hitting **Save to Vault** (`vault.js: saveArticleNote`) does the actual
write:

- Refuses to save without a title or a takeaway (`Error` thrown, caught in
  the renderer and shown in the status line — same pattern as `appendNote`'s
  empty-note guard).
- Builds a real frontmatter block matching how I already tag reading
  material by hand — `tags: [resource, article, needs-review]`,
  `status: reference`, `created: <date>`, plus `source:`/`author:` lines
  only when I actually filled those in.
- Filename is the title, slugified for the filesystem and deduped against
  existing Resources notes the way Explorer/Obsidian would
  (`Title.md` → `Title (2).md` → ...) — `uniqueResourcePath()`.
- Sections (`## Key Takeaway`, `## Highlights`, `## My Thoughts`) are only
  written when there's content for them, so a highlight-free "just my
  thoughts" note doesn't end up with a dangling empty heading.
- On success, clears the in-progress draft and resets the form so the tab is
  ready for the next article.

**Draft persistence:** every keystroke in any of the six fields schedules a
debounced (800ms) write of the whole form to `AI/article-draft.json` — a
single JSON object, not an append log, since there's only ever one draft in
flight (`saveArticleDraft`/`readArticleDraft`/`clearArticleDraft` in
`vault.js`). The tab reloads that draft on app start (`loadArticleDraft()`
in `renderer.js`). This exists because reading sessions are the one place in
this app where losing typed text actually hurts — Quick Notes bullets and
timer sessions are each a few seconds of work to redo; a half-written
article note with real thinking in the "My Thoughts" field is not.

I verified the whole path (not just visually) before calling it done: a
throwaway Node script exercised `vault.js`'s article functions directly
against a scratch vault (draft round-trip, missing-title/missing-takeaway
rejection, full save, dedup filename, minimal save with no
highlights/url/source), and separately I ran the actual app, typed into the
real widget, hit Save, and confirmed the file landed correctly in the real
`Resources/` folder before deleting that test note.

**What I didn't build (deferred, in priority order):**

1. **Auto-fetching the title from a pasted URL** — would need loosening the
   renderer's `Content-Security-Policy` (`default-src 'self'`) to allow an
   outbound fetch, plus handling network failures. Not worth the added
   attack surface yet for a field I can type in three seconds by hand.
2. **Tying an article session into the Timer tab** — start Article, timer
   auto-switches to Focus, completion logs reading minutes the same way
   pomodoro sessions log work minutes. Natural follow-up once I've actually
   used the tab for a few real sessions and know if I want that coupling.
3. **Surfacing the Dashboard's Reading queue inside this tab** — so opening
   Article shows what's already queued (`Reading: ...` checkbox items)
   instead of always starting from a blank title field.

## The Dashboard

Second window, normal (not frameless/topmost), 980×720, three columns:

- **Tasks** and **Reading** — both sourced from the same place:
  `## Tasks` checkbox sections across today + the last 7 days of
  `Daily/*.md`. I didn't add a separate `## Reading` heading anywhere —
  instead, any checkbox item whose text starts with "Reading" (case
  insensitive) gets classified as `kind: 'reading'` instead of `'task'`.
  That matches a pattern I was already using in daily notes before this
  app existed, so no vault migration was needed.
- **Projects** — parsed straight from `Resources/project-registry.md`'s
  markdown table (name / status / path / graph columns). The parser has to
  handle `\|`-escaped pipes inside wikilink aliases like `[[Foo\|Bar]]`,
  since that syntax shows up in the registry.

Items are grouped by date (Today / Yesterday / the raw date string beyond
that), checked items sink to the bottom of their group with a strikethrough,
and clicking anywhere on a row toggles it — no separate checkbox target to
aim for. The click writes straight back to the source line in the daily
note via `toggleTaskLine`.

**Write-back safety:** each task item carries a `file` + absolute `line`
index + the exact `raw` line text (all captured when the list was loaded).
When I toggle it, `vault.js` first checks the line at that index still
matches `raw` — if the file changed underneath (I edited it in Obsidian
between loading the dashboard and clicking), it falls back to an exact-text
search for that line instead of blindly overwriting whatever's now at that
index. If neither works, it throws rather than silently corrupting a
different line.

The Projects panel shows name + a 2-line-clamped status (some project
statuses, DARE-MOT especially, are a huge running log — I don't want that
dominating the panel) — click a project card to expand it.

- **Sessions** (added 2026-08-10) — see the dedicated writeup below. Live
  list of my running Claude Code terminals, matched to project names, click
  one for a notes editor.

There's a **⊞ dashboard button** in the Notes widget header too, so I don't
have to go through the tray menu every time.

## The cigarette counter

Added a 🚬 tap counter to the widget header, always visible regardless of
which tab (Notes/Timer/Article) is showing. Left-click logs one, right-click undoes
a misclick. I deliberately didn't build this as a new data store — it
writes into the exact `### Health log — DATE` section I was already writing
by hand in daily notes, the same one `Areas/Health.md`'s trend table rolls
up from. So this doesn't create a second place to look; it just makes the
thing I was already doing by memory (and usually forgetting) a one-tap
action instead.

Mechanically (`vault.js`): the count lives as a single line,
`- 🚬 N cigarettes`, inside that section. A tap reads the current N (0 if
the section or line doesn't exist yet), adds ±1, floors at 0, and rewrites
just that line in place — it's a counter, not a growing list of timestamped
events like Quick Notes. If the section doesn't exist yet for today, it
gets created at the same anchor point Quick Notes uses (just before
`## Pomodoro Log`), so the day's running logs stay grouped together instead
of scattered.

This is intentionally low-friction compared to the checkbox habit tracker I
removed earlier for sitting at 0/5 unused — a single tap with no typing, no
opening Obsidian, no remembering to mention it to Claude at end-of-day.

## IPC surface (`window.brain`)

Everything the renderer can do, end to end:

| Call | What it does |
|---|---|
| `appendNote(text)` | Write a Quick Notes bullet to today's daily note |
| `todayNotes()` | Read back today's captures |
| `logPomodoro(session)` | Append a completed/partial timer session to `AI/pomodoro-log.json` |
| `listTasks()` | Aggregate `## Tasks` checkboxes, today + last 7 days |
| `toggleTask(item)` | Flip one checkbox, write back to source file |
| `listProjects()` | Parse the project registry table |
| `openDashboard()` | Open (or focus) the dashboard window |
| `pinClaude()` | Toggle Windows always-on-top for whatever window matches "Claude" — see [`docs/pin-window-integration.md`](./pin-window-integration.md) for the full writeup on this one, it's a separate mechanism (Win32 API via a bundled PowerShell script, not vault I/O) |
| `cigCount()` | Read today's cigarette count from the Health log section |
| `logCig(delta)` | +1 to log one, -1 to undo a misclick; floors at 0 |
| `saveArticle(data)` | Write a finished article note to `Resources/`, clear the draft |
| `getArticleDraft()` | Read back the in-progress article draft, if any |
| `saveArticleDraft(draft)` | Debounced whole-form autosave to `AI/article-draft.json` |
| `clearArticleDraft()` | Discard the in-progress draft (Clear button) |
| `listSessions()` | One-shot fetch of currently-running `claude` sessions (ps/lsof + registry match) |
| `onSessionsUpdate(cb)` | Subscribe to the Dashboard's live 10s session poll (main process pushes, doesn't wait to be asked) |
| `getSessionNotes(slug)` / `saveSessionNotes({slug,name,text})` | Read/write a session's notes file at `AI/session-notes/<slug>.md` |
| `hide()` / `quit()` / `dock(edge)` | Window chrome controls |
| `openMissionControl()` | Open (or focus) the Mission Control window |
| `todayTasks()` | Today's `## Tasks` checkboxes, grouped by their `### ` sub-headings |
| `lifeThreads()` | Parse `Areas/Life-Threads.md` into threads with latest movement / next pull |
| `inbox()` | Unrouted `Inbox/*.md` captures, with `source: mobile` flagged |
| `health()` | Last rows of `Areas/Health.md`'s trend table + whether today's note has a Health log |
| `reviewsDue()` | Is last completed ISO week / last month missing its review file? |
| `agenda()` | Today + next few days via the vault's `gcal.py agenda` helper |
| `dispatchJob(prompt, label)` | Spawn `claude -p` headlessly with cwd = vault root; returns the job snapshot |
| `dispatchInTerminal(prompt)` | Open Terminal.app in the vault running interactive `claude "<prompt>"` |
| `listJobs()` / `killJob(id)` | Live jobs + persisted history; SIGTERM a running one |
| `onJobUpdate(cb)` / `onJobOutput(cb)` | Push subscriptions for job state changes and streamed output chunks |

The Notes widget also gained a fourth tab, **Tasks** (2026-08-10, redesigned twice same day). First cut aggregated the vault-wide `## Tasks` checkboxes like the Dashboard's Tasks/Reading columns — but that's every open task across every project, and the point of this tab was to follow through on *one* thing without getting distracted. So it's session-scoped instead: it shows the checkbox items (`- [ ]`) written inside whichever session's notes file is currently "pinned" (a small `activeSession` pointer in `window-state.json`, since it's a UI preference, not vault content — pushed live to the widget via `session:activeChanged` if it's open when the Dashboard changes it). Reuses the exact same `toggleTaskLine()` write-back the daily-note tasks use — it already took a plain `(file, line, raw)` triple, so pointing it at a session file instead of a daily note needed zero new write logic, just a new read path (`listSessionTaskItems`).

**Second redesign, same day: sessions stopped collapsing by cwd, and a switcher moved into the tab itself.** I run almost every terminal out of the vault root regardless of what I'm actually working on in it — cwd-based grouping (the original design) collapsed every one of those into a single indistinguishable card. `sessions.js` now returns one entry per running `claude` process, full stop; `pid`/`tty`/start-time are what's left to tell two same-project cards apart until I've written something identifying into that session's own notes. Also added a compact chip row directly in the Tasks tab (`tasks-switcher`) so switching which session I'm following doesn't require opening the Dashboard at all — one-shot `listSessions()` fetch when the tab opens or ⟳ is clicked, not polled, same battery rule as everywhere else in this app.

**Claude can write a session's checklist directly, no app UI required.** Session notes are just real files at `AI/session-notes/<slug>.md` — any Claude Code session (this app doesn't need to be running) can write one with a normal file edit. First real one: `AI/session-notes/second-brain-20171.md`, written live during the 2026-08-10 build session as a self-referential "here's what to test next" checklist.

Every one of these is a thin `ipcRenderer.invoke`/`.send` wrapped in
`contextBridge.exposeInMainWorld('brain', {...})` in `preload.js` — the
renderer literally cannot reach `fs`, `child_process`, or anything else
Node-side except through this explicit list.

## File layout

```
src/
  main.js              Electron main: both windows, tray, all IPC handlers
  preload.js            contextBridge → window.brain
  vault.js               all vault filesystem logic (notes, pomodoro log, tasks, projects, session notes)
  config.js               vault path resolution (env override, Mac/Windows candidates)
  sessions.js              Claude session detection (ps/lsof) + project-registry matching, no Electron dep
  rocky.js                  Rocky job runner: claude-binary resolution, headless spawn + stream-json parsing, job history, Terminal hand-off (no Electron dep either)
  native/
    pin-window.ps1        Win32 always-on-top shim (bundled copy, see pin-window-integration.md; Windows-only)
  renderer/
    index.html / renderer.js / styles.css     the Notes/Timer/Article widget UI
    dashboard.html / dashboard.js / dashboard.css   the Tasks/Reading/Projects/Sessions dashboard UI
    mission-control.html / mission-control.js / mission-control.css   Rocky OS — command bar, state panels, agent monitor
docs/
  ARCHITECTURE.md          this file
  pin-window-integration.md   the pin-Claude-window feature, written up separately
```

## Where this stands right now (2026-07-28)

- **v0** — Notes widget built: capture + read-back, tray toggle, Esc to
  hide.
- **v0.1** — Quit wired up properly, edge docking + remembered position,
  Pomodoro timer merged into the widget as a second tab, feeding the
  existing `/pomodoro` logging pipeline.
- **v0.2** — Dashboard built: Tasks/Reading/Projects, three columns,
  write-back toggling. Verified against the real vault (35 tasks, 3 reading
  items, 15 projects) plus a scratch-copy round-trip test before touching
  real notes, then a live run.
- **v0.2 follow-up** — added the ⊞ dashboard button to the widget header so
  I don't need the tray for that.
- **Pin-Claude-window** — added a 📌 button to pin whichever window matches
  "Claude" always-on-top, using a bundled PowerShell/Win32 shim (own
  writeup, see above).
- **Cigarette counter** — added a 🚬 tap counter to the widget header,
  writing directly into the existing `### Health log` section of the daily
  note (see above).
- **Article tab** — third widget tab for structured reading notes (title,
  URL/author, Highlights vs. My Thoughts, forced Key Takeaway), saved as a
  real note in `Resources/` with `resource`/`article`/`needs-review`
  frontmatter, plus a debounced draft autosave so an in-progress read
  survives a tab switch or a quit (see above).

## Mac port + the Sessions panel (2026-08-10)

I wanted this running on my Mac too, with a real Dock icon, and I wanted a
way to see all the Claude Code terminals I have open across different
projects at a glance — I run a lot of them in parallel and kept losing track
of which one was doing what. And for each one, I wanted my own notes
attached, so re-opening a terminal I haven't touched in days shows me the
"pick up here" context I left myself instead of making me re-derive it.

**Getting it running on Mac:**

- `config.js` was hardcoded to my Windows path. Now it tries
  `~/Documents/Projects/second_brain` (Mac) first, falls back to
  `~/Desktop/Projects/second_brain` (Windows), `SECOND_BRAIN_VAULT` still
  overrides both.
- The pin-Claude-window feature is Win32 `SetWindowPos` — there's no
  AppleScript/System Events equivalent for "always on top" for an arbitrary
  app's window on macOS, so I didn't try to port it. It's gated behind
  `process.platform === 'win32'` in both main and the renderer — the button
  and tray item just don't show up on Mac instead of doing nothing when
  clicked.
- A normal Electron app already gets a Dock icon by default — I never called
  `app.dock.hide()` — so that part needed no work. I did add a right-click
  Dock menu (Show/hide notes, Dashboard) mirroring the tray, since that's
  the natural gesture on Mac.
- Added `npm run build:mac` (electron-builder, `dir`/`zip` target,
  `identity: null`) so I can build a real `.app` and drag it into
  `/Applications` instead of always launching from a terminal. Unsigned is
  fine — this is a personal tool, not something I'm distributing.

**The Sessions panel:**

`src/sessions.js` is a new, Electron-independent module. It shells out to
`ps -axo pid=,etime=,comm=` to find every process actually named `claude`,
then `lsof -a -p <pid> -d cwd -Fn` on each PID to get its working directory.
Multiple terminals in the same repo collapse into one session card (their
PIDs get listed together) rather than showing as duplicates.

To turn a raw cwd into a name I'd recognize, it matches against
`Resources/project-registry.md` — pulls every `/Users/...` or `~/...` style
path out of each row's Local-path cell (those cells mix Mac and Windows
paths plus prose, separated by `·`) and picks the longest prefix match
against the session's cwd. Falls back to the directory's own basename if
nothing in the registry matches.

Notes are the whole point of this panel, so I didn't want them buried in a
JSON blob — each session gets a real markdown file at
`AI/session-notes/<slug>.md`, readable and editable from a vault-side Claude
session too, not just from inside this app. `vault.js` grew
`readSessionNotes`/`saveSessionNotes`/`hasSessionNotes` for that. Clicking a
session in the Dashboard's new 4th panel opens a modal textarea that
autosaves 600ms after I stop typing — same debounce pattern the Article tab
already used for its draft.

**Efficiency** mattered here specifically because this machine is a laptop
and I don't want a background process burning battery. `ps`/`lsof` only run
on a 10-second timer, and only while the Dashboard window is actually open —
closing the Dashboard stops the timer entirely, so the always-open Notes
widget costs nothing extra for this feature existing.

**Two real bugs, caught before I trusted this:** first pass against my
actual `project-registry.md`, every session under `/Users/alpeldam` (i.e.
all of them) was matching to whichever registry row happened to contain a
bare `~` first in file order (Cursor Buddy's row) — a `~` with nothing after
it was matching as "home directory," a valid but useless prefix that beat
the real, longer, correct path purely on file order. Second: registry rows
that write their Mac path with a trailing slash (most of them) were failing
their own prefix check, because appending a path separator to an
already-slash-terminated string doubles it. Fixed both (require `~/` not
bare `~`; strip trailing slashes before comparing) and re-verified against
the real registry — my own vault session now correctly resolves to "Second
Brain," not "Cursor Buddy."

**Two real bugs found and fixed getting `build:mac` to actually work, same
day, once I ran it myself:**

1. **The hang wasn't codesigning at all.** A flaky first Electron-zip
   download had left a corrupted cache entry at
   `~/Library/Caches/electron/electron-v33.4.11-darwin-arm64.zip` — 361MB
   instead of the real ~99.7MB, `unzip -t` showed bad zip offsets starting
   around file #237. `app-builder unpack-electron` was silently spinning on
   it forever (0% CPU, no error, no progress). Deleted the corrupted cache
   entry and the build completed in ~35 seconds.
2. **Once it built, double-clicking the `.app` did nothing.** Root cause:
   the raw Electron binary ships with its own baked-in linker/ad-hoc
   signature from Electron's own release build. `identity: null` correctly
   skips *my* signing step, but doesn't touch that pre-existing signature —
   and electron-builder then customizes the bundle on top of it (renames the
   executable, rewrites `Info.plist` with my `appId`/`productName`), which
   invalidates that original signature without anyone re-signing over it.
   `codesign -dv` on the built app showed `Info.plist=not bound` and `spctl`
   said "code has no resources but signature indicates they must be
   present" — a broken seal, not a policy rejection. macOS silently refuses
   to launch a bundle with an invalid signature rather than showing a
   Gatekeeper dialog, which is why it looked like nothing happened at all.
   Fix: `codesign --deep --force --sign - "dist/mac-arm64/Second Brain.app"`
   after packaging — a real ad-hoc self-sign that reflects the actual final
   contents, not the stale one baked into the raw Electron binary. Now
   chained onto `build:mac` itself in `package.json` so this can't regress
   silently on a future rebuild.

## What's still open, in my own priority order

1. **Look at what got built on 2026-08-10** — the Sessions panel, the Tasks
   tab, notes modal, and Dock menu were never visually confirmed by me, only
   logic-tested. `npm start` (or the now-working packaged `.app`) and
   actually look.
2. **Global keyboard shortcut** to summon the Notes widget from anywhere —
   deferred since v0.1, still not built.
3. **Should the Dashboard auto-show on launch instead of Notes?** Right now
   both are tray-triggered but only Notes auto-shows when the app starts.
   Haven't decided — leaning toward leaving it as-is since Notes is the
   thing I reach for more often, but worth revisiting once the dashboard
   gets more use.
4. **Phone/remote access** — explicitly deferred to v0.1+, not scoped yet.
   Everything right now is local-only, one machine at a time.
5. **The pin-window feature has a duplicated implementation** between this
   app and a standalone vault script — see the separate writeup for the
   tradeoff, I haven't decided whether to de-duplicate it. Now also
   Windows-only outright (see the Mac port section above), which makes
   de-duplicating it lower priority, not higher.

## Rocky OS — Mission Control (v1, 2026-08-18)

### Why

The Dashboard answers "what should I be doing." It doesn't answer "and now do
it." Every time I looked at it and decided something needed doing, the next step
was still: find a terminal, `cd` to the vault, start Claude, type the thing.
The app knew the state and could see my running sessions, but it couldn't
actually *dispatch* anything — it was a read-only window onto a life that gets
lived somewhere else.

Mission Control closes that loop. Same vault data, but with a command bar at the
top that hands work to Rocky directly, and one panel that shows me everything
that's currently running — both the headless jobs I fired from here and the
`claude` terminals I have open elsewhere. It's the screen I want up when I sit
down: state on the left, agents on the right, a place to type in between.

This also settles the open question I'd left in this file ("should the Dashboard
auto-show on launch instead of Notes?"). Neither: **Mission Control is the
launch window now.** The Notes widget still gets created at startup so the tray
toggle is instant, it just doesn't show itself anymore. Everything else about
the widget is untouched — same tabs, same docking, same capture behavior — apart
from tightening the header spacing, which I had to do because a sixth control
(the ◎ Mission Control button) didn't fit at 340px wide and was pushing `–` and
`×` off the right edge.

### Windows and how you get there

`src/renderer/mission-control.{html,css,js}`, opened by `createMissionWindow()`
in `main.js`: 1280×800, resizable, normal chrome (min 900×560). Reachable from
the tray menu, the Dock right-click menu, and a ◎ button in the Notes widget
header — same three places the Dashboard already lived, and the old Dashboard
still works exactly as it did.

The CSS is deliberately the same palette family as `dashboard.css` (same accent,
same muted greys, same border alpha) on a slightly darker ground, so the panels
read as cards on a surface rather than as a second app. Dark-only, like every
other window here — there's no light theme in this app to be consistent with.

### The command bar and the job model

Typing into the bar and hitting Enter spawns `claude` headlessly with
**cwd = the vault root**. That last part is the whole point: the vault's own
`CLAUDE.md`, skills and hooks are in play, so this dispatches to *my* Rocky with
all of its context, not to a context-free agent that happens to be the same
binary. The exact invocation (verified against `claude --help` before writing
it, v2.1.234):

```
claude -p "<prompt>" --permission-mode acceptEdits \
       --output-format stream-json --include-partial-messages --verbose
```

`⌘↵` instead of `↵` does the same thing in the other direction: it opens
Terminal.app in the vault directory running an *interactive* `claude "<prompt>"`
via `osascript`, for the big jobs I'd rather watch and steer than read
afterwards.

**Finding the binary** is its own small problem and `src/rocky.js` handles it
properly, because it's the classic Electron trap: a GUI app launched from the
Dock inherits a bare `/usr/bin:/bin` PATH, not the one from my `.zshrc`, so
`spawn('claude')` works under `npm start` and mysteriously fails from the
packaged `.app`. Resolution order: `ROCKY_CLAUDE_BIN` if set → every entry in
`process.env.PATH` → the handful of real install locations
(`~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin`, `/usr/local/bin`) →
and only as a last resort a login shell (`$SHELL -l -c 'command -v claude'`).
Only a *successful* resolve is cached — caching the failure would have meant
that an app started before Claude Code was installed kept failing every
dispatch for the rest of its life. On my machine it lands on
`~/.local/bin/claude`. The spawned child also gets a repaired PATH so anything
*it* shells out to isn't crippled by the same problem.

A **job** is `{ id, prompt, label, cwd, mode, state, startedAt, endedAt,
exitCode, output }` where state is `running | done | failed | killed`. Live jobs
live in a `Map` in the main process; the moment a job finishes it's prepended
to `userData/rocky-jobs.json` (last 50, output truncated to 4KB) and *dropped
from the Map*, so a long session doesn't accumulate every job's 60KB tail in
memory — `listJobs()` serves the finished ones from history. That file is also
read defensively: anything in it that isn't a job-shaped object is filtered
out, because a single `null` in the array used to throw out of `listJobs()` on
every call and brick the jobs panel permanently. **Nothing about a job is ever
written to the vault** — these are app-local operational records, not notes.

**Streaming** is the reason for `--output-format stream-json`. Plain `-p` text
output only shows up at the end, which makes a "live" monitor a lie. The
stream-json feed is one JSON object per line, and most of it is noise (a single
`SessionStart` hook payload can be 10KB), so `renderStreamObject()` keeps only
four things: streamed assistant text (`content_block_delta` → `text_delta`),
tool calls rendered as `⏺ Bash(git status)` lines, a one-line peek at each tool
result, and errors. Chunks arrive on the child's `data` event — there is no
polling anywhere in this path — but they do **not** each become an IPC message.
A streamed answer arrives one token at a time, and a message (plus a DOM text
node, plus a forced reflow from reading `scrollHeight`) per token is the
difference between a live monitor and a hot laptop, so output is batched behind
a 100ms flush timer and flushed immediately when the job ends. Output is capped
at 60KB **in both processes** — the main-process tail and the renderer's `<pre>`
each trim themselves back to 60KB once they've grown past twice that, so the
trimming is amortised rather than a full rebuild per chunk. The line reader is
bounded the same way: newline-free output gets force-flushed as a line at the
cap instead of buffering a 30MB stdout dump into memory.

Killing is a **process-group** operation. Jobs are spawned `detached: true`, so
the child leads its own group and Stop sends `SIGTERM` to `-pid` — the whole
tree, not just the `claude` process at the top of it, because the thing that
actually outlives a naive kill is whatever the agent shelled out to. If the
group is still alive 2s later it gets `SIGKILL`. The job stays `running` (the
card says "stopping…") until the process *actually* exits; marking it "killed"
the moment the signal was sent was a lie whenever the child ignored `SIGTERM`.
`before-quit` does the same thing to every live job, `SIGTERM` then `SIGKILL`
after a short blocking grace period, so the app can't leave orphaned `claude`
processes — or their grandchildren — behind.

The **quick actions row** (Start Day, End of Day, Process Inbox, Save Session,
Weekly Review) is just the command bar with the prompt pre-written — each one
dispatches the corresponding slash command through the identical path. No
confirmation dialog: I clicked the button, that *is* the confirmation.

### The state panels and where their data comes from

All read-only, all loaded on window open, on window focus, and on ⟳ — never on a
timer. Every one of them degrades to a quiet empty state instead of throwing if
its source file is missing or has changed shape (`safely()` wraps each loader
and logs to the console).

| Panel | Source | Notes |
|---|---|---|
| Today | today's `Daily/YYYY-MM-DD.md` `## Tasks` | `listTodayTasks()` — today only, and it keeps the `### ` sub-headings as groups so "Bugünün işi" doesn't blur into the parked backlog. Clicking a row toggles it through the existing `toggleTaskLine()` write-back, the one place this window writes to the vault. |
| Today → Agenda | `python3 .claude/skills/gcal/gcal.py agenda` | Calls the vault's own gcal helper rather than building a second calendar integration — that script already owns the OAuth, config and its 2h cache. No `--force`, so reopening this window doesn't hammer the network. Three distinct states, which is the point: events → the list; the helper's own `_No calendar events…_` sentinel line → "Nothing scheduled in the next few days." (connected, just an empty week); a non-zero exit or a "not connected" message → "Calendar not connected." The sentinel's text happens to contain the words "calendar not connected", so it has to be matched *first* or a genuinely empty calendar reads as a broken integration. |
| Life Threads | `Areas/Life-Threads.md` | Parses `## <status>` sections → `### <thread>` → the `- **Why it matters/Latest movement/Next pull:**` bullets. A thread accumulates many "Latest movement" lines over time, so the last one in the file wins. Shows the active ones; the count of simmering/dormant sits in the header. |
| Projects | `Resources/project-registry.md` | `listProjectsBrief()` — the same parse as the Dashboard's `listProjects()`, but with the status cell cut to its first line / 200 chars. The registry keeps paragraphs in that cell (DARE-MOT's alone is ~11KB) and this panel clamps to one line anyway, so the full prose was being shipped over IPC to be thrown away. The Dashboard still calls `listProjects()` and gets everything. Compact: name, 1-line status, and a `graph` badge only for rows whose graph cell is actually `✅`. |
| Inbox | `Inbox/*.md` | Counts `.md` files (the `attachments/` folder isn't a capture), reads just the frontmatter head of each to flag `source: mobile`. Zero state is "Inbox clear." If there are phone captures, the panel grows a button that dispatches `/process-inbox`. |
| Health | `Areas/Health.md` `## Trend log` | Last 5 rows of the table, newest first, rendered with the column emoji as the label. Header says whether today's daily note has a `### Health log` section yet. |
| Reviews-due chip | `Resources/weekly/`, `Resources/monthly/` | Computes the ISO week of *seven days ago* (the most recent completed week) and last calendar month, and shows a chip only if the file is missing. Clicking it pre-fills the command bar with `/weekly-review` or `/monthly-review`. Right now both exist, so no chip — which is the correct answer, not a broken panel. |

### Agent monitor

One panel, two sources, two completely different update mechanisms:

- **Rocky jobs** — push-only, event-driven, no polling at all. Each card shows
  state, elapsed, the prompt's first line (or the quick-action label), a kill
  button while running, and an expandable log that appends as chunks arrive and
  keeps itself scrolled to the bottom.
- **Terminal sessions** — the existing `sessions.js` detection, on the same 10s
  `ps`/`lsof` poll the Dashboard already used. I refactored the poller so both
  windows subscribe to one shared timer instead of each running their own, and
  it stops the moment the last of those two windows closes.

### Efficiency rules I kept

Same rule as the Sessions panel: **zero background work while the windows are
closed.** The session poll only runs while Mission Control or the Dashboard is
open. The panels are pull-only. The only other timer is the 1-second elapsed
counter on job cards, and `syncTicker()` clears it the instant the last running
job finishes, so an idle Mission Control ticks nothing.

### What the adversarial review changed (same day, v1.1)

I had a reviewer agent try to break v1 before I committed it, and it did — 13
reproducible bugs. The ones worth remembering as *rules* rather than as diffs:

- **Substring heading matches are a trap.** `sectionBody()` found `## Tasks`
  with `indexOf`, so a `### Tasks` sub-heading (or a sentence merely mentioning
  `## Tasks`) hijacked or emptied the section. Headings are matched as whole
  lines now — anchored regex, `\r?$` tolerated.
- **CRLF.** Every new parser split on `'\n'` and therefore returned zero tasks
  and zero threads for a note last saved on the Windows box. They all split on
  `/\r?\n/` now, and `toggleTaskLine()` writes back with the line ending it
  found instead of silently converting the file to LF.
- **"Find the line again" must mean the *nearest* line.** The toggle's fallback
  was `lines.indexOf(raw)`, i.e. the *first* identical line in the file — with
  two identical tasks and a shifted note, clicking the second one ticked the
  first. It now searches outward from the recorded index.
- **A fat click target eats selections.** The whole task row is clickable, so
  dragging to select a task's text ended in a vault write on mouseup. The
  handler bails when there's a non-empty selection.
- **Guard the dispatch, not just the prompt.** Double-clicking "Start Day"
  launched two autonomous agents rewriting the same daily note. A quick action
  whose prompt/label is still running is refused (visibly, on the status line),
  and there's a hard cap of 5 concurrent jobs.
- **`activate` with an always-alive hidden window.** The stock Electron
  `getAllWindows().length === 0` guard can never fire here — the Notes widget is
  always alive — so clicking the Dock icon after closing Mission Control did
  nothing. It just calls `createMissionWindow()`, which already reuses/focuses.
- **Layout.** At 1280×800 the Agent Monitor was taking ~40% of the width to show
  two cards, while 30 tasks fought over a 230px scroll cap. The monitor is a
  bounded rail (`clamp(300px, 25%, 380px)`) now, and the state side is a
  two-column grid — Today beside Life Threads, the three compact panels
  underneath — so Today gets both more width and a much taller cap.

Plus the small hardening: `tasks:toggle` refuses any path outside the vault,
every window denies `window.open` and `will-navigate`, and a failed toggle
clears its own busy state.

### What I deferred

1. **Pin / session-notes from here.** Clicking a terminal session in the
   Dashboard pins it as the widget's active session and opens its notes editor.
   Mission Control's session cards are display-only — wiring the pin state and
   the notes overlay into a third renderer meant duplicating a chunk of
   `dashboard.js`, and the Dashboard is one click away. Left as-is on purpose.
2. **Job → vault linkage.** A finished `/start-day` job doesn't tell the Today
   panel to reload; I have to hit ⟳ (or refocus the window, which reloads the
   task/inbox panels). Auto-refreshing on job completion is the obvious next
   step.
3. **Re-attaching to a job across an app restart.** Jobs are children of the app
   process, so quitting kills them. History survives, the process doesn't.
4. **Terminal hand-off is macOS-only** (`osascript` + Terminal.app). It throws a
   clear message on other platforms rather than silently doing nothing, same
   approach as the Windows-only pin button.
5. **Quick actions still haven't been click-tested against the *real* vault** —
   clicking "Start Day" during a build session would rewrite my actual daily
   note. The whole path is verified though: end-to-end with a harmless prompt
   through the real `claude` in a scratch directory, and the button/refusal/
   Stop behaviour by driving the real renderer against a throwaway copy of the
   vault with a stub binary standing in for `claude`.

## Working agreement I set for this repo

This repo is job-visible, so Claude edits the code but I commit and push it
myself — no `Co-Authored-By: Claude` trailer on any commit here. That's
different from the vault repo itself, which Claude auto-commits normally.
