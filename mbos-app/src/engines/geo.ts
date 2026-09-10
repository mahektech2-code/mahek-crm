/**
 * Where the phone says it is, and what that is worth.
 *
 * The idea most of this file rests on: **a location is evidence, never a
 * gate.** A salesman standing in a concrete godown in a market lane has no
 * fix at all, and the one he gets outside is forty metres wide. If the app
 * refuses to record his visit because of that, he stops recording visits — and
 * the company loses the whole day's work to protect itself from a handful of
 * doubtful entries. So `assessFix`, `withinGeofence` and `visitLocationVerdict`
 * all answer "how good is this, and what should the manager be told", and none
 * of them answers "may this be saved".
 *
 * **`checkInVerdict` IS THE ONE EXCEPTION, and it is a deliberate reversal.**
 * Mahek asked for the check-in itself to be refused beyond the radius, and the
 * reasoning above is the argument against it rather than a rule that outranks
 * it: a visit logged from a tea shop across the road is a record of work
 * nobody did, and the flag it used to raise was read after the fact by
 * somebody who could no longer tell. What keeps the reversal from costing what
 * the paragraph above warns of is that it refuses ONLY the case it can
 * actually prove, and every other case it lets through:
 *
 *   - no fix, or one too wide to trust — ACCEPTED. A reading that cannot show
 *     he is there cannot show he is not, and refusing on it would block every
 *     check-in inside a godown.
 *   - no pin on the shop — ACCEPTED, and this fix becomes the pin. Roughly
 *     half the book has never been pinned, so refusing here would make half
 *     the book unvisitable to close a gap the salesman did not open.
 *   - measurably outside the radius — REFUSED, and the screen offers a way
 *     past it that costs a typed sentence and tells his manager, because the
 *     stored pin is very often the wrong one.
 *
 * The refusal it returns is therefore a statement about ONE measurement, not
 * a verdict on the salesman, and the sentence it carries says so.
 *
 * Pure on purpose — no `expo-location`, no clock, no store. A fix arrives as an
 * argument, and so does every threshold, so the rules can be tested on a laptop
 * with no device attached.
 */

/**
 * A point on the earth. The only two fields any of this needs.
 *
 * `lat`/`lng` rather than `latitude`/`longitude` because that is what the rest
 * of the handset already speaks — `src/native/location.ts`, the customer rows
 * and the attendance columns all use the short names, and a boundary where the
 * same two numbers change name is a boundary somebody eventually gets the wrong
 * way round.
 */
export type Coords = {
  lat: number;
  lng: number;
};

/**
 * A reading from the handset. `accuracyM` is the radius the OS claims the true
 * position lies within — it is a claim, not a measurement, and it is routinely
 * absent, which is why it is nullable rather than defaulted to something
 * flattering.
 */
export type Fix = Coords & {
  accuracyM: number | null;
  /** Epoch ms the fix was taken. Carried through so a stale fix can be judged. */
  takenAt?: number | null;
};

/**
 * Mean earth radius in metres. A physical constant, not a business threshold —
 * nobody in Nagpur is ever going to want this configurable.
 */
const EARTH_RADIUS_M = 6371008.8;

const toRadians = (deg: number): number => (deg * Math.PI) / 180;

/**
 * Great-circle distance in metres.
 *
 * Haversine rather than anything fancier because the errors it makes (a few
 * metres over a few kilometres, from treating the earth as a sphere) are an
 * order of magnitude smaller than the errors the GPS makes, and pretending
 * otherwise would be precision theatre.
 */
export function haversineMetres(a: Coords, b: Coords): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(lat1) * Math.cos(lat2);

  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Why a fix is not usable, or `null` when it is. */
export type FixReason = 'no_fix' | 'accuracy_unknown' | 'accuracy_poor' | null;

export type FixAssessment = {
  /** True only when there is a fix AND its claimed accuracy is inside the threshold. */
  usable: boolean;
  /** Passed straight back so the caller can record it without re-reading the fix. */
  accuracyM: number | null;
  reason: FixReason;
  /** The sentence shown to the salesman. Never an accusation — a statement. */
  sentence: string;
};

