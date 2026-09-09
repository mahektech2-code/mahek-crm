/**
 * The decisions push makes, with nothing plugged in.
 *
 * PURE, and separate from `push.ts` for the reason every engine in this
 * codebase is separate: that file imports the database and `server-only`, so a
 * test of it needs Postgres to answer before it can assert that ten at night
 * is inside a quiet window. These three rules are where the mistakes actually
 * live — a window that does not wrap, a batch one over Expo's limit, a token
 * shape nobody checked — and all three are cheap to pin here.
 */

/** Expo refuses more than 100 messages in one `send`. */
export const SEND_CHUNK = 100;

/** And more than 1,000 ids in one `getReceipts`. */
export const RECEIPT_CHUNK = 1_000;

/**
 * A push token that is not shaped like one is never sent.
 *
 * Expo's own are `ExponentPushToken[...]`. Anything else is a raw FCM or APNs
 * token somebody wired up by mistake, and sending it spends a request to be
 * told so — or worse, spends one message of a batch of a hundred and takes the
 * ninety-nine good ones down with it.
 */
export function looksLikeExpoPushToken(token: string): boolean {
  return /^Expo(nent)?PushToken\[.+\]$/.test(token);
}

/** Fixed-size batches, because Expo's limits are per request. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) return items.length ? [[...items]] : [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Is this hour inside the quiet window?
 *
 * IT WRAPS, which is the whole difficulty. `[22, 7]` is ten at night until
 * seven in the morning, so midnight is inside it and noon is not — and the
 * naive `hour >= from && hour < to` is false for every hour of a window like
 * that, which means quiet hours that silently never apply. The bug would show
 * up as a phone buzzing at three in the morning, once, to somebody who would
 * then turn notifications off for good.
 *
 * EQUAL BOUNDS MEAN NO QUIET HOURS. Reading `[9, 9]` as "always quiet" would
 * make a mistyped setting silence the entire feature with nothing saying so,
 * and there is an explicit switch for turning push off.
 */
export function withinQuietHours(hour: number, window: readonly number[] | null | undefined): boolean {
  const from = window?.[0] ?? 0;
  const to = window?.[1] ?? 0;
  if (from === to) return false;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}
