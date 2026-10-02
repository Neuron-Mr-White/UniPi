/** UNI-60: the label picker — one searchable create/select multiselect shared
 *  by the Add form and the task panel's label rail. Props are intentionally
 *  small: `selected` chips are rendered by the caller; this is just the menu. */
import { For, Show, createMemo, createSignal, type JSX } from "solid-js";
import { allLabels } from "./state.js";
import { Icon } from "./icons.js";
import { hue } from "./paint.js";
import { MenuItem } from "./ui.js";

export function LabelPicker(props: {
  selected: string[];
  onToggle: (label: string) => void;
  onCreate: (label: string) => void;
  close: () => void;
  /** While a save is pending the caller disables the whole picker — a rapid
   *  second selection would otherwise read a stale `selected` snapshot and
   *  overwrite the first write. */
  disabled?: boolean;
}): JSX.Element {
  const [needle, setNeedle] = createSignal("");
  const options = createMemo(() => {
    const n = needle().trim().toLowerCase();
    return allLabels().filter((label) => !n || label.toLowerCase().includes(n));
  });
  const typed = (): string => needle().trim().replace(/,/g, "");
  const exists = (): boolean =>
    options().some((label) => label.toLowerCase() === typed().toLowerCase()) ||
    props.selected.some((label) => label.toLowerCase() === typed().toLowerCase());

  const accept = (): void => {
    if (props.disabled) return;
    const label = typed();
    if (!label) return;
    if (exists()) {
      props.onToggle(allLabels().find((item) => item.toLowerCase() === label.toLowerCase()) ?? label);
    } else {
      props.onCreate(label);
    }
    setNeedle("");
  };

  return (
    <div class="label-picker">
      <div class="pop-search">
        <Icon.search size={14} />
        <input
          autofocus
          disabled={props.disabled}
          placeholder="Filter labels… (Enter to create)"
          aria-label="Filter labels"
          value={needle()}
          onInput={(event) => setNeedle(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              accept();
            } else if (event.key === "Escape") {
              event.stopPropagation();
              props.close();
            }
          }}
        />
      </div>
      <div role="listbox" aria-label="Labels" class="label-picker-list">
        <For each={props.selected.filter((label) => !options().includes(label))}>
          {(label) => (
            <MenuItem
              role="menuitemcheckbox"
              disabled={props.disabled}
              icon={<span class="label-dot" style={{ width: "8px", height: "8px", "border-radius": "50%", background: hue(label) }} />}
              label={label}
              checked
              onSelect={() => !props.disabled && props.onToggle(label)}
            />
          )}
        </For>
        <For each={options()} fallback={<div class="menu-section">No existing labels.</div>}>
          {(label) => (
            <MenuItem
              role="menuitemcheckbox"
              disabled={props.disabled}
              icon={<span class="label-dot" style={{ width: "8px", height: "8px", "border-radius": "50%", background: hue(label) }} />}
              label={label}
              checked={props.selected.includes(label)}
              onSelect={() => !props.disabled && props.onToggle(label)}
            />
          )}
        </For>
      </div>
      <Show when={typed() && !exists()}>
        <button
          class="menu-item"
          role="menuitem"
          disabled={props.disabled}
          aria-disabled={props.disabled || undefined}
          onClick={() => {
            if (props.disabled) return;
            props.onCreate(typed());
            setNeedle("");
          }}
        >
          <span class="menu-icon">
            <Icon.plus size={13} />
          </span>
          <span class="menu-label">
            Create <b>{typed()}</b>
          </span>
        </button>
      </Show>
    </div>
  );
}
