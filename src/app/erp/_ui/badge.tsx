import { FLAG, ST_TONE, TONES, type Tone } from "@/lib/erp/ui";

export function Badge({ label, tone }: { label: string; tone?: Tone }) {
  const t = TONES[tone ?? "neutral"];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        height: 22,
        padding: "0 8px",
        borderRadius: 11,
        background: t[0],
        color: t[1],
        fontSize: 12,
        fontWeight: 500,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

/** A status value, in the tone that value is always drawn in. */
export function StatusBadge({ value }: { value: string | number | null | undefined }) {
  if (value == null || value === "") return null;
  const v = String(value);
  return <Badge label={v} tone={ST_TONE[v] ?? "neutral"} />;
}

export function FlagBadge({ flag }: { flag: string }) {
  const f = FLAG[flag];
  return <Badge label={f ? f[0] : flag} tone={f ? f[1] : "neutral"} />;
}

/** The first flag that deserves a coloured edge on its row. */
export function rowTone(flags: string[]): Tone | null {
  for (const f of flags) {
    const t = FLAG[f]?.[1];
    if (t && t !== "neutral" && t !== "muted") return t;
  }
  return null;
}

/** An "AI-n" chip, the way the design marks anything the AI produced. */
export function AiChip({ label }: { label: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        height: 20,
        padding: "0 8px",
        borderRadius: 10,
        background: "#F1ECFF",
        color: "#5223E0",
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: "0.02em",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}
