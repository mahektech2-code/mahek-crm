// Template colours are hex (#RGB, #RRGGBB, #RRGGBBAA) or rgb()/rgba(). Pango and SVG both want a
// 6-digit hex plus a separate opacity, so colours are normalised once here.
export type Color = { hex: string; alpha: number };

export function parseColor(input: string): Color {
  const s = input.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
  if (hex) {
    let h = hex[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    const alpha = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return { hex: `#${h.slice(0, 6).toUpperCase()}`, alpha };
  }
  const rgb = /^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*(?:,\s*([0-9.]+)\s*)?\)$/i.exec(s);
  if (rgb) {
    const to = (v: string) => Math.max(0, Math.min(255, Math.round(Number(v)))).toString(16).padStart(2, "0");
    return { hex: `#${to(rgb[1])}${to(rgb[2])}${to(rgb[3])}`.toUpperCase(), alpha: rgb[4] === undefined ? 1 : Math.max(0, Math.min(1, Number(rgb[4]))) };
  }
  throw new Error(`unsupported colour "${input}"`);
}
