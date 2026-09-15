export interface SliderCost {
  input: number;
  output: number;
}

export function blendedPrice(cost: SliderCost | undefined): number | undefined {
  return cost === undefined ? undefined : (cost.input + cost.output) * 0.5;
}

export function sliderPosition(price: number, min: number, max: number, cells: number): number {
  if (cells <= 1 || max <= min) return 0;
  const value = Math.log10(Math.max(price, Number.EPSILON));
  const low = Math.log10(Math.max(min, Number.EPSILON));
  const high = Math.log10(Math.max(max, Number.EPSILON));
  return Math.max(0, Math.min(cells - 1, Math.round(((value - low) / (high - low)) * (cells - 1))));
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

export function renderSlider(cells: number, markerIndex: number | undefined): string {
  const count = Math.max(0, cells);
  let out = "";
  for (let i = 0; i < count; i++) {
    if (i === markerIndex) out += "\x1b[97m●";
    else {
      const [r, g, b] = hsvToRgb(count <= 1 ? 0 : (270 * i) / (count - 1), 0.85, 0.95);
      out += `\x1b[38;2;${String(r)};${String(g)};${String(b)}m━`;
    }
  }
  return `${out}\x1b[39m`;
}
