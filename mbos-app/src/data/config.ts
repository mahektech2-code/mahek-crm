import { all, one } from '../db';
import {
  LOST_REASONS,
  OVERRIDE_REASONS,
  PROSPECT_REASONS,
  SAMPLE_REASONS,
} from '../engines/funnel/lead-labels';

/**
 * Configuration, read from the local cache of what MahekOne's Admin Console
 * holds.
 *
 * The rule from the brief is absolute: **every business threshold reads from
 * configuration**, and nothing is configured inside this app. A number a
 * manager might one day want to change belongs in the Admin Console, arrives
 * on a pull, and is read through here.
 *
 * The defaults below are NOT policy. They are what the app uses on a handset
 * that has never completed a bootstrap — a salesman signing in for the first
 * time on a bad connection still has to be able to work. Every one of them is
 * replaced the moment real configuration arrives.
 */

const DEFAULTS: Record<string, unknown> = {
  /* location and journey */
  'mbos.attendance.geofenceRadiusM': 200,
  /* Where that radius is drawn around. Null until the office says — with no
     base there is nothing to be outside of, and a check-in is never refused
     for want of one. */
  'mbos.attendance.baseLocation': null,
  'mbos.location.gpsAccuracyThresholdM': 100,
  'mbos.location.visitMismatchM': 150,
  'mbos.location.routeDeviationM': 2000,
  'mbos.location.unplannedVisitsPerDay': 3,
  /* Following the route while the day is open. The office decides; this is
     what a handset does before it has ever heard from the office. */
  'mbos.location.trackWhileWorking': true,
  'mbos.location.trackEverySeconds': 3,
  /* The floor on what is KEPT, as opposed to what is asked for above. It was
     read here and published nowhere for the life of the module, so every
     handset in the field has run the trail at this compiled five whatever the
     office wanted — the silent fallback `getConfig` is built to make safe, and
     invisible precisely because the number it fell back to was the number
     everybody assumed was in force. */
  'mbos.location.trackEveryMinutes': 5,
  /* How long the OS may claim to be tracking while delivering nothing before
     the handset stops believing it — in multiples of its own cadence. See
     `engines/trail-watchdog.ts`; the number matches the registry's default,
     because a handset on the floor for want of a bootstrap must behave as the
     office would have told it to. */
  'mbos.location.trailStalledAfterMisses': 4,

  /* maps kept for no signal — see `engines/tiles.ts` for what each one costs */
  'mbos.maps.offlineEnabled': true,
  'mbos.maps.minZoom': 9,
  'mbos.maps.maxZoom': 16,
  'mbos.maps.areaSeparationKm': 25,
  'mbos.maps.paddingMetres': 2000,
  'mbos.maps.bytesPerTileEstimate': 45_000,
  'mbos.maps.maxPackMegabytes': 500,
  'mbos.maps.tileCountLimit': 250_000,
  'mbos.maps.downloadOnWifiOnly': true,
  'mbos.maps.refreshAfterDays': 120,

  /* visits */
  'mbos.visits.minimumDwellSeconds': 120,

  /* route optimisation — the honest average speed differs by a factor of three
     between a city beat on a two-wheeler and a district tour in a car, which
     is exactly why the engine takes it as an argument */
  'mbos.route.averageSpeedKmph': 22,
  'mbos.route.maxTwoOptPasses': 4,
  'mbos.route.maxStopsForTwoOpt': 40,
  'mbos.route.minutesPerStop': 20,

  /* orders and credit */
  'mbos.orders.approvalThresholdPaise': 20_000_000,
  'mbos.orders.secondTierThresholdPaise': 50_000_000,
  'mbos.credit.overdueDaysBlockOrders': 90,

  /* payments */
  'mbos.payments.cashDepositSlaHours': 36,
  'mbos.payments.managerNotifyThresholdPaise': 5_000_000,

  /* expenses */
  'mbos.expenses.billPhotoThresholdPaise': 0,
  'mbos.expenses.backdatedDaysAllowed': 30,
  'mbos.expenses.maxClaimAgeDays': 30,
  /* The categories a claim can be filed under, and the monthly ceiling on
     each. A handset that has never bootstrapped still has to be able to record
     what was spent this morning; real configuration replaces this wholesale,
     category names included. */
  'mbos.expenses.categoryCapsPaise': {
    Fuel: 600_000,
    Hospitality: 300_000,
    Parking: 80_000,
    Other: 200_000,
  },

  /* attendance and leave */
  'mbos.attendance.halfDayHours': 4,
  'mbos.attendance.fullDayHours': 8,
  /*
   * `mbos.attendance.selfieRetentionHours` is DELIBERATELY ABSENT, and it is
   * the one key here that should stay absent.
   *
   * Every default above is a number the app falls back to so a salesman on a
   * handset that has never bootstrapped can still work. That reasoning does
   * not carry to this one: it is not used to decide anything, it is PRINTED —
   * the selfie camera tells the person being photographed how long his own
   * face is kept. A default would make the screen promise 72 hours on a phone
   * that has never heard from an office which may have set 24, and a wrong
   * promise about that is worse than no promise. Absent, the sentence is left
   * out until the real figure arrives, which is one sync away.
   */

  /* health — the two thresholds the pill colours by, and the two words it
     must not confuse. `atRiskBelow` is a SCORE threshold and says a customer
     is worth a look; "at risk" itself is the retention BAND, which the server
     computes from the customer's own cycles and sends on the wire. Two
     settings using one phrase for two questions is what B3-16 was raised
     about. */
  'mbos.health.atRiskBelow': 40,
  'mbos.health.strongAtOrAbove': 70,

  /* health score — weights, normalised at use */
  'mbos.health.componentWeights': {
    orderRecency: 25,
    orderConsistency: 10,
    valueTrend: 15,
    paymentBehaviour: 20,
    outstandingPressure: 15,
    visitCoverage: 10,
    openIssues: 5,
  },

  /* sync */
  'mbos.sync.imageMaxDimensionPx': 1600,
  'mbos.sync.imageQualityPercent': 70,
  'mbos.sync.mediaWifiOnly': false,
  'mbos.sync.offlineLoginValidityDays': 7,

  /* ai */
  'mbos.ai.retainAudioAfterTranscription': false,
  /*
   * NO MICROPHONE UNTIL THE OFFICE SAYS THERE IS ONE.
   *
   * Unlike every other default here, this one is not "what the app uses before
   * real configuration arrives" so much as the only honest answer to a
   * question the handset cannot settle by itself. Whether dictation works
   * depends on a provider key that lives on the server and never comes down
   * this wire, so a handset that has never completed a bootstrap has no way to
   * know — and drawing the mic on a guess is drawing a button that fails when
   * pressed, which is the one thing this feature is not allowed to do.
   */
  'mbos.ai.dictation': { available: false },

  /* leads */
  'mbos.leads.staleDays': 30,
  'mbos.leads.archiveDays': 90,
  'mbos.leads.escalateAfterDays': 7,

  /*
   * The funnel's own thresholds and its four coded lists.
   *
   * These are `leads.*` rather than `mbos.leads.*` because they are the SAME
   * settings the CRM, the console and the server action read — a suspect
   * window of three on a phone and two in the office would be two rules
   * wearing one name, and the salesman would be the one who found out.
   *
   * TODO(integration): `mbosConfigPayload()` in
   * `src/lib/services/mbos-service.ts` sends every `mbos.*` key and
   * `products.priceSource`, so none of these reaches a handset yet — the
   * defaults below are what the app runs on until workstream A widens it to
   * carry the `leads.*` keys too. They are copied from
   * `lib/config/registry.ts`, which takes its own from the same
   * `lead-labels.ts` this app compiles, so the words on the screen are right
   * even while the numbers are only defaults.
   */
  'leads.suspectMaxVisits': 3,
  'leads.requireNextAction': true,
  'leads.allowManagerOverride': true,
  'leads.prospectReasons': PROSPECT_REASONS.map((r) => ({ ...r })),
  'leads.sampleReasons': SAMPLE_REASONS.map((r) => ({ ...r })),
  'leads.lostReasons': LOST_REASONS.map((r) => ({ ...r })),
  'leads.overrideReasons': OVERRIDE_REASONS.map((r) => ({ ...r })),
  'leads.sampleReviewChaseDays': [2, 4, 6],
  'leads.verificationDueDays': 2,

  /* tasks */
  'mbos.tasks.escalationHours': 24,

  /* products — inherited from MahekOne, not an MBOS decision */
  'products.priceSource': 'unset',
};

