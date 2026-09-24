# Kanboard UI: design direction "Workbench"

Reference: Multica (github.com/multica-ai/multica, `packages/views/layout/app-sidebar.tsx`,
`issues/components/board-*.tsx`, `status-icon.tsx`, `ui/styles/tokens.css`). We borrow its structure
(sidebar + inset sheet + tinted status columns + hand-drawn status glyphs) and give it our own
character: a quiet, precise tool for watching agents work. The board should feel like an instrument
panel, not a generic component-library demo.

## Principles
1. **One surface hierarchy.** Canvas (sidebar colour) → inset *sheet* (main area, 1px hairline, 12px
   radius, 8px inset from the window edge) → columns (tinted per status) → cards (surface + soft shadow).
   No free-floating bordered boxes.
2. **Colour means state, nothing else.** Neutrals everywhere; colour only for status, priority and
   live agent activity. One brand accent (buttons, focus, selection).
3. **Custom glyphs, not generic icons.** Status is always shown with its own 14px SVG glyph (Multica style):
   backlog = dotted ring, todo = empty ring, in progress = half-filled pie, in review = ring + ¾ pie,
   blocked = ring with a bar, done = filled disc + check, cancelled = filled disc + ×. Priority = 3 signal
   bars (low 1, medium 2, high 3) and urgent = filled rounded square with "!".
4. **Density with air.** 13px base text, 12px meta, 11px micro; 4px grid; cards 10/12px padding.
5. **Agents are first-class.** A running task shows a live "agent chip" (pulsing dot + mode + elapsed
   time), its column header counts running agents, and the sidebar shows "Agents running".
6. **No default-looking controls.** Every button, input, select, menu and dialog uses our tokens;
   ghost-icon buttons are 24/28px squares with a hover fill; no bordered pill buttons except the
   primary action.

## Tokens
- Font: Inter (self-hosted via @fontsource-variable/inter, font-feature-settings "cv11","ss01","tnum" for
  numbers), JetBrains Mono (variable) for IDs, paths and code.
- Light: canvas `oklch(0.975 0.002 286)`, sheet `#fff`, surface `#fff`, hairline `oklch(0.92 0.004 286)`,
  text `oklch(0.2 0.006 286)`, muted `oklch(0.52 0.014 286)`.
- Dark: canvas `oklch(0.17 0.004 286)`, sheet `oklch(0.2 0.005 286)`, surface `oklch(0.235 0.006 286)`,
  hairline `oklch(1 0 0 / 7%)`, text `oklch(0.96 0 0)`, muted `oklch(0.68 0.013 286)`.
- Brand accent: indigo `oklch(0.58 0.2 268)` (dark: `oklch(0.68 0.16 268)`).
- Status hues (glyph + a 4–6% tinted column background + a solid header pill for active lanes):
  backlog neutral, todo neutral-strong, in_progress amber `oklch(0.75 0.15 75)`, in_review violet
  `oklch(0.62 0.17 295)`, blocked red `oklch(0.62 0.2 25)`, done green `oklch(0.64 0.14 155)`,
  cancelled neutral-muted.
- Priority: urgent red-orange solid, high orange, medium amber, low muted, none = "—".
- Radius 6 (controls) / 8 (cards) / 12 (sheet, dialogs). Shadow: `0 1px 2px rgb(0 0 0 / .05)`,
  raised `0 8px 24px -6px rgb(0 0 0 / .18)`.
- Motion: 120ms ease-out for hover and press, 180ms spring-ish for panels; honour prefers-reduced-motion.

## Layout
- **Sidebar (240px, collapsible to 56px with `[`):** a project switcher header (initial tile + name +
  chevron), search button (⌘K), then sections:
  - *Board*: Board, List, My review queue (in_review), Blocked.
  - *Projects*: every registered project with its glyph tile and an open-task count; active highlighted.
  - *Agents*: live runs (task id + mode + elapsed), or "No agents running".
  - Footer: daemon status (host:port, live/reconnecting dot), theme toggle, keyboard shortcuts.
- **Sheet header:** breadcrumb (project › Board), then a toolbar row: view switch (Board | List),
  Filter (status, priority, label, has-deps, running), Display (group by status, show cancelled/done,
  card density), a task count on the right, and a primary **New task** button (⌘/C).
- **Board:** 288px columns, 12px gap, horizontal scroll with a thin themed scrollbar; the column header
  has the status glyph + name (pill when active) + count + "…" menu + "+"; drop targets highlight with an
  accent ring, disallowed columns fade to 40% during drag, and a 2px accent line marks the insert point.
- **Card:** row 1 = mono ID (muted) + right-aligned agent chip when running; title 13.5px/500, 2-line clamp;
  one-line body excerpt (muted, 12px); meta row = priority badge, "after KD-3" dependency chip (with a
  lock glyph while waiting), labels, stale warning. Hover lifts the border; selected = accent ring.
- **List view:** grouped by status, sticky group headers, dense 36px rows (glyph, id, title, deps,
  priority, updated).
- **Task detail:** a wide right panel (min(760px, 60vw)) with its own header (glyph + id + actions menu:
  duplicate, copy id/path, cancel, archive; a close button). Two columns: main (big inline-editable title,
  rich markdown body with edit/preview, activity timeline with actor avatars — user / agent (sparkle) /
  system — and a comment composer that grows) and a properties rail (Status as a glyph dropdown limited to
  allowed moves, Priority, Dependencies as chips + a searchable add, Labels, Created/Updated, Run block
  when running, file path in mono with a copy button).
- **Command palette (⌘K):** jump to task/project, create task, switch view, toggle theme.
- **Dialogs:** New task (title large, body, status/priority/after as inline property chips like Linear);
  comment-required move (explains *why*: "Moving out of In Review needs a rework note").
- **Empty states** with a small line illustration per column type; loading skeletons that match card shape;
  toasts bottom-right, stacked, with an undo when applicable (move/order).

## Non-goals
No avatars/assignees beyond actor (user/agent/system); no dates/due dates; no real-time multi-user cursors.
