/**
 * `@` task mentions in a textarea: typing `@` (at the start or after a space)
 * opens a list of the most recently created tasks; typing more filters it by
 * id or title. ↑/↓ move, Enter/Tab insert the task id, Esc closes. The list is
 * portalled and placed at the caret, so dialog/panel overflow never clips it.
 */

import { For, Show, createSignal, onCleanup, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import type { Task } from "./api.js";
import { StatusGlyph } from "./icons.js";
import { board } from "./state.js";

const MAX_SHOWN = 8;

/** Tasks matching `needle` (id or title), newest created first; archived and cancelled left out. */
export function recentTasks(needle: string, selfId?: string): Task[] {
  const text = needle.trim().toLowerCase();
  return board.tasks
    .filter((task) => task.id !== selfId && !["archived", "cancelled"].includes(task.status))
    .filter((task) => !text || task.id.toLowerCase().includes(text) || task.title.toLowerCase().includes(text))
    .sort(newestFirst)
    .slice(0, MAX_SHOWN);
}

/** Newest created first; ties (same second) by the id's number, highest first. */
export function newestFirst(a: Task, b: Task): number {
  const byDate = Date.parse(b.created ?? "") - Date.parse(a.created ?? "");
  if (byDate) return byDate;
  const num = (id: string): number => Number(/(\d+)$/.exec(id)?.[1] ?? 0);
  return num(b.id) - num(a.id) || b.id.localeCompare(a.id);
}

/** Viewport coordinates of the caret in a textarea (mirror-div technique). */
function caretPoint(area: HTMLTextAreaElement, index: number): { x: number; y: number; line: number } {
  const style = getComputedStyle(area);
  const mirror = document.createElement("div");
  for (const prop of [
    "boxSizing", "width", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
    "fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing", "lineHeight",
    "textTransform", "wordSpacing", "textIndent", "tabSize",
  ] as const) {
    mirror.style[prop] = style[prop];
  }
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "break-word";
  mirror.style.top = "0";
  mirror.style.left = "-9999px";
  mirror.textContent = area.value.slice(0, index);
  const marker = document.createElement("span");
  marker.textContent = "\u200b";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const rect = area.getBoundingClientRect();
  const x = rect.left + marker.offsetLeft - area.scrollLeft;
  const y = rect.top + marker.offsetTop - area.scrollTop;
  const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4;
  mirror.remove();
  return { x, y, line };
}

/**
 * Put `<Mention area={() => el} setValue={…} />` next to a textarea. It wires
 * its own listeners; the textarea's handlers stay untouched (keys are taken in
 * the window capture phase only while the list is open, so a dialog's Esc or a
 * composer's ⌘Enter never sees them).
 */
export function Mention(props: {
  area: () => HTMLTextAreaElement | undefined;
  setValue: (next: string) => void;
  selfId?: string;
}): JSX.Element {
  const [query, setQuery] = createSignal<{ start: number; text: string } | null>(null);
  const [active, setActive] = createSignal(0);
  const [at, setAt] = createSignal({ x: 0, y: 0 });
  const items = (): Task[] => {
    const current = query();
    return current ? recentTasks(current.text, props.selfId) : [];
  };
  const open = (): boolean => query() !== null && items().length > 0;

  const update = (): void => {
    const area = props.area();
    if (!area || area.selectionStart !== area.selectionEnd) return void setQuery(null);
    const caret = area.selectionStart ?? 0;
    const match = /(^|\s)@([\w.-]*)$/.exec(area.value.slice(0, caret));
    if (!match) return void setQuery(null);
    const start = caret - match[2]!.length - 1;
    const previous = query();
    if (!previous || previous.start !== start || previous.text !== match[2]) setActive(0);
    setQuery({ start, text: match[2]! });
    const point = caretPoint(area, start);
    const below = point.y + point.line + 4;
    const room = window.innerHeight - below;
    setAt({ x: Math.min(point.x, window.innerWidth - 340), y: room < 220 ? Math.max(8, point.y - 4 - Math.min(items().length, MAX_SHOWN) * 32 - 8) : below });
  };

  const pick = (task: Task): void => {
    const area = props.area();
    const current = query();
    if (!area || !current) return;
    const caret = area.selectionStart ?? area.value.length;
    const next = `${area.value.slice(0, current.start)}${task.id} ${area.value.slice(caret)}`;
    const position = current.start + task.id.length + 1;
    area.value = next;
    props.setValue(next);
    setQuery(null);
    queueMicrotask(() => {
      area.focus();
      area.setSelectionRange(position, position);
    });
  };

  const onKey = (event: KeyboardEvent): void => {
    if (!open() || event.target !== props.area()) return;
    const count = items().length;
    if (event.key === "ArrowDown") setActive((index) => (index + 1) % count);
    else if (event.key === "ArrowUp") setActive((index) => (index - 1 + count) % count);
    else if ((event.key === "Enter" && !event.metaKey && !event.ctrlKey) || event.key === "Tab") pick(items()[active()]!);
    else if (event.key === "Escape") setQuery(null);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  let wired: HTMLTextAreaElement | undefined;
  const onBlur = (): void => void setTimeout(() => setQuery(null), 150);
  const wire = (): void => {
    const area = props.area();
    if (!area || area === wired) return;
    wired?.removeEventListener("input", update);
    wired?.removeEventListener("click", update);
    wired?.removeEventListener("blur", onBlur);
    wired = area;
    area.addEventListener("input", update);
    area.addEventListener("click", update);
    area.addEventListener("blur", onBlur);
  };
  // The textarea may mount after us (inside a <Show>); re-check on focus.
  const onFocusIn = (): void => wire();
  queueMicrotask(wire);
  document.addEventListener("focusin", onFocusIn);
  window.addEventListener("keydown", onKey, true);
  onCleanup(() => {
    document.removeEventListener("focusin", onFocusIn);
    window.removeEventListener("keydown", onKey, true);
    wired?.removeEventListener("input", update);
    wired?.removeEventListener("click", update);
    wired?.removeEventListener("blur", onBlur);
  });

  return (
    <Show when={open()}>
      <Portal>
        <div class="mention-pop" role="listbox" aria-label="Mention a task" style={{ left: `${at().x}px`, top: `${at().y}px` }}>
          <For each={items()}>
            {(task, index) => (
              <button
                class={`dep-option${active() === index() ? " active" : ""}`}
                role="option"
                aria-selected={active() === index()}
                onMouseEnter={() => setActive(index())}
                // mousedown, not click: keep the textarea focused (no blur race)
                onMouseDown={(event) => {
                  event.preventDefault();
                  pick(task);
                }}
              >
                <StatusGlyph status={task.status} size={12} />
                <span class="mono muted dep-id">{task.id}</span>
                <span class="dep-title">{task.title}</span>
              </button>
            )}
          </For>
        </div>
      </Portal>
    </Show>
  );
}
