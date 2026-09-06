---
name: Rocky OS
description: A first-party Apple app after dark — iOS dark grouped grammar with one lantern-orange command tint
colors:
  true-black: "#000000"
  elevated-card: "#1c1c1e"
  raised-fill: "#2c2c2e"
  control-fill: "rgba(120, 120, 128, 0.22)"
  hairline: "rgba(84, 84, 88, 0.55)"
  label: "#ffffff"
  label-secondary: "rgba(235, 235, 245, 0.62)"
  label-tertiary: "rgba(235, 235, 245, 0.32)"
  lantern-orange: "#ff9f0a"
  running-green: "#30d158"
  info-blue: "#409cff"
  caution-yellow: "#ffd60a"
  destroy-red: "#ff453a"
typography:
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 700
    letterSpacing: "-0.02em"
  now-display:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: "-0.015em"
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 700
    letterSpacing: "-0.01em"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.4
  caption:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif"
    fontSize: "12.5px"
    fontWeight: 400
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    letterSpacing: "0.06em"
  mono:
    fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace"
    fontSize: "11.5px"
    lineHeight: 1.65
rounded:
  code: "4px"
  focus: "6px"
  row: "8px"
  input: "10px"
  card: "14px"
  sheet: "16px"
  pill: "999px"
  circle: "50%"
spacing:
  hair: "4px"
  inner: "8px"
  row: "10px"
  gutter: "12px"
  card-x: "16px"
  display-x: "18px"
components:
  card:
    backgroundColor: "{colors.elevated-card}"
    rounded: "{rounded.card}"
  status-pill:
    backgroundColor: "{colors.elevated-card}"
    textColor: "{colors.label-secondary}"
    rounded: "{rounded.pill}"
    padding: "5px 12px"
  mode-pill:
    backgroundColor: "{colors.elevated-card}"
    textColor: "{colors.label-secondary}"
    rounded: "{rounded.pill}"
    padding: "5px 13px"
  mode-pill-engaged:
    backgroundColor: "rgba(48, 209, 88, 0.14)"
    textColor: "{colors.running-green}"
    rounded: "{rounded.pill}"
  pill-commanded:
    backgroundColor: "rgba(255, 159, 10, 0.14)"
    textColor: "{colors.lantern-orange}"
    rounded: "{rounded.pill}"
  composer-input:
    backgroundColor: "{colors.elevated-card}"
    textColor: "{colors.label}"
    rounded: "{rounded.pill}"
    padding: "8px 16px"
  send-idle:
    backgroundColor: "{colors.control-fill}"
    textColor: "{colors.label-tertiary}"
    rounded: "{rounded.circle}"
    size: "30px"
  send-armed:
    backgroundColor: "{colors.lantern-orange}"
    textColor: "#000000"
    rounded: "{rounded.circle}"
    size: "30px"
  section-label:
    textColor: "{colors.label-secondary}"
    typography: "{typography.label}"
  code-chip:
    backgroundColor: "{colors.raised-fill}"
    typography: "{typography.mono}"
    rounded: "{rounded.code}"
    padding: "1px 5px"
---

# Design System: Rocky OS

## Overview

**Creative North Star: "The First-Party Night Board"**

Rocky OS looks and behaves like an app Apple shipped in dark mode — the day runs in the grammar of Reminders, Fitness and iMessage. A true-black ground carries elevated `#1C1C1E` cards; inside them, iOS grouped-list rows are cut by inset hairline separators; the composer at the foot of Mission Control is an iMessage field with a filled circular ↑ send. The system explicitly refuses two defaults at once: the text-dense terminal dashboard and the cockpit costume. Nothing is styled like an instrument; everything is styled like a list, a pill, or a tile.

Color is a strict grammar, not a mood. One brand tint — lantern orange, from Rocky's own icon — is reserved for the commanded next action and the armed send. Everything else speaks in Apple's semantic voices: green runs (and fills done checks), blue informs, yellow cautions, red destroys. The board sits beside Alp's work at night, so the ground stays black, motion stays finite and event-driven, and nothing glows idly.

**Key Characteristics:**
- True-black ground, `#1C1C1E` cards, tonal layering — no structural shadows
- One command tint (lantern orange `#ff9f0a`); four semantic colors with fixed jobs
- SF Pro via the system stack (CSP forbids remote fonts — the stack is the deliberate vehicle)
- Circular Reminders checks, pill chips, iMessage composer
- Zero idle animation; every animation is finite, event-driven, and reduced-motion-guarded

## Colors

An iOS dark-mode grouped palette: three neutral layers, three label opacities, one brand tint, four semantic voices.

### Primary
- **Lantern Orange** (`#ff9f0a`): Rocky's one command color. It marks the commanded next task (Now label + commanded row), the armed send button, focus rings, caret color, hover-to-act states (check circles, card titles), and quick-action pills at `rgba(255, 159, 10, 0.14)` fill. Its rarity is its authority.