/**
 * Is this fix good enough to draw a conclusion from?
 *
 * A fix worse than the threshold is **not** a valid location. It is recorded
 * anyway, flagged, and the action goes ahead — because the alternative is a
 * salesman standing in a shop watching a spinner, and the shopkeeper watching
 * him. An unknown accuracy is treated exactly like a bad one: the OS declining
 * to say how wrong it might be is not evidence that it is right.
 */
export function assessFix(fix: Fix | null, thresholdM: number): FixAssessment {
  if (!fix) {
    return {
      usable: false,
      accuracyM: null,
      reason: 'no_fix',
      sentence: 'No GPS fix — saved without a location.',
    };
  }
  if (fix.accuracyM == null) {
    return {
      usable: false,
      accuracyM: null,
      reason: 'accuracy_unknown',
      sentence: 'The phone did not say how accurate this fix is — saved and flagged.',
    };
  }
  if (fix.accuracyM > thresholdM) {
    return {
      usable: false,
      accuracyM: fix.accuracyM,
      reason: 'accuracy_poor',
      sentence: `Location accurate to about ${Math.round(fix.accuracyM)} m — too wide to rely on, saved and flagged.`,
    };
  }
  return {
    usable: true,
    accuracyM: fix.accuracyM,
    reason: null,
    sentence: `Location accurate to about ${Math.round(fix.accuracyM)} m.`,
  };
}

export type GeofenceResult = {
  inside: boolean;
  /** Null when there is no fix — a distance of zero would read as "at the shop". */
  metresAway: number | null;
  /** True when the answer is "we do not know", which is not the same as "no". */
  unknown: boolean;
  sentence: string;
};

/**
 * Is the phone inside a circle drawn round a point?
 *
 * Used for the depot boundary on check-in and for the "are you at the shop"
 * question on a visit. With no fix the answer is `inside: false, unknown: true`
 * — and the two flags have to be read together. Collapsing them into one
 * boolean is how "we could not tell" quietly becomes "he was not there", which
 * is a thing a manager acts on and a salesman cannot argue with.
 */
export function withinGeofence(
  fix: Fix | null,
  centre: Coords,
  radiusM: number,
): GeofenceResult {
  if (!fix) {
    return {
      inside: false,
      metresAway: null,
      unknown: true,
      sentence: 'No GPS fix — the location could not be checked.',
    };
  }
  const metresAway = haversineMetres(fix, centre);
  const inside = metresAway <= radiusM;
  return {
    inside,
    metresAway,
    unknown: false,
    sentence: inside
      ? `Inside the boundary · ${Math.round(metresAway)} m from the centre.`
      : `${Math.round(metresAway)} m away — outside the ${Math.round(radiusM)} m boundary.`,
  };
}

export type VisitLocationVerdict = {
  /**
   * True when the fix and the customer's recorded coordinate disagree by more
   * than the allowed distance. It is a flag for a manager, never a refusal.
   */
  mismatch: boolean;
  metresAway: number | null;
  reason: 'ok' | 'no_fix' | 'customer_not_located' | 'too_far';
  sentence: string;
};

/**
 * Does the visit look like it happened where the customer is?
 *
 * Beyond the allowed distance the visit is **flagged**, never blocked, and the
 * reason matters: the stored coordinate is very often the wrong one. Shop
 * addresses in this book were typed by hand, geocoded from a pin somebody
 * dropped in an office, or inherited from a spreadsheet. A salesman genuinely
 * standing in the shop, refused because the database has the wrong lat/long,
 * learns within a week that the honest thing to do is stop pressing the button.
 * So the disagreement is recorded as a disagreement — one of the two is wrong
 * and this function does not claim to know which.
 *
 * A customer with no coordinate at all is not a mismatch. There is nothing to
 * disagree with.
 */
