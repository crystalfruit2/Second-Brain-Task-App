---
name: Rocky OS — Mission Control
description: Glass Cockpit — a primary-flight-display grammar for a day, in black glass and B612
colors:
  glass: "#0a0d10"
  bezel: "#0f141a"
  bezel-line: "#1d2733"
  bezel-line-soft: "#151d26"
  ink-current: "#e9e7df"
  dim: "#97a3ad"
  faint-engraved: "#75838f"
  green-engaged: "#35e07c"
  cyan-information: "#58d3f2"
  magenta-commanded: "#f26ee8"
  amber-caution: "#ffb43a"
  red-alarm: "#ff5a4e"
typography:
  display:
    fontFamily: "B612, -apple-system, 'Segoe UI', system-ui, sans-serif"
    fontSize: "21px"
    fontWeight: 700
    lineHeight: 1.35
  body:
    fontFamily: "B612, -apple-system, 'Segoe UI', system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  data:
    fontFamily: "'B612 Mono', ui-monospace, 'SF Mono', Menlo, monospace"
    fontSize: "13px"
    fontWeight: 700
    letterSpacing: "0.04em"
  label:
    fontFamily: "B612, -apple-system, 'Segoe UI', system-ui, sans-serif"
    fontSize: "10px"
    fontWeight: 700
    letterSpacing: "0.14em"
rounded:
  hairline: "2px"
  control: "3px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
components:
  dispatch-button:
    backgroundColor: "{colors.glass}"
    textColor: "{colors.dim}"
    rounded: "{rounded.control}"
    padding: "8px 15px"
  dispatch-button-armed:
    backgroundColor: "{colors.green-engaged}"
    textColor: "#071008"
  cdu-input:
    backgroundColor: "{colors.glass}"
    textColor: "{colors.ink-current}"
    rounded: "{rounded.control}"
    padding: "9px 12px"
  modekey:
    backgroundColor: "{colors.glass}"
    textColor: "{colors.dim}"
    rounded: "{rounded.control}"
    padding: "5px 10px"
  annunciator:
    backgroundColor: "rgba(255, 180, 58, 0.07)"
    textColor: "{colors.amber-caution}"
    rounded: "{rounded.hairline}"
    padding: "4px 9px"
  bezel-button:
    backgroundColor: "{colors.glass}"
    textColor: "{colors.dim}"
    rounded: "{rounded.control}"
    size: "28px"
---

# Design System: Rocky OS — Mission Control

## Overview

**Creative North Star: "The Glass Cockpit"**

Mission Control is a primary flight display for a life, not a dashboard of text
columns. The board is a single sheet of black glass (#0a0d10) divided by flat 1px
bezels into instruments: an annunciator strip on top, a DAY tape left, a SYSTEMS
rail right, a center display that page-swaps in place, four mini instruments, and
a CDU scratchpad at the bottom. Nothing nominal speaks. Color is a strict law of
meaning, not decoration — the single magenta element on screen is always the
commanded next action. Density is high but quiet: the 5-second glance answers
"what now / is Rocky flying / how is my life," and all longer prose is one
in-place page swap away, never deleted.

The world is engraved, not lit: labels are small-caps 10px engravings in a faint
gray that reads as printed on the bezel; current values sit above them in warm
white ink or bold mono. There are no drop shadows, no gradients, no idle motion —
the board sits beside night work on battery, so glare and animation are the enemy.

**Scope boundary (recorded honestly):** this system currently governs the
**Mission Control window only**. The app's other windows (the Notes widget and
Dashboard) still run the older dark-panel style. Extending the cockpit world to
them is a deliberate future act, not an assumption.

**Key Characteristics:**
- One black-glass surface, instruments separated by flat 1px bezel lines
- PFD color law: every hue has exactly one meaning
- B612 for prose, B612 Mono for values — an actual cockpit typeface, bundled locally
- Engraved small-caps labels as the single label voice
- Zero idle motion; one finite, event-driven flash
- The board never reflows; the center display swaps pages in place

## Colors

An almost-black ground with six signal colors whose meanings are law; nothing on
the board is colored for taste.