### Secondary
- **Running Green** (`#30d158`): live and finished work — running job lights and names, engaged mode pills (`rgba(48, 209, 88, 0.14)` fill), session dots, the all-clear headline, and done-check fills at `rgba(48, 209, 88, 0.8)`.
- **Info Blue** (`#409cff`): pure information — agenda times, inbox sources, Notes badges, text selection (`rgba(64, 156, 255, 0.4)`).
- **Caution Yellow** (`#ffd60a`): things due attention — annunciator pills (`rgba(255, 214, 10, 0.12)` fill), caution stat values, killed-job lights.
- **Destroy Red** (`#ff453a`): destruction and failure only — stop buttons (`rgba(255, 69, 58, 0.15)` fill), failed lights, error text.

### Neutral
- **True Black** (`#000000`): the window ground. Never a card color.
- **Elevated Card** (`#1c1c1e`): every card, pill, and input surface — the one elevation step above ground.
- **Raised Fill** (`#2c2c2e`): the step above cards — hovers and inline code chips.
- **Control Fill** (`rgba(120, 120, 128, 0.22)`): iOS control fill for idle send, back buttons, segmented-control tracks, active stat tiles.
- **Hairline** (`rgba(84, 84, 88, 0.55)`): separators between rows and around stat tiles. 1px, always.
- **Label / Secondary / Tertiary** (`#ffffff` / `rgba(235,235,245,0.62)` / `rgba(235,235,245,0.32)`): the three-step iOS label ladder — primary content, supporting text, placeholders and done text.

### Named Rules
**The One Command Rule.** Lantern orange appears only where Rocky commands or is about to act: the next action, the armed send, focus, and act-on-hover. Status never borrows it; done states are green, not orange.
**The Semantic Voice Rule.** Green runs, blue informs, yellow cautions, red destroys. Semantic colors ride on tinted pill fills of themselves (12–15% alpha) rather than on new surface colors.

## Typography

**Display/Body Font:** SF Pro via the system stack (`-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui`)
**Mono Font:** SF Mono via `ui-monospace` (with Menlo, Consolas)

**Character:** Apple's own voice — tight negative tracking on weights above 600, generous line-height on prose, `font-variant-numeric: tabular-nums` on every time, count, and metric. The CSP forbids remote fonts; the system stack is not a fallback but the chosen vehicle.

### Hierarchy
- **Headline** (700, 20px, -0.02em): window brand titles ("Mission Control", Dashboard h1).
- **Now Display** (600, 22px, 1.35, -0.015em): the single commanded task line — the largest text in the app; green when all clear. Max-width 30em.
- **Title** (700, 17px, -0.01em): card titles (15px/700 on Dashboard panels).
- **Stat Value** (700, 20px, tabular-nums): instrument-tile numbers; yellow when cautioning.
- **Body** (400, 13px, 1.4–1.5): task prose, rows, inputs. Word-break tolerant — vault lines run long.
- **Caption** (400, 12.5px): supporting metadata in `label-secondary`.
- **Label** (600, 11px, 0.06em, UPPERCASE): the one grouped-list section voice — every group header, date label, and clock label across all three windows.
- **Mono** (11.5px, 1.65): job logs (on `#101012`) and inline `code` chips only. Never UI chrome.

### Named Rules
**The One Label Voice Rule.** Every section header in every window is the same 11px/600 uppercase 0.06em treatment. No second header style exists.
**The Tabular Time Rule.** Anything numeric that updates — clocks, counts, durations, dates — sets `font-variant-numeric: tabular-nums`.

## Layout

Mission Control is a three-row window grid (nav bar / board / composer, `100vh`, no window scroll) whose board is three columns: `clamp(240px, 24vw, 320px)` side cards flanking a fluid center display, 12px gutters, 14px page padding. Below 1080px the clamps tighten (215–250px, 10px gaps); window minimum is 900×560. The Dashboard is a four-column card grid (`1fr 0.8fr 1fr 1.1fr`); the Notes widget is a single floating column.

Density is iOS-list density: rows are 30px-line or ~7–9px vertical padding, cards pad 13–16px at the head and 8px at the scroll gutter, the center display pads 18px. Scrolling happens only inside cards, and every scroll region dissolves at its card edge via a bottom `mask-image` fade (12–14px) instead of clipping hard.

Chrome is native: macOS uses `hiddenInset` traffic lights with `body.mac` padding the nav bar to 84px left; the whole nav bar is a drag region with `no-drag` islands on controls.

## Elevation & Depth

Depth is tonal, not shadowed: black ground → `#1c1c1e` card → `#2c2c2e` hover/chip → `rgba(120,120,128,0.22)` control fill. Cards cast no shadows; borders exist only as 1px hairlines between rows and around the composer input. The single true shadow in the system is the Dashboard notes overlay sheet (`0 24px 70px rgba(0,0,0,0.6)`) over a `rgba(0,0,0,0.55)` scrim — a modal exception, not a vocabulary. The Notes widget adds the one material exception: its whole body is translucent dark glass (`rgba(28,28,30,0.93)` + `backdrop-filter: blur(24px) saturate(160%)`, 14px radius, `rgba(255,255,255,0.12)` border) because it floats over other apps; its inner surfaces switch to white-alpha fills (`rgba(255,255,255,0.07/0.12)`) to read on glass.

