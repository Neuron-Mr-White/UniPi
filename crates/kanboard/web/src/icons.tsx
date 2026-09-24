/**
 * Icons. Two families:
 *  - `StatusGlyph` / `PriorityGlyph`: the board's own 14px vocabulary (colour = state);
 *  - `Icon.*`: 1.4px-stroke line icons on a 16px grid for chrome (no icon dependency).
 */
import type { JSX } from "solid-js";

type IconProps = { size?: number; class?: string };

const line = (children: JSX.Element, props: IconProps = {}): JSX.Element => (
  <svg
    width={props.size ?? 16}
    height={props.size ?? 16}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.4"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    class={props.class}
  >
    {children}
  </svg>
);

export const Icon = {
  logo: (props: IconProps = {}) => (
    <svg width={props.size ?? 18} height={props.size ?? 18} viewBox="0 0 18 18" aria-hidden="true" class={props.class}>
      <rect x="1" y="1" width="16" height="16" rx="4.5" fill="var(--brand)" />
      <rect x="4.5" y="4.5" width="3.2" height="9" rx="1.2" fill="var(--brand-fg)" />
      <rect x="10.3" y="4.5" width="3.2" height="5.4" rx="1.2" fill="var(--brand-fg)" opacity=".75" />
    </svg>
  ),
  board: (props: IconProps = {}) =>
    line(
      <>
        <rect x="2" y="2.5" width="12" height="11" rx="2" />
        <path d="M6 2.5v11M10 2.5v7" />
      </>,
      props,
    ),
  list: (props: IconProps = {}) => line(<path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01" />, props),
  review: (props: IconProps = {}) =>
    line(
      <>
        <path d="M1.8 8s2.2-4.3 6.2-4.3S14.2 8 14.2 8s-2.2 4.3-6.2 4.3S1.8 8 1.8 8Z" />
        <circle cx="8" cy="8" r="1.8" />
      </>,
      props,
    ),
  blocked: (props: IconProps = {}) =>
    line(
      <>
        <circle cx="8" cy="8" r="5.8" />
        <path d="m3.9 3.9 8.2 8.2" />
      </>,
      props,
    ),
  search: (props: IconProps = {}) =>
    line(
      <>
        <circle cx="7" cy="7" r="4.3" />
        <path d="m13.5 13.5-3.4-3.4" />
      </>,
      props,
    ),
  filter: (props: IconProps = {}) => line(<path d="M2.5 4h11M4.5 8h7M6.5 12h3" />, props),
  sliders: (props: IconProps = {}) =>
    line(
      <>
        <path d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6" />
        <circle cx="10" cy="4.5" r="1.5" />
        <circle cx="6" cy="11.5" r="1.5" />
      </>,
      props,
    ),
  plus: (props: IconProps = {}) => line(<path d="M8 3v10M3 8h10" />, props),
  close: (props: IconProps = {}) => line(<path d="m4 4 8 8M12 4l-8 8" />, props),
  check: (props: IconProps = {}) => line(<path d="m3.5 8.5 3 3 6-7" />, props),
  more: (props: IconProps = {}) => (
    <svg width={props.size ?? 16} height={props.size ?? 16} viewBox="0 0 16 16" aria-hidden="true" class={props.class} fill="currentColor">
      <circle cx="3.5" cy="8" r="1.2" />
      <circle cx="8" cy="8" r="1.2" />
      <circle cx="12.5" cy="8" r="1.2" />
    </svg>
  ),
  chevronDown: (props: IconProps = {}) => line(<path d="m4.5 6.5 3.5 3.5 3.5-3.5" />, props),
  chevronRight: (props: IconProps = {}) => line(<path d="m6.5 4.5 3.5 3.5-3.5 3.5" />, props),
  sidebar: (props: IconProps = {}) =>
    line(
      <>
        <rect x="2" y="2.5" width="12" height="11" rx="2" />
        <path d="M6 2.5v11" />
      </>,
      props,
    ),
  warn: (props: IconProps = {}) =>
    line(
      <>
        <path d="M7.1 2.6 1.9 11.7a1 1 0 0 0 .9 1.5h10.4a1 1 0 0 0 .9-1.5L8.9 2.6a1 1 0 0 0-1.8 0Z" />
        <path d="M8 6.3v2.6M8 11h.01" />
      </>,
      props,
    ),
  sun: (props: IconProps = {}) =>
    line(
      <>
        <circle cx="8" cy="8" r="2.8" />
        <path d="M8 1.5v1.3M8 13.2v1.3M1.5 8h1.3M13.2 8h1.3M3.4 3.4l.9.9M11.7 11.7l.9.9M3.4 12.6l.9-.9M11.7 4.3l.9-.9" />
      </>,
      props,
    ),
  moon: (props: IconProps = {}) => line(<path d="M13.5 9.6A5.6 5.6 0 1 1 6.4 2.5a4.5 4.5 0 0 0 7.1 7.1Z" />, props),
  keyboard: (props: IconProps = {}) =>
    line(
      <>
        <rect x="1.5" y="3.5" width="13" height="9" rx="1.8" />
        <path d="M4 6.5h.01M6.5 6.5h.01M9 6.5h.01M11.5 6.5h.01M5 9.5h6" />
      </>,
      props,
    ),
  link: (props: IconProps = {}) =>
    line(
      <>
        <path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2-2a2.6 2.6 0 0 0-3.7-3.7l-.6.6" />
        <path d="M9.2 6.8a2.6 2.6 0 0 0-3.7 0l-2 2a2.6 2.6 0 0 0 3.7 3.7l.6-.6" />
      </>,
      props,
    ),
  lock: (props: IconProps = {}) =>
    line(
      <>
        <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
        <path d="M5.5 7V5.3a2.5 2.5 0 0 1 5 0V7" />
      </>,
      props,
    ),
  copy: (props: IconProps = {}) =>
    line(
      <>
        <rect x="5.5" y="5.5" width="8" height="8" rx="1.6" />
        <path d="M10.5 5.5V3.8a1.3 1.3 0 0 0-1.3-1.3H3.8a1.3 1.3 0 0 0-1.3 1.3v5.4a1.3 1.3 0 0 0 1.3 1.3h1.7" />
      </>,
      props,
    ),
  archive: (props: IconProps = {}) =>
    line(
      <>
        <rect x="2" y="3" width="12" height="3" rx="1" />
        <path d="M3 6v6.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6M6.5 9h3" />
      </>,
      props,
    ),
  duplicate: (props: IconProps = {}) =>
    line(
      <>
        <rect x="2.5" y="2.5" width="8" height="8" rx="1.6" />
        <path d="M5.5 13.5h6.4a1.6 1.6 0 0 0 1.6-1.6V5.5" />
      </>,
      props,
    ),
  sparkle: (props: IconProps = {}) => (
    <svg width={props.size ?? 16} height={props.size ?? 16} viewBox="0 0 16 16" aria-hidden="true" class={props.class} fill="currentColor">
      <path d="M8 1.5c.4 3 1.9 4.6 5 5-3.1.5-4.6 2-5 5-.4-3-1.9-4.5-5-5 3.1-.4 4.6-2 5-5Z" />
      <path d="M13 11c.15 1 .6 1.5 1.5 1.7-.9.2-1.35.7-1.5 1.8-.15-1.1-.6-1.6-1.5-1.8.9-.2 1.35-.7 1.5-1.7Z" opacity=".7" />
    </svg>
  ),
  user: (props: IconProps = {}) =>
    line(
      <>
        <circle cx="8" cy="5.5" r="2.6" />
        <path d="M3 13.5c.6-2.4 2.6-3.8 5-3.8s4.4 1.4 5 3.8" />
      </>,
      props,
    ),
  gear: (props: IconProps = {}) =>
    line(
      <>
        <circle cx="8" cy="8" r="2" />
        <path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1" />
      </>,
      props,
    ),
  folder: (props: IconProps = {}) => line(<path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z" />, props),
  arrowRight: (props: IconProps = {}) => line(<path d="M3 8h10M9 4l4 4-4 4" />, props),
  paperclip: (props: IconProps = {}) =>
    line(<path d="M13.2 7.6 8 12.8a3.3 3.3 0 0 1-4.7-4.7l5.4-5.4a2.2 2.2 0 0 1 3.1 3.1L6.4 11.2a1.1 1.1 0 0 1-1.6-1.6l4.9-4.9" />, props),
  undo: (props: IconProps = {}) => line(<path d="M5.5 3.5 2.5 6.5l3 3M2.5 6.5h7a4 4 0 0 1 0 8H7" />, props),
};

// ─── status glyphs (14px, viewBox 0 0 14 14) ────────────────────────────────

const C = 7;
const R = 5.6;

/** A pie wedge from 12 o'clock clockwise, radius r, 0 < p < 1. */
function wedge(r: number, p: number): string {
  const angle = 2 * Math.PI * p;
  const x = C + r * Math.sin(angle);
  const y = C - r * Math.cos(angle);
  return `M${C},${C} L${C},${C - r} A${r},${r} 0 ${p > 0.5 ? 1 : 0},1 ${x.toFixed(3)},${y.toFixed(3)} Z`;
}

export function StatusGlyph(props: { status: string; size?: number; class?: string }): JSX.Element {
  const size = () => props.size ?? 14;
  const body = (): JSX.Element => {
    switch (props.status) {
      case "backlog":
        return <circle cx={C} cy={C} r={R} fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="1.4 1.75" />;
      case "todo":
        return <circle cx={C} cy={C} r={R} fill="none" stroke="currentColor" stroke-width="1.5" />;
      case "in_progress":
        return (
          <>
            <circle cx={C} cy={C} r={R} fill="none" stroke="currentColor" stroke-width="1.5" />
            <path d={wedge(3.1, 0.5)} fill="currentColor" />
          </>
        );
      case "in_review":
        return (
          <>
            <circle cx={C} cy={C} r={R} fill="none" stroke="currentColor" stroke-width="1.5" />
            <path d={wedge(3.1, 0.75)} fill="currentColor" />
          </>
        );
      case "blocked":
        return (
          <>
            <circle cx={C} cy={C} r={R} fill="none" stroke="currentColor" stroke-width="1.5" />
            <rect x="3.9" y="6.2" width="6.2" height="1.6" rx=".8" fill="currentColor" />
          </>
        );
      case "done":
        return (
          <>
            <circle cx={C} cy={C} r="6.35" fill="currentColor" />
            <path d="m4.4 7.2 1.8 1.8 3.5-3.7" fill="none" stroke="var(--glyph-knockout)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </>
        );
      case "cancelled":
        return (
          <>
            <circle cx={C} cy={C} r="6.35" fill="currentColor" />
            <path d="m5 5 4 4M9 5 5 9" fill="none" stroke="var(--glyph-knockout)" stroke-width="1.5" stroke-linecap="round" />
          </>
        );
      default:
        return (
          <>
            <rect x="1.5" y="3" width="11" height="3" rx="1" fill="none" stroke="currentColor" stroke-width="1.3" />
            <path d="M2.5 6v4.5a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V6" fill="none" stroke="currentColor" stroke-width="1.3" />
          </>
        );
    }
  };
  return (
    <svg
      width={size()}
      height={size()}
      viewBox="0 0 14 14"
      aria-hidden="true"
      class={`glyph status-${props.status}${props.class ? ` ${props.class}` : ""}`}
    >
      {body()}
    </svg>
  );
}

/** Priority: three signal bars (low 1, medium 2, high 3), urgent = filled square with "!". */
export function PriorityGlyph(props: { priority: string; size?: number }): JSX.Element {
  const size = () => props.size ?? 14;
  const level = (): number => ({ low: 1, medium: 2, high: 3 } as Record<string, number>)[props.priority] ?? 0;
  return (
    <svg width={size()} height={size()} viewBox="0 0 14 14" aria-hidden="true" class={`glyph prio-${props.priority}`}>
      {props.priority === "urgent" ? (
        <>
          <rect x="1" y="1" width="12" height="12" rx="3" fill="currentColor" />
          <path d="M7 3.8v4" stroke="var(--glyph-knockout)" stroke-width="1.7" stroke-linecap="round" />
          <circle cx="7" cy="10.1" r=".95" fill="var(--glyph-knockout)" />
        </>
      ) : props.priority === "none" || !props.priority ? (
        <path d="M3 7h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity=".7" />
      ) : (
        <>
          <rect x="2" y="8" width="2.4" height="4" rx=".7" fill="currentColor" opacity={level() >= 1 ? 1 : 0.25} />
          <rect x="5.8" y="5" width="2.4" height="7" rx=".7" fill="currentColor" opacity={level() >= 2 ? 1 : 0.25} />
          <rect x="9.6" y="2" width="2.4" height="10" rx=".7" fill="currentColor" opacity={level() >= 3 ? 1 : 0.25} />
        </>
      )}
    </svg>
  );
}

export const PRIORITY_LABEL: Record<string, string> = {
  none: "No priority",
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
};