### Primary
- **Commanded Magenta** (#f26ee8): the flight-director color. Marks the one
  commanded next action — the NOW task headline and its tick on the DAY tape.
  Nothing else may be magenta.

### Secondary
- **Engaged Green** (#35e07c): engaged / running / done. Running-job lights and
  names, completed ticks, the armed Dispatch button, engaged mode keys.
- **Information Cyan** (#58d3f2): passive information and affordance — waypoint
  times, hover/focus accents, focused input borders, links into the vault, text
  selection, focus rings.
- **Caution Amber** (#ffb43a): things needing attention — annunciator pills
  (reviews due, unrouted inbox), stopping jobs, caution instrument values.
- **Alarm Red** (#ff5a4e): failures only — failed job lights, error text, the
  stop control.

### Neutral
- **Warm Ink** (#e9e7df): current values and primary text; the "white" of the PFD.
- **Dim** (#97a3ad): secondary text — statuses, notes, metadata.
- **Engraved Faint** (#75838f): bezel-label engravings, empty states, group
  headers; still ≥4.5:1 on glass.
- **Glass** (#0a0d10): the tube — page background and control wells.
- **Bezel** (#0f141a): raised bezel ground — header, instruments row, CDU footer,
  hover fill on rows.
- **Bezel Line** (#1d2733) / **Bezel Line Soft** (#151d26): major and minor 1px
  instrument edges.

### Named Rules
**The Color Law Rule.** White is the current value, green is engaged, cyan is
information, magenta is the commanded target, amber is caution, red is alarm.
A color never appears outside its meaning.

**The One Magenta Rule.** Magenta marks exactly one thing on the board at a
time — the next action. Its rarity is the entire signal.

**The Tinted Well Rule.** Signal colors get low-alpha fills of themselves for
their grounds (e.g. amber pills at `rgba(255,180,58,0.07)`, hover 0.16; red stop
hover at 0.1–0.12; borders at 0.4–0.5 alpha of the signal color). No new hues
are invented for backgrounds.

## Typography

**Display/Body Font:** B612 (with -apple-system, Segoe UI fallback) — 400 and 700, bundled woff2
**Data/Mono Font:** B612 Mono (with ui-monospace, SF Mono, Menlo fallback) — 400 and 700, bundled woff2

**Character:** B612 was designed for Airbus cockpit displays; it is the world's
material, not a reference to it. Prose is B612; every number, time, mode value,
and machine string is B612 Mono. CSP forbids remote fonts — everything ships
local from `src/renderer/fonts/`.

### Hierarchy
- **Display / NOW headline** (700, 21px, 1.35): the commanded task on the Now
  page (magenta) or the all-clear line (green). Max width 34em.
- **Body** (400, 13px, 1.5): task prose, page text; base size set on `html`.
- **Data** (700 mono, 13px, 0.04em tracking): FMA mode values, clock, counts.
  Smaller mono variants (9–11.5px) carry metadata, timestamps, badges, and logs.
- **Label** (700, 10px, uppercase, 0.14em, Engraved Faint): the bezel-label
  voice — tape titles, instrument labels, FMA labels, display titles.
- **Group label** (700, 9.5–10px, uppercase, 0.12em, Engraved Faint): section
  headers inside tapes and pages.
- **Instrument value** (700 mono, 19px, line-height 1): the big number in each
  mini instrument.

### Named Rules
**The One Label Voice Rule.** Every bezel label on the board is the same
engraving: 10px, 700, uppercase, 0.14em tracking, Engraved Faint. No second
label style exists.

**The Mono Means Machine Rule.** B612 Mono appears wherever the machine speaks —
times, counts, modes, logs, source tags, keyboard-facing input. Human prose stays
in B612.

## Layout

A fixed cockpit grid on a 100vh, overflow-hidden body: `auto minmax(0,1fr) auto`
rows (annunciator strip / board / CDU). The board is a 3-column grid —
`clamp(230px, 23vw, 300px)` tapes flanking a fluid center display; below 1080px
the tapes clamp to `clamp(210px, 24vw, 250px)` and the brand subtitle drops.
Window minimum is 900×560.

Spacing is a tight 2px-family rhythm: 4/6/8 inside rows and gaps, 10–16px for
panel padding (e.g. tape heads 12px 14px 8px, display body 14px 18px, CDU
10px 16px 9px). Rows are one-line ticks (26px line-height) on tapes; full prose
lives on center-display pages. Scroll happens only inside `.tape-scroll` and
`.display-body`; scrollbars are 8px, thumb #232e39.

**The Board Never Reflows Rule.** The center display swaps pages in place
(Now / Day / Threads / Projects / Inbox / Health / Job); tapes, instruments row,
and CDU never move or resize in response. Drilling in costs zero layout shift.

## Elevation & Depth

There are no shadows. Depth is conveyed by exactly two tools: the two-tone
ground (raised chrome sits on Bezel #0f141a, wells and the tube sit on Glass
#0a0d10 — a control "recessed" into a bezel is simply glass-on-bezel) and flat
1px lines (#1d2733 major, #151d26 minor). The only `box-shadow` in the system is
`inset 0 2px 0 var(--cyn)` on the active mini instrument — a flat 2px edge bar,
an indicator line, not a shadow. The job log recesses one step deeper than glass
(#070a0d).

**The Flat Bezel Rule.** No drop shadows, no glows, no gradients, no blur.
If something must look raised or recessed, change its ground tone and give it a
1px line.

## Shapes

Rectilinear instrument geometry with the smallest radii that keep corners from
glinting: 2px on hairline chrome (pills, badges, ticks, row hovers, checkboxes),
3px on controls and wells (buttons, inputs, mode keys, the job log). Status
lights are the one circle in the system: 5–8px dots (mode-key lights, rail-job
lights, session dots). Borders are always 1px solid (1.5px only on the drawn
checkbox stroke); colored borders use the signal color at 0.4–0.5 alpha.

**The Drawn Icon Rule.** Icons are inline stroke SVGs at 1.5–2 stroke-width,
round caps/joins, `currentColor`, 8–14px — drawn, not typed. No icon fonts, no
emoji glyphs, no icon packages.

## Components

### CDU Scratchpad (signature)
The command line at the bottom of the board — a cockpit CDU, not a chat box.
- **Input:** glass well, warm-ink text, cyan caret, 1px Bezel Line border (3px
  radius), 700 12.5px B612 Mono, uppercase mono placeholder in Engraved Faint at
  weight 400. Focus: border turns cyan (no glow).
- **Dispatch button:** mono 11px/700, uppercase, 0.1em; glass ground, dim text,
  1px line. Hover: ink text + cyan border. **Armed:** solid Engaged Green with
  near-black green text (#071008); the one filled button in the system.
  Active: `translateY(1px)`. Disabled: 50% opacity.
- **Mode keys** (quick actions): same mono uppercase voice at 10px, each with a
  5px round key-light (line-colored at rest, green when engaged; engaged key
  text goes green with a 0.5-alpha green border).

### Annunciators
Amber caution pills in the top strip: mono 10.5px/700, 0.08em, amber text,
1px amber border, 2px radius, amber-tinted well (0.07 alpha, 0.16 on hover).
Only cautions get pills; nominal states show nothing.

### Bezel buttons
28px square (24px in the display head), 1px line, 3px radius, glass ground,
dim icon. Hover: ink icon + cyan border. Used for refresh and back — chrome
controls, never content.

### Tapes (DAY / SYSTEMS)
Column instruments with a clickable head (title + mono note; hover turns the
title cyan). Rows are single-line ticks: 26px tick-box + ellipsized 12px label.
Done: green check, faint struck-through label. Commanded: magenta 700 label.
Waypoints pair a cyan mono time (min-width 42px) with a dim ellipsized title.
Rail jobs lead with an 8px status light (faint idle, green running, red failed,
amber killed, dark-green #2a6a47 done) and end with a 20px red stop square.

### Mini instruments
Four fixed cells on bezel ground under the display: 19px mono value (amber when
caution), engraved label, dim 10.5px ellipsized note. Hover lightens the ground
(#131a21) and turns the label cyan; active sits on glass with the inset 2px cyan
edge bar. The Health cell replaces the value with a 19px sparkline (dim 1.5px
polyline, terminal dot green when logged / amber when not).

### List items (center pages)
Checkbox rows: 15px drawn checkbox (1.5px dim stroke, 2px radius; green stroke +
check when done), 13px/1.5 prose, bezel-ground hover, faint strike-through when
checked. Inline `code` gets a mono bezel chip. Busy state is 0.35 opacity — no
spinners.

### Badges
Tiny mono tags (9–9.5px, 700, 0.08em) with a 0.4-alpha signal-color border and
2px radius: cyan NOTES badge on sessions, green GRAPH badge on projects, cyan
uppercase source tags on inbox items.

### Motion
**The Zero Idle Motion Rule.** Nothing animates at rest — no transitions on
hover chrome, no pulsing lights, no marquee. The single authored motion is the
mode-change flash: `fma-flash` — a 1.6s `steps(1,end)` outline blink in
`currentColor` on an FMA value or rail-job name, event-driven and finite, and
disabled under `prefers-reduced-motion`.

## Do's and Don'ts

### Do:
- **Do** obey the Color Law — check every colored element against its meaning
  (white current / green engaged / cyan info / magenta commanded / amber caution
  / red alarm) before it ships.
- **Do** keep exactly one magenta element on the board: the commanded next action.
- **Do** set every bezel label in the one engraved voice (10px, 700, uppercase,
  0.14em, #75838f) and every machine value in B612 Mono.
- **Do** build depth with ground tone (glass vs bezel) and 1px lines only; make
  colored grounds by tinting the signal color at low alpha.
- **Do** swap center-display pages in place; keep tapes, instruments, and CDU
  pinned so the board never reflows.
- **Do** draw icons as inline stroke SVGs (1.5–2 stroke, round caps,
  `currentColor`).

### Don't:
- **Don't** use drop shadows, glows, gradients, or blur anywhere; the only
  permitted box-shadow is the flat inset 2px active-instrument edge bar.
- **Don't** animate at idle. Motion must be event-driven, finite, and
  reduced-motion guarded; spinners are replaced by 0.35-opacity busy states.
- **Don't** color anything for decoration, put magenta on a second element, or
  invent a seventh signal color.
- **Don't** load remote fonts or scripts (CSP `default-src 'self'`); B612 ships
  locally or not at all.
- **Don't** assume this world outside Mission Control — the Notes widget and
  Dashboard windows still run the older dark-panel style; extending the cockpit
  to them is a deliberate decision, not a default.
- **Don't** exceed radius 3px or use pill/rounded-corner card shapes; circles
  exist only as status lights.

---

*Open items carried from the finish review (defects to fix, not system rules):
(1) the DAY tape lacks true tape grammar — graduations and a current-position
lozenge; (2) FMA mode changes flash but do not draw a boxed mode annunciation.*