### Named Rules
**The Tonal Ladder Rule.** Depth = one step up the neutral ladder, never a shadow. Shadows are reserved for true modal sheets.
**The Glass Only Floats Rule.** Translucency belongs exclusively to the always-on-top widget; docked windows are opaque black-and-card.

## Shapes

Soft, continuous, circular where interactive: 14px cards (16px for the modal sheet), 8px rows and hover pads, 10px inner inputs, 4px code chips, and full pills (`999px`) for every chip, status cell, and capsule button. Anything that checks, sends, stops, or indicates state is a perfect circle: 20px/1.5px-stroke Reminders check rings, 30px send disc, 22–28px bezel buttons, 7–8px status dot lights. Hairlines are inset (starting at the text edge, ~30–38px from the row's left) like an iOS grouped list, never full-bleed. All icons are inline stroke SVGs, 1.5–1.8px round-capped strokes at 8–18px — seven glyphs total (refresh, back, stop square, circle, filled circle-check, check, double chevrons); no icon font, no emoji glyphs in chrome.

## Components

### Cards
- **Corner Style:** 14px radius
- **Background:** `elevated-card` flat; no border, no shadow
- **Structure:** flex column — head (title 17px/700 + right-aligned tabular note), mask-faded scroll body, optional hairline-divided footer (stat tiles)
- **Hover:** card titles that navigate tint to lantern orange

### List Rows (tasks, agenda, jobs, projects)
- **Style:** 8px-radius rows; hover paints `rgba(255,255,255,0.05)`; inset 1px hairline between siblings
- **Check:** 20px circle, 1.5px `label-tertiary` ring; hover ring turns orange; done fills green `rgba(48,209,88,0.8)` with a black checkmark and the text drops to `label-tertiary`
- **Commanded row:** label turns lantern orange at weight 600
- **Status lights:** 7–8px dots — green running, red failed, yellow killed, 40%-green done

### Pills / Chips
- **Style:** full-radius capsules on `elevated-card` (or a semantic 12–15% tint), 12–13px/500–600 text, 4–5px × 11–13px padding
- **States:** engaged = green text on green tint with a 6px key light dot; commanded quick-action = orange on orange tint; caution annunciator = yellow on yellow tint; hover steps to `raised-fill`

### Composer (signature)
- **Input:** pill field on `elevated-card`, 1px `raised-fill` border, orange caret; focus border shifts to `rgba(255,159,10,0.55)` — no glow
- **Send:** 30px circle; idle = control fill + tertiary ↑; armed = solid lantern orange with black ↑ (hover `#ffb340`); 0.15s ease-out background/color transition
- **Foot:** mode-key pill row plus right-aligned 12px status line (red on error)

### Inputs / Fields (widget)
- **Style:** 10px radius on card fill, transparent 1px border, orange caret
- **Focus:** border becomes `rgba(255,159,10,0.55)`
- **Segmented control:** iOS dark — `control-fill` track, 2px inset, active segment `#636366`

### Stat Tiles (instruments)
- **Style:** 4-up grid in the card footer, divided by hairlines; 20px/700 tabular value over 11px uppercase label
- **States:** hover `rgba(255,255,255,0.05)`; active = control fill with orange label; caution values/notes in yellow

### Job Log
- **Style:** near-black well (`#101012`), 10px radius, 11.5px/1.65 SF Mono in `#d0d5da`; empty state whispers "waiting for output…" in `label-tertiary`

### Navigation Bar
- **Style:** 52px draggable strip on bare black (no card): 20px brand, `elevated-card` status pills (label + 600-weight value; green engaged / secondary standby), yellow annunciator pills, tabular clock, 28px circular bezel button

## Do's and Don'ts

### Do:
- **Do** keep lantern orange scarce — next action, armed send, focus, act-on-hover; if orange marks a status, it's wrong.
- **Do** fill done checks green at 0.8 alpha with a black checkmark; done text drops to `label-tertiary`.
- **Do** end every in-card scroll region with a 12–14px bottom mask fade; never hard-clip content at a card edge.
- **Do** make every animation finite and event-driven — page-in 0.22s `cubic-bezier(0.2, 0.7, 0.3, 1)` on center-display swaps, 1.2s ease-out state-pulse on job/mode flips — and guard each with `prefers-reduced-motion`.
- **Do** inset row hairlines to the text edge and set tabular-nums on all live numbers.
- **Do** draw icons as inline round-capped stroke SVGs from the existing seven-glyph set.

### Don't:
- **Don't** loop, idle-animate, or pulse anything at rest — battery is a product hard rule; zero idle CPU from the UI.
- **Don't** load remote fonts or scripts; the CSP (`default-src 'self'`) makes the system stack the design.
- **Don't** put shadows or borders on cards; depth is the tonal ladder. The modal sheet's shadow is the only exception.
- **Don't** use translucency or backdrop blur outside the floating Notes widget.
- **Don't** reintroduce cockpit costume — no bezels, engraved labels, mono UI chrome, or instrument-panel framing; mono is for logs and code chips only.
- **Don't** invent an eighth icon style, an icon font, or emoji chrome; don't add a second section-header voice.
