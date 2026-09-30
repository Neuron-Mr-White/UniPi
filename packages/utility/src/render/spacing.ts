/**
 * @pi-unipi/utility — transcript spacing normalization.
 *
 * pi puts a leading Spacer before every chat block, and several block kinds
 * additionally pad themselves (a tinted box's top/bottom pad, a tool result
 * that starts with a blank line, hidden-thinking assistant steps that render
 * only spacing). Two adjacent blocks can then produce 2–4 consecutive blank
 * rows in the transcript.
 *
 * The normalization runs where all of those components meet: the chat
 * transcript container. Each child renders as usual, its leading/trailing
 * blank rows are trimmed (OSC-8-aware, via trimEdgeBlankLines), and non-empty
 * blocks are joined with exactly one blank row — the same single gap pi
 * intends between blocks, minus the accidental stacking.
 */

import { isAssistant, trimEdgeBlankLines } from "./reply-bg.js";

/** A block's position inside a run of same-group siblings. */
export interface SpacingGroupPosition {
  index: number;
  count: number;
  /** spacingKind of the previous / next member of the same group run. */
  prevKind?: string;
  nextKind?: string;
}

/**
 * Optional marks a transcript child can carry:
 *  - `spacingGroup` — adjacent visible children sharing the same non-empty
 *    group are joined with NO separator row (a sidekick run reads as one
 *    rail block, like the lead's tool tree);
 *  - `spacingKind` — reported to neighbours as prevKind/nextKind;
 *  - `setGroupPosition` — called with the member's index/count in the run
 *    before it renders (so tree connectors can pick ├ vs └).
 */
interface Renderable {
  render(width: number): string[];
  spacingGroup?: string;
  spacingKind?: string;
  setGroupPosition?: (pos: SpacingGroupPosition) => void;
}

interface MouseLayout {
  width: number;
  children: Array<{ component: unknown; height: number }>;
}

export interface TranscriptContainer {
  children: Renderable[];
  mouseLayout?: MouseLayout;
  render(width: number): string[];
}

/** pi's tool-execution component (updateArgs/updateResult pair). */
function isToolExecution(c: unknown): boolean {
  const o = c as { updateArgs?: unknown; updateResult?: unknown } | null;
  return !!o && typeof o.updateArgs === "function" && typeof o.updateResult === "function";
}

/**
 * Depth-first search for pi's chat transcript container: the Container whose
 * children are transcript blocks (assistant messages, tool executions…).
 * The container is only found once a reply or tool row exists on screen.
 */
export function findTranscriptContainer(root: unknown, depth = 0): TranscriptContainer | undefined {
  if (!root || typeof root !== "object" || depth > 12) return undefined;
  const children = (root as { children?: unknown[] }).children;
  if (!Array.isArray(children) || children.length === 0) return undefined;
  if (children.some((c) => isAssistant(c) || isToolExecution(c))) return root as TranscriptContainer;
  for (const child of children) {
    const hit = findTranscriptContainer(child, depth + 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

const SPACING_PATCHED = Symbol("unipi.transcriptSpacing");

/**
 * Patch the transcript container: child renders are trimmed at the edges and
 * non-empty blocks are joined with exactly one blank row. Interior blanks
 * (inside a reply panel, a box, a diff) are untouched. Idempotent — call it
 * whenever the tree may have been rebuilt; a fresh container gets re-patched.
 */
export function patchTranscriptSpacing(container: TranscriptContainer): void {
  const flagged = container as TranscriptContainer & Record<symbol, unknown>;
  if (flagged[SPACING_PATCHED] === true) return;
  const self = container;
  self.render = function render(width: number): string[] {
    const rendered = self.children.map((child) => ({ child, lines: trimEdgeBlankLines(child.render(width)) }));
    const visible = rendered.filter((r) => r.lines.length > 0);
    // Runs of adjacent visible children sharing a spacingGroup: tell every
    // member its position (index/count + neighbour kinds), then re-render
    // it — the position may change its lines (├ vs └ tree connectors).
    let gi = 0;
    while (gi < visible.length) {
      const grp = visible[gi]!.child.spacingGroup;
      if (grp === undefined || grp === "") {
        gi++;
        continue;
      }
      let end = gi + 1;
      while (end < visible.length && visible[end]!.child.spacingGroup === grp) end++;
      const members = visible.slice(gi, end);
      members.forEach((m, idx) => {
        if (m.child.setGroupPosition === undefined) return;
        m.child.setGroupPosition({
          index: idx,
          count: members.length,
          prevKind: idx > 0 ? members[idx - 1]!.child.spacingKind : undefined,
          nextKind: idx < members.length - 1 ? members[idx + 1]!.child.spacingKind : undefined,
        });
        m.lines = trimEdgeBlankLines(m.child.render(width));
      });
      gi = end;
    }
    const lines: string[] = [];
    const mouseChildren: Array<{ component: unknown; height: number }> = [];
    let prevGroup: string | undefined;
    for (const { child, lines: childLines } of rendered) {
      if (childLines.length === 0) {
        mouseChildren.push({ component: child, height: 0 });
        continue;
      }
      const grp = child.spacingGroup !== "" ? child.spacingGroup : undefined;
      const joined = grp !== undefined && grp === prevGroup;
      // pi attributes the separator to the child below it (it unshifts ""
      // into the child's lines); grouped members get no separator.
      if (lines.length > 0 && !joined) childLines.unshift("");
      lines.push(...childLines);
      mouseChildren.push({ component: child, height: childLines.length });
      prevGroup = grp;
    }
    self.mouseLayout = { width, children: mouseChildren };
    return lines;
  };
  flagged[SPACING_PATCHED] = true;
}

const PROBE_WIDGET = "unipi-spacing-probe";

/**
 * Find the transcript container and patch it once it exists. Mirrors the
 * reply-bg probe: a zero-height widget gives us the TUI root; a few timed
 * retries cover resumed sessions whose history renders right after load.
 */
export function installTranscriptSpacing(pi: {
  on: (event: any, handler: (event: any, ctx?: any) => void) => void;
}): void {
  let tui: unknown;
  const tryPatch = () => {
    if (tui === undefined) return;
    try {
      const container = findTranscriptContainer(tui);
      if (container !== undefined) patchTranscriptSpacing(container);
    } catch {
      /* spacing is cosmetic; never block a render tick */
    }
  };
  try {
    pi.on("session_start", (_e: any, ctx: any) => {
      if (!ctx?.hasUI) return;
      try {
        ctx.ui.setWidget(
          PROBE_WIDGET,
          (t: unknown) => {
            tui = t;
            return { invalidate() {}, render: () => [] };
          },
          { placement: "belowEditor" },
        );
        for (const ms of [0, 400, 2000]) setTimeout(tryPatch, ms);
      } catch {}
    });
    pi.on("message_end", () => setTimeout(tryPatch, 0));
    pi.on("agent_end", () => setTimeout(tryPatch, 0));
  } catch {
    // cosmetic; never block load
  }
}