export function visitLocationVerdict(
  fix: Fix | null,
  customerCoords: Coords | null,
  maxMetres: number,
): VisitLocationVerdict {
  if (!fix) {
    return {
      mismatch: false,
      metresAway: null,
      reason: 'no_fix',
      sentence: 'No GPS fix — the visit is saved with no location against it.',
    };
  }
  if (!customerCoords) {
    return {
      mismatch: false,
      metresAway: null,
      reason: 'customer_not_located',
      sentence: 'This shop has no recorded location yet — nothing to compare against.',
    };
  }
  const metresAway = haversineMetres(fix, customerCoords);
  if (metresAway > maxMetres) {
    return {
      mismatch: true,
      metresAway,
      reason: 'too_far',
      sentence: `${Math.round(metresAway)} m from the recorded address — saved, and sent to your manager to confirm.`,
    };
  }
  return {
    mismatch: false,
    metresAway,
    reason: 'ok',
    sentence: `At the shop · ${Math.round(metresAway)} m from the recorded address.`,
  };
}

/**
 * Why a check-in was accepted, or why it was not.
 *
 * `unmeasurable` and `unpinned` both accept, and they are kept apart because
 * they are different facts about the same shop: one says the phone could not
 * tell, the other says the book has never been told. A manager reading them
 * back acts on the second and cannot act on the first.
 */
export type CheckInReason = 'ok' | 'unpinned' | 'unmeasurable' | 'too_far';

export type CheckInVerdict = {
  /** Whether the check-in may go ahead. The one gate in this file. */
  accepted: boolean;
  reason: CheckInReason;
  /** Null wherever nothing could be measured — never 0, which reads as "at the door". */
  metresAway: number | null;
  /**
   * True where this fix should become the shop's pin: the shop has none, and
   * the fix is good enough to be one. A poor fix never pins a shop — it would
   * put the pin four hundred metres out and refuse every honest check-in
   * afterwards, which is the failure this whole rule exists to avoid, arriving
   * by the back door.
   */
  pinsTheShop: boolean;
  /** What the salesman is shown. A statement about a measurement, never about him. */
  sentence: string;
};

/**
 * May this check-in go ahead?
 *
 * The ladder is ordered so that the only REFUSAL is the one case the reading
 * actually proves, and the order of the first two rungs is load-bearing rather
 * than incidental: the fix is judged BEFORE the shop's pin is looked for, so a
 * shop with no pin is never pinned from a fix too wide to trust. Reversed, the
 * first check-in on a bad afternoon would drop the pin four hundred metres
 * away and every honest visit after it would be refused against it.
 *
 * `radiusM` is `mbos.location.visitMismatchM` — the same number the save-time
 * verdict and the manager's screen read, because the distance a check-in is
 * refused at and the distance a saved visit is flagged at are one fact. Two
 * settings would be two places for it to be changed and one place for it to
 * be forgotten.
 */
export function checkInVerdict(
  fix: Fix | null,
  customerCoords: Coords | null,
  radiusM: number,
  accuracyThresholdM: number,
): CheckInVerdict {
  const assessment = assessFix(fix, accuracyThresholdM);
  if (!assessment.usable || !fix) {
    return {
      accepted: true,
      reason: 'unmeasurable',
      metresAway: null,
      pinsTheShop: false,
      sentence:
        assessment.reason === 'no_fix'
          ? 'No GPS fix — checked in without one, and your manager sees that.'
          : `The phone can only place you to about ${assessment.accuracyM == null ? 'an unknown' : Math.round(assessment.accuracyM) + ' m'} — too wide to check against the shop, so the check-in stands and is flagged.`,
    };
  }

  if (!customerCoords) {
    return {
      accepted: true,
      reason: 'unpinned',
      metresAway: null,
      pinsTheShop: true,
      sentence: 'This shop has no recorded location yet — checking in here is what pins it.',
    };
  }

  const metresAway = haversineMetres(fix, customerCoords);
  if (metresAway > radiusM) {
    return {
      accepted: false,
      reason: 'too_far',
      metresAway,
      pinsTheShop: false,
      sentence: `You are ${Math.round(metresAway)} m from this shop's recorded location. A check-in has to be made within ${Math.round(radiusM)} m of it.`,
    };
  }

  return {
    accepted: true,
    reason: 'ok',
    metresAway,
    pinsTheShop: false,
    sentence: `At the shop · ${Math.round(metresAway)} m from its recorded location.`,
  };
}
