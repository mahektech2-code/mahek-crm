/* ---------------------------------------------------------------------------
 * THE SEVEN STAGES PEOPLE SEE, as words and as the stored values behind them.
 *
 * `displayStageOf` (in the ladder engine) says which of the seven a stored rung
 * is drawn under. Every screen that names a lead's stage, every filter that
 * offers one and every count that groups by one needs the two halves of that
 * map — the word for a stored value, and every stored value behind a word — and
 * each used to work its own out. So the Handovers list said "Won" where the
 * record said "Customer", the stage filter offered "Won" and "Customer" as two
 * options for one stage, and the Negotiation desk listed `negotiation` and
 * missed `commercial_discussion`, which the record draws as Negotiation.
 *
 * Pure and client-safe. It lives beside the engine rather than in it because
 * the engine and `lead-labels.ts` are byte-mirrored to the handset.
 * ------------------------------------------------------------------------- */

import { DISPLAY_STAGES, displayStageOf, type DisplayStage } from "./engines/lead-ladder";
import { ALL_LEAD_STAGES, stageLabel, type LeadStage } from "./lead-labels";

/**
 * The words for a stored stage: the display stage's own label where it has
 * one, the rung's label where it is off the bar (On hold, Lost). A display
 * stage is itself a stage value, so `stageLabel` names it.
 */
export function displayStageLabel(stage: LeadStage | null | undefined): string {
  if (!stage) return "";
  return stageLabel(displayStageOf(stage) ?? stage);
}

/** Every stored stage drawn under one display stage, in the enum's order. */
export function rawStagesOf(display: DisplayStage): LeadStage[] {
  return ALL_LEAD_STAGES.filter((s) => displayStageOf(s) === display);
}

/**
 * A stage filter's options: the seven, then whatever stored value is off the
 * bar (On hold, Lost), each once. `value` is the comma-joined stored values a
 * pick stands for, so a filter can match all of them.
 */
export function displayStageOptions(): { key: string; label: string; stages: LeadStage[] }[] {
  const out = DISPLAY_STAGES.map((d) => ({ key: d, label: stageLabel(d), stages: rawStagesOf(d) }));
  for (const s of ALL_LEAD_STAGES) {
    if (displayStageOf(s) === null) out.push({ key: s, label: stageLabel(s), stages: [s] });
  }
  return out;
}

/**
 * What a picked filter key means in stored values: a display stage stands for
 * every rung under it, anything else for itself. Unknown keys are dropped.
 */
export function stagesForFilterKey(key: string): LeadStage[] {
  if ((DISPLAY_STAGES as readonly string[]).includes(key)) return rawStagesOf(key as DisplayStage);
  return (ALL_LEAD_STAGES as string[]).includes(key) ? [key as LeadStage] : [];
}

/**
 * Stored-stage counts (one row per raw value, as a `group by` answers) folded
 * into one option per display stage, biggest first. A raw value with no
 * display stage (On hold, Lost) is its own option.
 */
export function foldStageOptions(
  rows: readonly { value: string | null; count: number | string }[],
): { value: string; label: string; count: number }[] {
  const by = new Map<string, number>();
  for (const r of rows) {
    if (!r.value) continue;
    const key = displayStageOf(r.value as LeadStage) ?? r.value;
    by.set(key, (by.get(key) ?? 0) + Number(r.count));
  }
  return [...by.entries()]
    .map(([value, count]) => ({ value, label: stageLabel(value as LeadStage), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}
