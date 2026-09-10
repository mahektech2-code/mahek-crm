/**
 * The journey to one shop, as rules rather than as conditions scattered
 * through three screens.
 *
 * This is the half of the travel module that runs while somebody is actually
 * travelling. `data/travel.ts` and `/travel` are the other half — the day log,
 * where a journey already over is typed up and priced by the policy engine —
 * and everything here feeds the same `travel_legs` table so the two cannot
 * disagree about what a day cost.
 *
 * Pure on purpose, like every other engine here: no clock, no camera, no
 * store. The mode arrives as a row from `travel_modes`, because whether a mode
 * needs a meter read is `requiresOdometer` on that row — a fact an admin
 * edits, not a constant. Everything is checked here so it can be tested
 * without a device, and a rule that can only be exercised by standing in a
 * street with a camera is a rule nobody tests.
 */

export type OdometerVerdict =
  | { ok: true; km: number; distanceKm: number | null }
  | { ok: false; why: string };

/**
 * Is this a reading anybody can act on.
 *
 * IT IS CHECKED WHILE HE IS STILL STANDING AT THE METER, which is the only
 * moment it can be checked at all. An hour later nobody can look again, and a
 * mistyped figure is indistinguishable from a long day — 41,208 entered as
 * 4,120 turns one journey into a claim for thirty-seven thousand kilometres,
 * and the policy engine would price it without a murmur. So the refusal
 * happens on the camera screen with the meter in shot, and `handleTravelLeg`
 * checks the same rules again, because a check that lives only in an interface
 * is not a check.
 *
 * `previousKm` is the departure reading when this is an arrival, and null when
 * this is the departure. That is the only difference between the two calls,
 * which is why there is one function: two would drift, and the half that
 * drifted would be the one nobody was reading.
 */
export function checkOdometer(args: {
  typed: string;
  previousKm: number | null;
  maxLegKilometres: number;
}): OdometerVerdict {
  const raw = args.typed.trim();
  if (!raw) return { ok: false, why: 'Type what the meter reads.' };

  /* Whole kilometres. Trip meters show a decimal and odometers do not, and a
     salesman reading "41208.6" off a dashboard should not be refused over the
     part nobody is paid for — so it is accepted and dropped, rather than
     rejected on a full stop. */
  if (!/^\d{1,7}(\.\d+)?$/.test(raw)) {
    return { ok: false, why: 'Type the number only — no commas, no letters.' };
  }
  const km = Math.floor(Number(raw));
  if (!Number.isFinite(km)) return { ok: false, why: 'That is not a reading this app can store.' };

  if (args.previousKm == null) return { ok: true, km, distanceKm: null };

  if (km < args.previousKm) {
    return {
      ok: false,
      why: `You set off on ${args.previousKm.toLocaleString('en-IN')} km and a meter does not run backwards. It is usually a digit dropped from the front — look again.`,
    };
  }

  const distanceKm = km - args.previousKm;
  if (distanceKm > args.maxLegKilometres) {
    return {
      ok: false,
      why: `That would be ${distanceKm.toLocaleString('en-IN')} km for one trip, and the most a single journey can be recorded as is ${args.maxLegKilometres.toLocaleString('en-IN')} km. Check the reading.`,
    };
  }

  return { ok: true, km, distanceKm };
}

/* ─────────────────────────────────────────────────────────── the ticket */

export type FareVerdict = { ok: true; paise: number } | { ok: false; why: string };

/**
 * The fare, in paise, because money is paise everywhere in MahekOne.
 *
 * A fare of nothing is refused rather than stored as zero: a free ride is not
 * a ticket, and a ₹0 line reaching the day's claim is something somebody has
 * to open, read and dismiss. Nothing here caps it — exceeding a cap flags a
 * claim and never refuses one, the same rule the whole expense module runs on,
 * and the policy engine is where that is decided.
 */
export function checkFare(typed: string): FareVerdict {
  const raw = typed.trim().replace(/,/g, '');
  if (!raw) return { ok: false, why: 'Type what the ticket cost.' };
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(raw)) {
    return { ok: false, why: 'Type the rupees only — 40, or 40.50.' };
  }
  const paise = Math.round(Number(raw) * 100);
  if (paise <= 0) return { ok: false, why: 'A ticket that cost nothing is not a ticket to claim.' };
  return { ok: true, paise };
}

/* ────────────────────────────────────────────────────── what to say next */

/**
 * What the arrival step is asking for, said as one sentence and one button.
 *
 * The button words are the load-bearing half. "I have arrived" on a metered
 * mode opens a camera, and somebody who presses it expecting the visit to
 * start has already put the phone back in his pocket — so it says what happens
 * next instead.
 */
export function arrivalPrompt(leg: {
  requiresOdometer: boolean;
  odometerStartKm: number | null;
}): { line: string; button: string } {
  if (leg.requiresOdometer) {
    return {
      line:
        leg.odometerStartKm == null
          ? 'Read the meter now that you are here.'
          : `You set off on ${leg.odometerStartKm.toLocaleString('en-IN')} km. Read the meter again now that you are here.`,
      button: 'I am here — photograph the meter',
    };
  }
  return {
    line: 'The visit starts when you tell it you have arrived.',
    button: 'I am here — start the visit',
  };
}

/**
 * How long he has been travelling, for the strip on the journey screen.
 *
 * It counts UP rather than down. There is no expected duration to count
 * against — the office does not know how far away the shop is — and inventing
 * one would put a salesman "late" for a traffic jam.
 */
export function travellingFor(startedAt: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - startedAt) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** `Bike · 23 km` / `Bus · ₹40` / `Walked` — one line about a finished leg. */
export function legLine(leg: {
  modeLabel: string;
  odometerStartKm: number | null;
  odometerEndKm: number | null;
  ticketAmountPaise: number | null;
}): string {
  /* A distance is printed only where BOTH readings exist. One reading is not
     half a distance — it is a departure nobody closed — and a figure from an
     arithmetic with a missing operand would be inventing the number this line
     exists to report. */
  if (leg.odometerStartKm != null && leg.odometerEndKm != null) {
    return `${leg.modeLabel} · ${leg.odometerEndKm - leg.odometerStartKm} km`;
  }
  if (leg.ticketAmountPaise != null) {
    return `${leg.modeLabel} · ₹${Math.round(leg.ticketAmountPaise / 100)}`;
  }
  return leg.modeLabel;
}
