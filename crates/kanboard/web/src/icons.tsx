/** Tiny inline icons (16px, currentColor) — no icon dependency. */
import type { JSX } from "solid-js";

const base = (children: JSX.Element, props: { size?: number; class?: string } = {}): JSX.Element => (
  <svg
    width={props.size ?? 16}
    height={props.size ?? 16}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    class={props.class}
  >
    {children}
  </svg>
);

export const Icon = {
  board: (props: { size?: number; class?: string } = {}) =>
    base(
      <>
        <rect x="3" y="3" width="7" height="18" rx="1.5" />
        <rect x="14" y="3" width="7" height="11" rx="1.5" />
      </>,
      props,
    ),
  search: (props: { size?: number; class?: string } = {}) =>
    base(
      <>
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.2-3.2" />
      </>,
      props,
    ),
  plus: (props: { size?: number; class?: string } = {}) => base(<path d="M12 5v14M5 12h14" />, props),
  close: (props: { size?: number; class?: string } = {}) => base(<path d="M6 6l12 12M18 6L6 18" />, props),
  warn: (props: { size?: number; class?: string } = {}) =>
    base(
      <>
        <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
        <path d="M12 9v4M12 17h.01" />
      </>,
      props,
    ),
  arch: (props: { size?: number; class?: string } = {}) =>
    base(
      <>
        <rect x="3" y="4" width="18" height="4" rx="1" />
        <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 13h4" />
      </>,
      props,
    ),
  sun: (props: { size?: number; class?: string } = {}) =>
    base(
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </>,
      props,
    ),
  moon: (props: { size?: number; class?: string } = {}) =>
    base(<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z" />, props),
  link: (props: { size?: number; class?: string } = {}) =>
    base(
      <>
        <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" />
        <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />
      </>,
      props,
    ),
  chevron: (props: { size?: number; class?: string } = {}) => base(<path d="m6 9 6 6 6-6" />, props),
  dot: (props: { size?: number; class?: string } = {}) => base(<circle cx="12" cy="12" r="4" fill="currentColor" />, props),
};

/** Priority marker: a small arrow stack (urgent = double, high = up, low = down). */
export function PriorityIcon(props: { priority: string }): JSX.Element {
  if (props.priority === "none") return <></>;
  const up = (offset: number) => <path d={`M8 ${14 - offset}h8l-4-4z`} fill="currentColor" stroke="none" />;
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" class={`prio-icon ${props.priority}`}>
      {props.priority === "urgent" ? (
        <>
          {up(0)}
          {up(4)}
        </>
      ) : props.priority === "high" || props.priority === "medium" ? (
        up(2)
      ) : (
        <path d="M8 10h8l-4 4z" fill="currentColor" stroke="none" />
      )}
    </svg>
  );
}
