/**
 * @pi-unipi/footer — Lolcat rainbow gradient painting
 *
 * Classic sine algorithm (lolcat -a): red/green/blue chase each other by
 * 2π/3 across character position; phase advances with wall time so the 1s
 * footer refresh ticks drive visible motion.
 *
 * Issue #34: painting must NEVER split a glyph. Emoji (🤖 U+1F916, 🔀
 * U+1F500) are surrogate pairs — indexing the string per UTF-16 code unit
 * let the rainbow renderer insert an SGR between the two halves, which
 * terminals render as replacement characters. Painting therefore advances
 * per code point (with emoji variation selectors kept attached) and copies
 * ANSI/OSC/APC escape sequences verbatim.
 */

/** Radians per char — short words → tight sweep. */
const LOLCAT_FREQ = 0.9;

const ANSI_CSI_RE = /^\x1b\[[0-?]*[ -/]*[@-~]/;
const ANSI_STRING_RE = /^\x1b[\]_][^\x07]*(?:\x07|\x1b\\)/;
const VARIATION_SELECTOR_16 = 0xfe0f;

/** UTF-16 length of the glyph starting at `i`: full code point, plus a
 * trailing VS16 (⬇️ = U+2B07 U+FE0F) so the SGR emitted after the glyph
 * can never detach emoji presentation from its base character. */
function glyphLength(line: string, i: number): number {
	const cp = line.codePointAt(i)!;
	let len = cp > 0xffff ? 2 : 1;
	if (line.codePointAt(i + len) === VARIATION_SELECTOR_16) len += 1;
	return len;
}

function sineColor(t: number, offset: number): number {
	return Math.round(Math.sin(t + offset) * 127 + 128);
}

/** Per-character rainbow — used for the UNIPI brand word (ASCII only). */
export function lolcatRainbow(text: string, phase: number): string {
	return text
		.split("")
		.map((ch, i) => {
			const t = LOLCAT_FREQ * i + phase;
			return `\x1b[38;2;${sineColor(t, 0)};${sineColor(t, (2 * Math.PI) / 3)};${sineColor(t, (4 * Math.PI) / 3)}m${ch}`;
		})
		.join("") + "\x1b[39m";
}

/**
 * Apply a flowing lolcat gradient to an already-composed frame line.
 * Printable glyphs get per-position truecolor from the sine palette;
 * existing escape sequences pass through untouched (they mostly come from
 * the brand itself, which already carries its own colors).
 */
export function paintLolcatGradient(line: string, phaseBase: number): string {
	let out = "";
	let pos = 0;
	let i = 0;
	while (i < line.length) {
		if (line[i] === "\x1b") {
			// Copy escape sequences verbatim: CSI SGR, OSC 133 zone markers
			// (\x1b]133;A BEL) and the APC CURSOR_MARKER (\x1b_pi:c BEL).
			// Painting their bytes produced "_pi:c" garbage in rainbow mode.
			const csi = ANSI_CSI_RE.exec(line.slice(i));
			if (csi) {
				out += csi[0];
				i += csi[0].length;
				continue;
			}
			const strSeq = ANSI_STRING_RE.exec(line.slice(i));
			if (strSeq) {
				out += strSeq[0];
				i += strSeq[0].length;
				continue;
			}
		}
		const len = glyphLength(line, i);
		const glyph = line.slice(i, i + len); // whole code point — never split a surrogate pair
		const t = LOLCAT_FREQ * 0.35 * pos + phaseBase;
		out += `\u001b[38;2;${sineColor(t, 0)};${sineColor(t, (2 * Math.PI) / 3)};${sineColor(t, (4 * Math.PI) / 3)}m${glyph}`;
		pos++;
		i += len;
	}
	return out + "\u001b[39m";
}
