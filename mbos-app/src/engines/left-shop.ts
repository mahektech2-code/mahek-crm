import { haversineMetres, type Coords } from './geo';

/**
 * HE CHECKED IN AND WALKED OUT WITHOUT CHECKING OUT.
 *
 * It happens at the end of a long day more than at any other time: the
 * conversation finishes, he gets back on the bike, and the visit is still
 * running on the phone in his pocket. The trail already knows where he is
 * every few seconds, so the app can notice he has gone and ask, rather than
 * leaving a visit open until the day-boundary sweep closes it hours later at a
 * time that says nothing about how long he was actually there.
 *
 * WHAT IT MEASURES FROM is where he CHECKED IN, and only failing that the
 * shop's pin. The check-in fix is the one the 100 m gate accepted, so it is
 * the best evidence there is of where the visit happened — and for a shop that
 * had no pin, it is the only one.
 *
 * IT ONLY ANSWERS YES WHEN THE READING PROVES IT. The fix's own error is taken
 * off the distance before it is compared, so a 300 m-wide reading that happens
 * to land 550 m out does not count as having left. A fix with no stated
 * accuracy proves nothing and is ignored. Asking somebody who is still at the
 * counter whether he forgot to check out is the one way to make this feature
 * something people learn to swipe away.
 *
 * And it asks ONCE per visit. `alreadyAsked` is the caller's record of that;
 * a reminder repeated every few seconds down the road is a phone people turn
 * notifications off on.
 *
 * Pure — no clock, no store, no radio — so the rule is tested without a phone.
 */

export type LeftShopFacts = {
  /** When he went in. Null means he never checked in, so there is nothing to leave. */
  checkedInAt: number | null;
  /** True once this visit has already been flagged as left. */
  alreadyAsked: boolean;
  /** Where he checked in, or failing that the shop's pin. Null: nothing to measure from. */
  anchor: Coords | null;
  /** The reading being judged. */
  fix: { lat: number; lng: number; accuracyM: number | null; at: number };
  /** `mbos.visit.forgotCheckoutMetres`. */
  thresholdM: number;
};

export type LeftShopVerdict = { left: false } | { left: true; metres: number };

export function leftShopVerdict(f: LeftShopFacts): LeftShopVerdict {
  if (f.checkedInAt == null || f.alreadyAsked || !f.anchor) return { left: false };
  /* A reading older than the check-in is from before he walked in. */
  if (f.fix.at <= f.checkedInAt) return { left: false };
  if (f.fix.accuracyM == null || !Number.isFinite(f.fix.accuracyM)) return { left: false };

  const metres = haversineMetres(f.fix, f.anchor);
  /* The nearest he could really be, given what the reading admits about itself. */
  if (metres - f.fix.accuracyM <= f.thresholdM) return { left: false };
  return { left: true, metres: Math.round(metres) };
}