/**
 * A single setting.
 *
 * Reads go through here rather than through the table directly, so a key that
 * has not arrived yet falls back rather than reading as `undefined` halfway
 * down an arithmetic expression.
 */
export async function getConfig<T>(key: string, fallback?: T): Promise<T> {
  const row = await one<{ value: string }>('SELECT value FROM config WHERE key = ?', [key]);
  if (row) {
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return row.value as unknown as T;
    }
  }
  if (key in DEFAULTS) return DEFAULTS[key] as T;
  return fallback as T;
}

/** Everything at once, for the screens that need several thresholds to render. */
export async function getAllConfig(): Promise<Record<string, unknown>> {
  const rows = await all<{ key: string; value: string }>('SELECT key, value FROM config');
  const out: Record<string, unknown> = { ...DEFAULTS };
  for (const r of rows) {
    try {
      out[r.key] = JSON.parse(r.value);
    } catch {
      out[r.key] = r.value;
    }
  }
  return out;
}

/**
 * When the configuration this handset is working from was last refreshed.
 *
 * Shown wherever a decision hangs on a cached figure. A credit limit read from
 * a four-hour-old cache and one read a minute ago are different things to bet
 * an order on, and the salesman is entitled to know which he has.
 */
export async function configAge(): Promise<number | null> {
  const row = await one<{ at: number }>('SELECT MAX(lastSyncedAt) AS at FROM config');
  return row?.at || null;
}
