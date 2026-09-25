/** Deterministic colours for projects and labels, and the card's shared tag row. */
import { For, Show, type JSX } from "solid-js";
import type { Task } from "./api.js";
import { Icon, PRIORITY_LABEL, PriorityGlyph } from "./icons.js";
import { elapsed, highlightTask } from "./state.js";

const HUES = [268, 295, 330, 20, 48, 75, 145, 175, 205, 235];

function hash(text: string): number {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) value = Math.imul(value ^ text.charCodeAt(index), 16777619);
  return Math.abs(value);
}

/** A stable, pleasant hue for a label or project name. */
export function hue(text: string): string {
  return `oklch(0.64 0.15 ${HUES[hash(text) % HUES.length]})`;
}

export function ProjectTile(props: { name: string; size?: number }): JSX.Element {
  const size = () => props.size ?? 18;
  return (
    <span
      class="project-tile"
      style={{
        width: `${size()}px`,
        height: `${size()}px`,
        background: hue(props.name),
        "font-size": `${Math.round(size() * 0.52)}px`,
        "border-radius": `${Math.round(size() * 0.28)}px`,
      }}
      aria-hidden="true"
    >
      {props.name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

export function PriorityTag(props: { priority: string }): JSX.Element {
  return (
    <Show when={props.priority && props.priority !== "none"}>
      <span class={`tag prio prio-${props.priority}`} title={`Priority: ${PRIORITY_LABEL[props.priority]}`}>
        <PriorityGlyph priority={props.priority} size={12} />
        <span>{PRIORITY_LABEL[props.priority]}</span>
      </span>
    </Show>
  );
}

/**
 * Dependency tag. Three states:
 *  - locked:  a dep is still in Backlog — nothing moves until a human schedules it;
 *  - waiting: deps are in flight (todo / in progress) — the runner will get there;
 *  - ready:   every dep reached the gate.
 * Deps drawn directly above in the same chain are omitted (the connector shows them).
 */
export function DepTag(props: { task: Task; drawnParents?: string[] }): JSX.Element {
  const drawn = () => new Set(props.drawnParents ?? []);
  const deps = () => (props.task.deps ?? []).filter((dep) => !drawn().has(dep) || (props.task.deps ?? []).length > 1);
  const locked = () => (props.task.lockedBy ?? []).filter((dep) => deps().includes(dep));
  const waiting = () => (props.task.waitingFor ?? []).filter((dep) => deps().includes(dep));
  const title = (): string =>
    locked().length > 0
      ? `Locked: ${locked().join(", ")} ${locked().length === 1 ? "is" : "are"} still in Backlog. Move ${locked().length === 1 ? "it" : "them"} to Todo to unlock.`
      : waiting().length > 0
        ? `Waiting on ${waiting().join(", ")}`
        : `After ${deps().join(", ")} (ready)`;
  return (
    <Show when={deps().length > 0}>
      <span class={`tag dep${locked().length > 0 ? " locked" : waiting().length > 0 ? " waiting" : ""}`} title={title()}>
        <Show when={locked().length > 0 || waiting().length > 0} fallback={<Icon.link size={11} />}>
          <Icon.lock size={11} />
        </Show>
        <span>
          after{" "}
          <For each={deps()}>
            {(dep, index) => (
              <>
                <Show when={index() > 0}>, </Show>
                <button
                  class="dep-id"
                  title={`Show ${dep}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    highlightTask(dep);
                  }}
                >
                  {dep}
                </button>
              </>
            )}
          </For>
          <Show when={locked().length > 0}> · not scheduled</Show>
        </span>
      </span>
    </Show>
  );
}

export function LabelTags(props: { labels: string[]; max?: number }): JSX.Element {
  const shown = () => props.labels.slice(0, props.max ?? 3);
  return (
    <>
      <For each={shown()}>
        {(label) => (
          <span class="tag label" style={{ "--label-hue": hue(label) }}>
            <span>{label}</span>
          </span>
        )}
      </For>
      <Show when={props.labels.length > shown().length}>
        <span class="tag">+{props.labels.length - shown().length}</span>
      </Show>
    </>
  );
}

export function AgentChip(props: { task: Task }): JSX.Element {
  return (
    <Show when={props.task.run}>
      <span class="agent-chip" title={`Agent session ${props.task.run?.session ?? "?"} · ${props.task.run?.mode ?? "direct"} mode`}>
        <span class="pulse" aria-hidden="true" />
        {props.task.run?.mode ?? "direct"}
        <span class="time">{elapsed(props.task.run?.started)}</span>
      </span>
    </Show>
  );
}
