import { Badge as CrmBadge, type Tone as CrmTone } from "@/components/ui/primitives";
import type { Tone } from "@/lib/erp/ui";
import { useKit } from "./kit";

/*
 * The ERP's statuses and flags, drawn as the CRM's own badge.
 *
 * The ERP names seven tones and the CRM draws six: `info` is the one it lacks,
 * and it lands on brand — "Under process", "In transit", "Order placed" are
 * all work moving, which is what the brand tint already says on the CRM's
 * screens.
 */
const TO_CRM: Record<Tone, CrmTone> = {
  success: "success",
  danger: "danger",
  warn: "warn",
  info: "brand",
  brand: "brand",
  neutral: "neutral",
  muted: "muted",
};

export function crmTone(t: Tone | undefined): CrmTone {
  return TO_CRM[t ?? "neutral"];
}

export function Badge({ label, tone }: { label: string; tone?: Tone }) {
  return <CrmBadge tone={crmTone(tone)}>{label}</CrmBadge>;
}

/** A status value, in the tone that value is always drawn in. */
export function StatusBadge({ value }: { value: string | number | null | undefined }) {
  const { tones } = useKit();
  if (value == null || value === "") return null;
  const v = String(value);
  return <Badge label={v} tone={tones[v] ?? "neutral"} />;
}

export function FlagBadge({ flag }: { flag: string }) {
  const f = useKit().flags[flag];
  return <Badge label={f ? f[0] : flag} tone={f ? f[1] : "neutral"} />;
}

/** The first flag that deserves a coloured edge on its row. */
export function rowTone(flags: string[], vocab: Record<string, [string, Tone]>): Tone | null {
  for (const f of flags) {
    const t = vocab[f]?.[1];
    if (t && t !== "neutral" && t !== "muted") return t;
  }
  return null;
}

/** An "AI-n" chip, the way the design marks anything the AI produced. */
export function AiChip({ label }: { label: string }) {
  return <CrmBadge tone="brand">{label}</CrmBadge>;
}
