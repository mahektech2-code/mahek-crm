import { z } from "zod";

// A festival or promotional moment. Dates are date-only strings (never a timestamp), maintained by
// hand each year because festival dates move. `date: null` means "Any time" (not date-bound).
export const occasionSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, "kebab-case id"),
  label: z.string().min(1),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "date-only YYYY-MM-DD")
    .nullable(),
  /** Accent colour for calendar dots in the UI. Decoration only. */
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});
export type Occasion = z.infer<typeof occasionSchema>;

/**
 * Dated occasions that have not passed yet, soonest first. `todayKey` is today's date in India as
 * "YYYY-MM-DD". Occasions with no date ("Any time") are never "coming up".
 */
export function upcomingOccasions(occasions: readonly Occasion[], todayKey: string, limit?: number): Occasion[] {
  const upcoming = occasions
    .filter((o): o is Occasion & { date: string } => o.date !== null && o.date >= todayKey)
    .sort((a, b) => a.date.localeCompare(b.date));
  return limit === undefined ? upcoming : upcoming.slice(0, limit);
}
