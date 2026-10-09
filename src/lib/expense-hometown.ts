import { placeKey } from "@/lib/place-parse";

/* ---------------------------------------------------------------------------
 * "Away from his hometown" — PURE, no I/O.
 *
 * The expense policy pays meals only on a day spent away from where the
 * salesman lives. The handset has always sent `departedFromHometown: true`,
 * because it cannot know where home is, so the office decides it from what
 * the day actually holds: the shops he checked in at, the city he named for
 * the trip, and whether he stayed out overnight.
 *
 * With NO hometown set the recorded answer stands — the rule is off for him,
 * rather than every day of his being read as a day at home, which would take
 * his meals away for a setting nobody has filled in yet.
 * ------------------------------------------------------------------------- */

export type HometownEvidence = {
  /** Where he lives, as set on the console. Null when nobody has. */
  hometown: string | null;
  /** The town of every shop he checked in at that day. */
  visitCities: readonly (string | null)[];
  /** The city he named for the trip, where he named one. */
  destinationCity: string | null;
  overnight: boolean;
  /** What the day carried before this — the handset's answer. */
  recorded: boolean;
};

export function awayFromHometown(e: HometownEvidence): boolean {
  const home = placeKey(e.hometown);
  if (!home) return e.recorded;
  if (e.overnight) return true;
  /* A shop's town is often a whole postal address typed into the column
     ("06, Mahadev Towers, LBS Marg, Thane, Maharashtra"), so a town is home
     where any comma-separated part of it is. An unknown town is no evidence
     of travel. */
  const elsewhere = (c: string | null) => {
    const parts = (c ?? "").split(",").map(placeKey).filter(Boolean);
    return parts.length > 0 && !parts.includes(home);
  };
  if (elsewhere(e.destinationCity)) return true;
  return e.visitCities.some(elsewhere);
}
