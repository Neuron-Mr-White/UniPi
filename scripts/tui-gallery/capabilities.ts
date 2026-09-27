// "What can a terminal UI do?" demos. Each variant is one capability, with a
// note on where it breaks, so you know the limits before picking a style.
import { getCapabilities, hyperlink, visibleWidth } from "@earendil-works/pi-tui";
import { BORDERS, type Color, type Ctx, hsl, rgb, smoothBar, spark, spin, SPINNERS, type Bg } from "./kit.ts";

export interface Variant {
  id: string;
  name: string;
  note: string;
  animated?: boolean;
  render: (ctx: Ctx) => string[];
}

const COLORS: Color[] = [
  "text", "muted", "dim", "accent", "border", "borderAccent", "borderMuted", "success", "error", "warning",
  "mdHeading", "mdLink", "mdCode", "customMessageLabel", "syntaxKeyword", "syntaxString", "syntaxType", "syntaxFunction",
  "thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh",
];
const BGS: Bg[] = ["selectedBg", "userMessageBg", "customMessageBg", "toolPendingBg", "toolSuccessBg", "toolErrorBg"];

export const CAPABILITIES: Variant[] = [
  {
    id: "palette",
    name: "Theme palette",
    note: "Every color token an extension can use. Using tokens (not raw hex) means your look follows the user's Pi theme, light or dark.",
    render: ({ t, width }) => {
      const cols = Math.max(1, Math.floor(width / 24));
      const out: string[] = [];
      for (let i = 0; i < COLORS.length; i += cols) {
        out.push(COLORS.slice(i, i + cols).map((c) => `${t.fg(c, "██")} ${t.fg(c, c.padEnd(20))}`).join(""));
      }
      out.push("");
      out.push(BGS.map((b) => t.bg(b, ` ${b} `)).join(" "));
      return out;
    },
  },
  {
    id: "depth",
    name: "Color depth",
    note: "16 → 256 → truecolor. Under tmux, truecolor needs `set -ga terminal-overrides ',*:Tc'`; Pi falls back to 256 automatically.",
    render: ({ t, width }) => {
      const ansi = Array.from({ length: 16 }, (_, i) => `\x1b[48;5;${i}m  \x1b[49m`).join("");
      const cube = Array.from({ length: Math.min(width, 216) }, (_, i) => `\x1b[48;5;${16 + Math.floor((i / Math.min(width, 216)) * 216)}m \x1b[49m`).join("");
      // Two rows per cell with ▀ (fg = top, bg = bottom): doubles vertical resolution.
      const grad = (row: number) =>
        Array.from({ length: width }, (_, x) => {
          const [r1, g1, b1] = hsl((x / width) * 360, 0.7, 0.55 - row * 0.1);
          const [r2, g2, b2] = hsl((x / width) * 360, 0.7, 0.5 - row * 0.1);
          return `\x1b[38;2;${r1};${g1};${b1};48;2;${r2};${g2};${b2}m▀`;
        }).join("") + "\x1b[0m";
      return [
        t.fg("dim", "16 ANSI (follows the terminal's own scheme)"), ansi,
        t.fg("dim", "256-color cube"), cube,
        t.fg("dim", `truecolor, half-block rows (Pi is running in ${t.getColorMode()})`), grad(0), grad(1),
      ];
    },
  },
  {
    id: "styles",
    name: "Text styles",
    note: "Bold/dim/italic/underline/inverse/strike work almost everywhere. Curly & colored underlines: kitty, WezTerm, foot, Ghostty, iTerm2 — others show a plain underline or nothing.",
    render: ({ t }) => [
      `${t.bold("bold")}  ${t.fg("dim", "dim")}  ${t.italic("italic")}  ${t.underline("underline")}  ${t.inverse(" inverse ")}  ${t.strikethrough("strike")}`,
      `${t.bold(t.fg("accent", "bold accent"))}  ${t.italic(t.fg("muted", "italic muted"))}  ${t.inverse(t.fg("success", " chip "))} ${t.inverse(t.fg("error", " chip "))} ${t.inverse(t.fg("customMessageLabel", " chip "))}`,
      `\x1b[4:3mcurly underline\x1b[4:0m   \x1b[4:3m\x1b[58:2::204:102:102mred squiggle (like a spell-check)\x1b[59m\x1b[4:0m   \x1b[4:2mdouble\x1b[4:0m   \x1b[4:4mdotted\x1b[4:0m   \x1b[53moverline\x1b[55m`,
      `\x1b[5mblink\x1b[25m ${t.fg("dim", "(usually disabled; don't rely on it)")}`,
    ],
  },
  {
    id: "borders",
    name: "Borders & frames",
    note: "All box-drawing sets are safe in any monospace font. Half-block frames (▗▄▖) look like soft 'cards' but need exact line heights.",
    render: ({ t, width }) => {
      const w = Math.min(18, Math.floor((width - 6) / 6));
      const sets = Object.entries(BORDERS).map(([name, b]) => [
        t.fg("borderMuted", b.tl + b.h.repeat(w - 2) + b.tr),
        t.fg("borderMuted", b.v) + name.padEnd(w - 2) + t.fg("borderMuted", b.v),
        t.fg("borderMuted", b.bl + b.h.repeat(w - 2) + b.br),
      ]);
      const rows = [0, 1, 2].map((r) => sets.map((s) => s[r]).join(" "));
      const c = (s: string) => t.fg("accent", s);
      return [
        ...rows,
        "",
        `${c("▗" + "▄".repeat(w) + "▖")}  ${t.fg("accent", "▎")} left bar      ${t.fg("accent", "▌")} half bar     ${t.fg("accent", "┃")} heavy rule`,
        `${c("▐")}${t.inverse(t.fg("accent", " soft card".padEnd(w)))}${c("▌")}  ${t.fg("accent", "▎")} groups lines  ${t.fg("accent", "▌")} bolder       ${t.fg("accent", "┃")} classic`,
        `${c("▝" + "▀".repeat(w) + "▘")}`,
        `${t.fg("borderMuted", "─".repeat(12))}  ${t.fg("borderMuted", "┄".repeat(12))}  ${t.fg("borderMuted", "╌".repeat(12))}  ${t.fg("borderMuted", "━".repeat(12))}  ${t.fg("borderMuted", "═".repeat(12))}`,
      ];
    },
  },
  {
    id: "blocks",
    name: "Bars, sparklines, braille",
    note: "Eighth-blocks give 8 steps per cell for smooth bars; braille gives a 2×4 dot grid per cell for tiny charts. Both are standard Unicode.",
    render: ({ t, width }) => {
      const bw = Math.min(40, width - 20);
      const bars = [0.12, 0.47, 0.83].map((r) => {
        const b = smoothBar(r, bw);
        return `${t.fg("accent", b.full)}${t.fg("borderMuted", "░".repeat(b.rest.length))} ${t.fg("dim", `${Math.round(r * 100)}%`)}`;
      });
      const vals = Array.from({ length: Math.min(48, width - 20) }, (_, i) => 5 + Math.sin(i / 3) * 4 + ((i * 7) % 5));
      // Braille line chart: 2 columns × 4 rows per character.
      const brailleRow = Array.from({ length: Math.min(40, width - 20) }, (_, i) => {
        const y1 = Math.round(((Math.sin((i * 2) / 5) + 1) / 2) * 3);
        const y2 = Math.round(((Math.sin((i * 2 + 1) / 5) + 1) / 2) * 3);
        const left = [0x40, 0x04, 0x02, 0x01][y1]!;
        const right = [0x80, 0x20, 0x10, 0x08][y2]!;
        return String.fromCharCode(0x2800 + left + right);
      }).join("");
      return [
        ...bars,
        `${t.fg("success", spark(vals))}  ${t.fg("dim", "sparkline ▁▂▃▄▅▆▇█")}`,
        `${t.fg("customMessageLabel", brailleRow)}  ${t.fg("dim", "braille chart")}`,
        `${t.fg("warning", "░░▒▒▓▓██")}  ${t.fg("dim", "shades")}   ${t.fg("accent", "▰▰▰▱▱")} ${t.fg("accent", "●●●○○")} ${t.fg("accent", "■■■□□")} ${t.fg("accent", "⣿⣿⣿⣀⣀")}  ${t.fg("dim", "score styles")}`,
      ];
    },
  },
  {
    id: "motion",
    name: "Spinners",
    note: "Pi redraws only changed lines, so small spinners are cheap. Keep one spinner per surface; avoid animating inside the scrolled-back transcript.",
    animated: true,
    render: (ctx) => {
      const names = Object.keys(SPINNERS);
      const out: string[] = [];
      for (let i = 0; i < names.length; i += 5) {
        out.push(names.slice(i, i + 5).map((n) => `${ctx.t.fg("accent", spin(ctx, n, n === "pulse" || n === "toggle" ? 3 : 1))} ${n.padEnd(10)}`).join(""));
      }
      const w = Math.min(30, ctx.width - 30);
      const pos = ctx.frame % (w * 2);
      const x = pos < w ? pos : w * 2 - pos;
      const shimmer = Array.from({ length: w }, (_, i) => {
        const d = Math.abs(i - x);
        return d < 1 ? ctx.t.fg("text", "━") : d < 3 ? ctx.t.fg("accent", "━") : ctx.t.fg("borderMuted", "━");
      }).join("");
      const word = "Thinking";
      const glow = [...word].map((ch, i) => (Math.abs(i - (ctx.frame % (word.length + 6)) + 3) < 2 ? ctx.t.bold(ctx.t.fg("text", ch)) : ctx.t.fg("dim", ch))).join("");
      const indeterminate = smoothBar(((ctx.frame % 40) / 40), w);
      return [
        ...out,
        "",
        `${shimmer}  ${ctx.t.fg("dim", "scanner")}`,
        `${glow}  ${ctx.t.fg("dim", "shimmer text")}`,
        `${ctx.t.fg("success", indeterminate.full)}${ctx.t.fg("borderMuted", "·".repeat(indeterminate.rest.length))}  ${ctx.t.fg("dim", "progress")}`,
      ];
    },
  },
  {
    id: "links",
    name: "Hyperlinks (OSC 8)",
    note: "Clickable text that hides the URL. Works in most modern terminals and tmux ≥ 3.4 (with the hyperlinks feature). Elsewhere it degrades to plain text.",
    render: ({ t }) => {
      const caps = getCapabilities();
      return [
        `${hyperlink(t.fg("mdLink", t.underline("docs/v3-tasks.md")), "file:///")}   ${hyperlink(t.fg("mdLink", "T-3 on the board"), "http://localhost")}`,
        t.fg("dim", `detected here: hyperlinks=${String(caps.hyperlinks)} · images=${String(caps.images ?? "none")}`),
      ];
    },
  },
  {
    id: "width",
    name: "Width traps",
    note: "The ruler must line up with every `|`. Emoji and CJK take 2 cells; Nerd-Font icons need a patched font and break alignment when missing. UniPi should stick to rows marked ✓.",
    render: ({ t }) => {
      const rows: Array<[string, string, boolean]> = [
        ["ascii", "abcdefgh", true],
        ["geometric", "●○◆◇▣◈⊘✓", true],
        ["arrows", "→←↑↓↵⇥⏎↳", true],
        ["box/blocks", "─│┌┐▌▐█░", true],
        ["emoji", "✅🚀", false],
        ["CJK", "記憶体", false],
        ["nerd font", "\uf418\ue725\uf07b\uf121", false],
      ];
      const ruler = "0123456789";
      return [
        t.fg("dim", `${"".padEnd(12)}${ruler}`),
        ...rows.map(([name, s, ok]) => {
          const pad = Math.max(0, 8 - visibleWidth(s));
          return `${name.padEnd(12)}${s}${" ".repeat(pad)}|  ${ok ? t.fg("success", "✓ safe") : t.fg("warning", "risky")}  ${t.fg("dim", `measured ${String(visibleWidth(s))} cells`)}`;
        }),
      ];
    },
  },
  {
    id: "rainbow",
    name: "Gradient text",
    note: "Per-character truecolor. Great for a logo or a one-off banner; noisy for everyday lines. Ignores the theme, so use sparingly.",
    render: ({ width }) => {
      const text = "UniPi · unified pi agent suite";
      const g = (s: string, h0: number, h1: number) =>
        [...s].map((ch, i) => rgb(...hsl(h0 + ((h1 - h0) * i) / s.length, 0.65, 0.65), ch)).join("");
      return [
        `\x1b[1m${g(text, 180, 300)}\x1b[22m`,
        g("━".repeat(Math.min(width, text.length)), 180, 300),
        `\x1b[1m${g(text, 20, 60)}\x1b[22m`,
      ];
    },
  },
];
