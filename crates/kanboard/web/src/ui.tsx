/**
 * Small, owned UI primitives: anchored popovers, menus, dialogs, keycaps,
 * avatars. Styled entirely by styles.css — no component-library defaults.
 */
import { For, Show, createEffect, createSignal, onCleanup, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { Icon } from "./icons.js";

// ─── popover ────────────────────────────────────────────────────────────────

export interface PopoverProps {
  /** Renders the trigger; call `toggle` from its click handler. */
  trigger: (api: { open: boolean; toggle: () => void; ref: (el: HTMLElement) => void }) => JSX.Element;
  children: (close: () => void) => JSX.Element;
  align?: "start" | "end";
  width?: number;
  label?: string;
  class?: string;
}

/** Anchored below its trigger, portalled, closes on outside click / Esc / scroll. */
export function Popover(props: PopoverProps): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const [pos, setPos] = createSignal({ top: 0, left: 0 });
  let anchor: HTMLElement | undefined;
  let panel: HTMLDivElement | undefined;

  const place = (): void => {
    if (!anchor) return;
    const box = anchor.getBoundingClientRect();
    const width = props.width ?? 240;
    const left = props.align === "end" ? box.right - width : box.left;
    setPos({ top: box.bottom + 6, left: Math.max(8, Math.min(left, window.innerWidth - width - 8)) });
  };

  const close = (): void => void setOpen(false);
  const toggle = (): void => {
    if (!open()) place();
    setOpen(!open());
  };

  createEffect(() => {
    if (!open()) return;
    const onDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (panel?.contains(target) || anchor?.contains(target)) return;
      close();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
        anchor?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", close);
    queueMicrotask(() => panel?.querySelector<HTMLElement>("input, [role=menuitem], [role=option], button")?.focus());
    onCleanup(() => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", close);
    });
  });

  return (
    <>
      {props.trigger({ open: open(), toggle, ref: (el) => (anchor = el) })}
      <Show when={open()}>
        <Portal>
          <div
            ref={panel}
            class={`popover${props.class ? ` ${props.class}` : ""}`}
            role="dialog"
            aria-label={props.label}
            style={{ top: `${pos().top}px`, left: `${pos().left}px`, width: `${props.width ?? 240}px` }}
            onKeyDown={(event) => menuKeys(event)}
          >
            {props.children(close)}
          </div>
        </Portal>
      </Show>
    </>
  );
}

/** Arrow-key roving focus across menu items inside a popover. */
function menuKeys(event: KeyboardEvent): void {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const root = event.currentTarget as HTMLElement;
  const items = [...root.querySelectorAll<HTMLElement>("[role=menuitem], [role=menuitemcheckbox], [role=option]")].filter(
    (item) => !item.hasAttribute("disabled"),
  );
  if (items.length === 0) return;
  event.preventDefault();
  const index = items.indexOf(document.activeElement as HTMLElement);
  const next = event.key === "ArrowDown" ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
  items[next]?.focus();
}

export function MenuItem(props: {
  icon?: JSX.Element;
  label: JSX.Element;
  hint?: JSX.Element;
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  role?: "menuitem" | "menuitemcheckbox" | "option";
  onSelect: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      class={`menu-item${props.danger ? " danger" : ""}${props.checked ? " checked" : ""}`}
      role={props.role ?? "menuitem"}
      aria-checked={props.role === "menuitemcheckbox" || props.role === "option" ? !!props.checked : undefined}
      disabled={props.disabled}
      onClick={() => props.onSelect()}
    >
      <Show when={props.icon}>
        <span class="menu-icon">{props.icon}</span>
      </Show>
      <span class="menu-label">{props.label}</span>
      <Show when={props.hint}>
        <span class="menu-hint">{props.hint}</span>
      </Show>
      <Show when={props.checked !== undefined}>
        <span class="menu-check">{props.checked ? <Icon.check size={14} /> : null}</span>
      </Show>
    </button>
  );
}

export function MenuLabel(props: { children: JSX.Element }): JSX.Element {
  return <div class="menu-section">{props.children}</div>;
}

export const MenuSeparator = (): JSX.Element => <div class="menu-sep" role="separator" />;

// ─── dialog ─────────────────────────────────────────────────────────────────

export function Dialog(props: {
  open: boolean;
  label: string;
  onClose: () => void;
  width?: number;
  class?: string;
  children: JSX.Element;
}): JSX.Element {
  createEffect(() => {
    if (!props.open) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.stopPropagation();
        props.onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    onCleanup(() => {
      document.removeEventListener("keydown", onKey, true);
      previous?.focus?.();
    });
  });
  return (
    <Show when={props.open}>
      <Portal>
        <div class="overlay" onPointerDown={(event) => event.target === event.currentTarget && props.onClose()}>
          <div
            class={`dialog${props.class ? ` ${props.class}` : ""}`}
            role="dialog"
            aria-modal="true"
            aria-label={props.label}
            style={{ width: `min(${props.width ?? 560}px, calc(100vw - 32px))` }}
          >
            {props.children}
          </div>
        </div>
      </Portal>
    </Show>
  );
}

// ─── small pieces ───────────────────────────────────────────────────────────

export function Kbd(props: { keys: string[] }): JSX.Element {
  return (
    <span class="kbd-group">
      <For each={props.keys}>{(key) => <kbd>{key}</kbd>}</For>
    </span>
  );
}

export const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

export function Avatar(props: { actor: string; size?: number }): JSX.Element {
  const size = () => props.size ?? 22;
  return (
    <span class={`avatar actor-${props.actor}`} style={{ width: `${size()}px`, height: `${size()}px` }} aria-hidden="true">
      {props.actor === "agent" ? <Icon.sparkle size={12} /> : props.actor === "system" ? <Icon.gear size={12} /> : <Icon.user size={12} />}
    </span>
  );
}

export function Tooltip(props: { text: string; children: JSX.Element }): JSX.Element {
  return (
    <span class="tip" data-tip={props.text}>
      {props.children}
    </span>
  );
}

/** Auto-growing textarea (min rows, grows to max height then scrolls). */
export function AutoTextarea(props: JSX.TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string; maxHeight?: number }): JSX.Element {
  let el: HTMLTextAreaElement | undefined;
  const fit = (): void => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, props.maxHeight ?? 320)}px`;
  };
  createEffect(() => {
    void props.value;
    queueMicrotask(fit);
  });
  return <textarea {...props} ref={el} onInput={(event) => { fit(); (props.onInput as ((e: InputEvent & { currentTarget: HTMLTextAreaElement }) => void) | undefined)?.(event as never); }} />;
}
