/**
 * What the status strip's GPS light is allowed to say.
 *
 * IT USED TO SAY "Finding GPS" FOREVER, on a handset fixing to three metres
 * every three seconds. The light read `store.gps`, and that field is written
 * in exactly three places — the two check-in flows on Home and the visit
 * screen's own one-shot acquire — so it does not describe the radio at all. It
 * describes whether one of those flows has run since the app started. Reinstall
 * the app while already checked in, as somebody does on the day a build ships,
 * and none of them ever runs: the field sits on its initial `'acquiring'` and
 * the light says the phone is looking for satellites for the life of the
 * install.
 *
 * That is the same fault as the trail's own two, one layer up — a screen
 * asserting something it has no evidence for. Here the evidence exists and was
 * simply not being read: every fix the radio produces already passes through
 * `rememberFix`, with its accuracy and its timestamp.
 *
 * PURE, and in `engines/` for the reason every other rule here is: `where.ts`
 * and `trail.ts` both import native modules at module scope, so nothing that
 * lives in them can be exercised without a device — which is how a cadence
 * collapsed to three seconds for three days and how a watchdog window
 * collapsed to twelve.
 *
 * `store.gps` is deliberately LEFT ALONE. The visit screen keys on
 * `'acquiring'` to decide whether to take its own fix, and `saved.tsx` reads it
 * to say whether the record it just wrote carried one — both are asking "have
 * we got a fix for this act", which is a different question from "is the radio
 * working", and collapsing the two would have quietly changed when a visit
 * fetches its position.
 */

export type GpsHealth =
  /** A recent fix, good enough to place somebody on a road. */
  | 'locked'
  /** The radio is allowed to try and has not produced one worth trusting yet. */
  | 'acquiring'
  /** It cannot try: permission refused, or the phone's own switch is off. */
  | 'off';

/**
 * `ageSeconds` and `accuracyM` describe the freshest fix this handset holds, or
 * are null where it holds none. `permitted` is whether the OS will let us ask
 * at all — both the app's permission and the device switch, since a salesman
 * who granted everything and then turned location off produces an identical
 * symptom and a different fix.
 *
 * `freshSeconds` is how recent counts as now, and `thresholdM` how precise
 * counts as trustworthy — the same number the map filters the trail on, so the
 * light cannot call a fix good that the trail would discard.
 *
 * NO FIX IS `acquiring`, NEVER `off`. "Off" is a claim about a switch, and the
 * honest reading of an empty store on a phone that has only just opened is
 * that nothing has come back yet. Saying `off` there would send a salesman to
 * a settings screen where everything is already correct, which is precisely
 * the mistake `handset-health.ts` records about permission notes on the
 * office's side.
 *
 * A STALE FIX IS ALSO `acquiring` rather than `locked`. The light is read to
 * mean "it is working now" — a reading from twenty minutes ago answers a
 * different question, and the trail's own gap line is where an absence belongs.
 */
export function gpsVerdict(args: {
  permitted: boolean;
  ageSeconds: number | null;
  accuracyM: number | null;
  freshSeconds: number;
  thresholdM: number;
}): GpsHealth {
  const { permitted, ageSeconds, accuracyM, freshSeconds, thresholdM } = args;

  if (!permitted) return 'off';
  if (ageSeconds === null || !Number.isFinite(ageSeconds)) return 'acquiring';
  /* A fix stamped in the future is a clock that moved under us. Read as age
     zero it would light the strip green on no evidence; read as stale it says
     "still looking", which is true — the same direction `shouldKeepFix` and
     `trailVerdict` both take on a corrected clock. */
  if (ageSeconds < 0) return 'acquiring';
  if (ageSeconds > Math.max(1, freshSeconds)) return 'acquiring';
  /* Accuracy unknown is not accuracy refused. Most of this app's history
     predates the column travelling with a fix, and every engine here keeps
     missing confidence whole rather than penalising it. */
  if (accuracyM !== null && Number.isFinite(accuracyM) && accuracyM > thresholdM) {
    return 'acquiring';
  }
  return 'locked';
}
