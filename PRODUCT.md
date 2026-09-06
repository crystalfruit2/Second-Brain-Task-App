# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Alp — a 3rd-year Control & Automation Engineering student who runs his whole life through an Obsidian vault ("second brain") and a fleet of Claude Code terminals. Sole user today. The design must assume it *might* ship to others someday (open-source Companion idea): personal content stays data, never baked into the design; another person's vault should be able to plug in.

## Product Purpose

An Electron desktop app that is the **operating layer for Rocky**, Alp's vault-based AI companion. Two windows: a small always-on-top Notes/Timer/Article widget, and **Mission Control** — the front door to the agentic OS: dispatch headless `claude` jobs into the vault, fire quick actions (/start-day, /end-of-day, …), see vault state (today's tasks + agenda, life threads, projects, inbox, health), and monitor running agents/terminals.

Success for Mission Control (confirmed 2026-09-01): it is used **glance-first but fully operable** — it sits open while Alp works; a 5-second glance must answer all three of: (1) what should I do right now, (2) is Rocky working and on what, (3) what's the state of my life — with all longer prose reachable but hidden until summoned.

## Operating Context

- Data source is the vault at `~/Documents/Projects/second_brain` (Markdown + frontmatter), read/written directly by the Electron main process; renderer talks over IPC (`window.brain`). No database, no network calls from the renderer (strict CSP, `default-src 'self'`).
- Vault content is largely Turkish/English mixed, long-form prose (task lines routinely 2–4 rendered lines; project statuses are running logs).
- Jobs are real `claude -p` processes with cwd = the vault; kill is process-group SIGTERM→SIGKILL. Terminal sessions are auto-detected via `ps`/`lsof`.
- Runs on a MacBook (Apple Silicon), often on battery; also has a Windows twin machine.

## Capabilities and Constraints

- **Battery/CPU efficiency is a standing hard rule** — polling only while a window is open (10s), output coalescing, no animation that burns idle CPU.
- CSP forbids remote fonts/scripts; everything ships local.
- Panels currently don't auto-refresh when a job finishes (manual ⟳ / refocus) — a known gap, fair game to fix.
- Existing IPC surface (tasks:list/toggle, projects:list, threads, inbox, health, gcal agenda, rocky job events, sessions) is the data contract; redesign should reuse it, extending only where the design truly needs it.
- Repo is job-visible: Claude edits, Alp commits & pushes; no Co-Authored-By trailers.

## Brand Commitments

Name: **Rocky OS** (the companion is "Rocky" — underdog/grit identity). "Mission Control" is the window's name. Dark, focused, OS-like feel is incumbent but not pinned; no other binding visual constraints stated.

## Evidence on Hand

- Live screenshot of incumbent Mission Control (2026-09-01) — text-dense 3-column grid, confirmed by Alp as too much text.
- Full architecture writeup at `docs/ARCHITECTURE.md`; product history in the vault at `Projects/Second-Brain-Task-App.md`.
- Real vault data for testing (35+ tasks, 15 projects, live agenda, running claude sessions).

## Product Principles

1. **Glance-first, depth on demand** — every panel earns its pixels at 5-second glance distance; prose is one interaction away, never deleted.
2. **Operable the moment he engages** — collapsing text must never cost a click-path: toggle a task, kill a job, dispatch a command stay immediate.
3. **The vault is the truth** — the app renders and writes vault markdown; it never grows its own store beyond ephemeral job history.
4. **Efficiency over spectacle** — nothing polls, animates, or renders in a way that costs battery while idle.
5. **Personal data, portable design** — Alp's life fills the panels, but the system (layout, components, tokens) stays generic enough to ship.
