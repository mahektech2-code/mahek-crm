import { all, one } from '../db';

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

  /* leads */
  'mbos.leads.staleDays': 30,
  'mbos.leads.archiveDays': 90,
  'mbos.leads.escalateAfterDays': 7,

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
