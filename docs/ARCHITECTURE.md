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
2. **The Dashboard** — a normal window, three columns: Tasks, Reading,
   Projects. This is the "what should I be doing" view. Opened from the
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
| `hide()` / `quit()` / `dock(edge)` | Window chrome controls |

Every one of these is a thin `ipcRenderer.invoke`/`.send` wrapped in
`contextBridge.exposeInMainWorld('brain', {...})` in `preload.js` — the
renderer literally cannot reach `fs`, `child_process`, or anything else
Node-side except through this explicit list.

## File layout

```
src/
  main.js              Electron main: both windows, tray, all IPC handlers
  preload.js            contextBridge → window.brain
  vault.js               all vault filesystem logic (notes, pomodoro log, tasks, projects)
  config.js               vault path resolution (env override)
  native/
    pin-window.ps1        Win32 always-on-top shim (bundled copy, see pin-window-integration.md)
  renderer/
    index.html / renderer.js / styles.css     the Notes/Timer/Article widget UI
    dashboard.html / dashboard.js / dashboard.css   the Tasks/Reading/Projects dashboard UI
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

## What's still open, in my own priority order

1. **Global keyboard shortcut** to summon the Notes widget from anywhere —
   deferred since v0.1, still not built.
2. **Should the Dashboard auto-show on launch instead of Notes?** Right now
   both are tray-triggered but only Notes auto-shows when the app starts.
   Haven't decided — leaning toward leaving it as-is since Notes is the
   thing I reach for more often, but worth revisiting once the dashboard
   gets more use.
3. **Phone/remote access** — explicitly deferred to v0.1+, not scoped yet.
   Everything right now is local-only, one machine at a time.
4. **The pin-window feature has a duplicated implementation** between this
   app and a standalone vault script — see the separate writeup for the
   tradeoff, I haven't decided whether to de-duplicate it.

## Working agreement I set for this repo

This repo is job-visible, so Claude edits the code but I commit and push it
myself — no `Co-Authored-By: Claude` trailer on any commit here. That's
different from the vault repo itself, which Claude auto-commits normally.
