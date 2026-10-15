/* ---------------------------------------------------------------------------
 * The design's small style vocabulary — buttons, pills, avatars, messages —
 * so every screen draws them identically. PURE and client-safe.
 * ------------------------------------------------------------------------- */
import type { CSSProperties, ReactElement } from "react";
import { ic } from "./art";

export const C = {
  ink: "#1A1E28",
  ink2: "#3D4453",
  mute: "#6B7385",
  faint: "#9BA3B2",
  line: "#DDE1E8",
  line2: "#EDEFF3",
  line3: "#F3F4F7",
  bg: "#F7F8FA",
  white: "#FFFFFF",
  violet: "#6835FB",
  violetInk: "#5223E0",
  violetDeep: "#3D14A8",
  violetTint: "#F1ECFF",
  violetTint2: "#F7F4FF",
  violetLine: "#DDD2FF",
  lime: "#C6FF34",
  red: "#B3261E",
  redTint: "#FCECEC",
  redLine: "#F6CFCF",
  green: "#1D7A45",
  greenTint: "#E9F5EE",
  greenLine: "#BFE3CD",
  amber: "#8A5C05",
  amberTint: "#FDF6E7",
  amberLine: "#F9E9C4",
  amberDot: "#B77B08",
  grey: "#C2C8D2",
};

export const AVC = ["#5223E0", "#2B5CBF", "#1D7A45", "#8A5C05", "#B3261E", "#3D4453"];

/** p primary · d danger · g go · off disabled · anything else secondary. */
export function btn(k: "p" | "d" | "g" | "off" | "s", h?: number): CSSProperties {
  const base: CSSProperties = { width: "100%", height: (h || 60) + "px", borderRadius: "16px", fontSize: "18px", fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: "8px", border: "none" };
  if (k === "p") return { ...base, background: C.violet, color: C.white };
  if (k === "d") return { ...base, background: C.red, color: C.white };
  if (k === "off") return { ...base, background: C.line2, color: C.faint, cursor: "not-allowed" };
  if (k === "g") return { ...base, background: C.green, color: C.white };
  return { ...base, background: C.white, color: C.ink, border: "1.5px solid " + C.grey };
}

export function Pill({ l, bg, fg }: { l: string; bg: string; fg: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", height: "26px", padding: "0 10px", borderRadius: "13px", fontSize: "13px", fontWeight: 600, background: bg, color: fg, whiteSpace: "nowrap", flex: "none" }}>
      {l}
    </span>
  );
}

/** A stable colour per person: the index in the roster, as the design does it. */
export function avStyle(index: number, s?: number): CSSProperties {
  const z = s || 56;
  return { width: z + "px", height: z + "px", borderRadius: "50%", background: AVC[(index < 0 ? 0 : index) % AVC.length], color: C.white, fontSize: Math.round(z * 0.36) + "px", fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flex: "none", border: "none", cursor: "pointer" };
}

export function initials(name: string): string {
  return name ? name.split(" ").filter(Boolean).map((w) => w[0]).join("").slice(0, 2) : "?";
}

export type Tone = "warn" | "bad" | "ok" | "info";
const TONES: Record<Tone, [string, string, string]> = {
  warn: [C.amberTint, C.amber, "alert"],
  bad: [C.redTint, C.red, "x"],
  ok: [C.greenTint, C.green, "check"],
  info: [C.violetTint, C.violetDeep, "help"],
};
export type Msg = { t: string; tone: Tone };
export const msg = (t: string, tone: Tone = "info"): Msg => ({ t, tone });

export function MsgBox({ m }: { m: Msg }): ReactElement {
  const c = TONES[m.tone];
  return (
    <div style={{ display: "flex", gap: "10px", padding: "12px 14px", borderRadius: "14px", background: c[0], color: c[1], fontSize: "15px", lineHeight: "21px", fontWeight: 600 }}>
      <span style={{ flex: "none", display: "flex", marginTop: "1px" }}>{ic(c[2], 20, c[1])}</span>
      <span>{m.t}</span>
    </div>
  );
}

export const card: CSSProperties = { background: C.white, border: "1px solid " + C.line, borderRadius: "18px" };
export const mono: CSSProperties = { fontFamily: "'IBM Plex Mono',monospace" };
export const artWell = (w: number, r: number): CSSProperties => ({ width: w + "px", height: w + "px", flex: "none", borderRadius: r + "px", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center" });
