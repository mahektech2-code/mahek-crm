import "server-only";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { appAccess, olaKeyHealth, users } from "@/db/schema";
import { readSecrets, type SecretName } from "@/lib/secrets";
import { getConfig } from "@/lib/config/store";
import { APP_TIMEZONE, calendarDate } from "@/lib/business-date";
import { notifyUsers } from "@/lib/notify";
import {
  chooseOlaKey,
  classifyOlaAnswer,
  olaPoolReport,
  type KeyReport,
  type KeySpend,
} from "@/lib/engines/ola-key-pool";

/* ---------------------------------------------------------------------------
 * THE ONE PLACE AN OLA MAPS KEY IS CHOSEN AND SPENT.
 *
 * MahekOne may hold up to five Ola accounts' keys. It spends the first until
 * Ola refuses it for quota, then the second, and so on — see
 * `engines/ola-key-pool.ts` for why that is failover rather than a spread, and
 * for the rule about a refusal being OBSERVED rather than counted. This file
 * is that engine wired to the database: which keys are held, what is known
 * about each, and the retry that makes a failover invisible to the caller.
 *
 * ONE KEY IS THE SHIPPING CONFIGURATION, AND IT MUST COST WHAT IT ALWAYS DID.
 * `heldKeys` is a single query — the same one `readSecret` was — and where it
 * finds one key there is no health read, no health write, no retry loop and no
 * notification: `olaGet` reads the key, makes the call, and returns, which is
 * exactly what every one of these services did before the pool existed. The
 * pool is insurance. Insurance that made the uninsured case slower would be a
 * cost paid every day against a risk nobody has run yet.
 *
 * NOTHING HERE EVER RETURNS, LOGS OR NOTIFIES A KEY VALUE. The URL a caller
 * builds carries it and that is the end of its travels: a failure message
 * names the credential, a notification names its position in the pool, and the
 * console is shown the last four characters `app_secrets` already holds. There
 * is no path from any of this to the value itself.
 * ------------------------------------------------------------------------- */

/**
 * The pool, in the order it is spent. First is the workhorse; the rest are
 * insurance and are empty on a deployment that has not needed them.
 */
export const OLA_KEY_NAMES = [
  "olamaps.apiKey",
  "olamaps.apiKey2",
  "olamaps.apiKey3",
  "olamaps.apiKey4",
  "olamaps.apiKey5",
] as const satisfies readonly SecretName[];

export type OlaKeyName = (typeof OLA_KEY_NAMES)[number];

const REQUEST_TIMEOUT_MS = 8_000;

/** Which of the five are actually set, in order, with their values. */
async function heldKeys(): Promise<{ name: OlaKeyName; value: string }[]> {
  const values = await readSecrets(OLA_KEY_NAMES);
  return OLA_KEY_NAMES.flatMap((name) => {
    const value = values.get(name);
    return value ? [{ name, value }] : [];
  });
}

/**
 * How many keys are set at all — for a caller that would otherwise ask
 * `olaGet` the same question forty times over.
 *
 * `nearestRoadLegs` loops over as many as forty batches and used to read the
 * key once, before the loop, returning early where there was none. Moving the
 * read inside `olaGet` moved it inside that loop, so a deployment with no key
 * would do forty pointless lookups to make no requests at all. This puts the
 * early return back where it was, for the price of one query on a call that
 * makes dozens of external ones.
 */
export async function olaKeysHeld(): Promise<number> {
  return (await heldKeys()).length;
}

/** `YYYY-MM` in the working timezone — never read off a bare instant. */
function monthNow(now: Date): string {
  return calendarDate(now, APP_TIMEZONE).slice(0, 7);
}

async function spendsFor(names: readonly OlaKeyName[]): Promise<Map<string, KeySpend | null>> {
  const rows = await db
    .select({
      name: olaKeyHealth.name,
      spentAt: olaKeyHealth.spentAt,
      spentMonth: olaKeyHealth.spentMonth,
    })
    .from(olaKeyHealth)
    .where(inArray(olaKeyHealth.name, names as unknown as string[]));

  const out = new Map<string, KeySpend | null>();
  for (const row of rows) {
    /* A row with no refusal on it is a row that says nothing. Both halves have
       to be there for it to mean anything: the instant the cooldown runs from,
       and the month that decides whether the quota has since reset. */
    out.set(
      row.name,
      row.spentAt && row.spentMonth ? { spentAt: row.spentAt, month: row.spentMonth } : null,
    );
  }
  return out;
}

type Chosen = { name: OlaKeyName; value: string };

/**
 * The key to spend now, and the ones behind it, or null if every one held has
 * been refused.
 *
 * Multi-key deployments only. The single-key path never reaches this, because
 * with one key there is nothing to choose between and nothing to read.
 */
async function chooseFrom(
  held: { name: OlaKeyName; value: string }[],
  now: Date,
): Promise<Chosen | null> {
  const [config, spends] = await Promise.all([
    getConfig(),
    spendsFor(held.map((k) => k.name)),
  ]);
  const name = chooseOlaKey(
    held.map((k) => k.name),
    spends,
    now,
    monthNow(now),
    config["maps.olaKeyCooldownHours"],
  );
  if (!name) return null;
  return held.find((k) => k.name === name) ?? null;
}

/**
 * A GET to Ola, made with whichever key is live, retried on the next key where
 * the answer says this account has run out.
 *
 * Returns the parsed body, or null. Null covers every way this fails to help —
 * no key set at all, a network error, a timeout, a non-200, a body that is not
 * JSON, every key in the pool refused — because that is what all three callers
 * already do with every one of those cases: fall back to what they drew
 * before. A trail that is not snapped, a shop that keeps no geocoded pin, a
 * leg whose distance is missing from a plan. None of them is a failure a
 * person has to be shown.
 *
 * The caller hands a function rather than a URL, because the key goes IN the
 * URL and a failover has to be able to build the same request again with a
 * different one.
 */
export async function olaGet<T>(
  buildUrl: (apiKey: string) => string,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<T | null> {
  const held = await heldKeys();
  if (!held.length) return null;

  /* THE SHIPPING PATH. One key: no health read, no retry, nothing to record —
     a spent key here has nowhere to fail over to, so noticing it would cost a
     write and buy nothing. What the screens say when the only key stops
     working is answered by `liveOlaKey`, from the same fact. */
  if (held.length === 1) {
    const answer = await ask<T>(buildUrl(held[0].value), timeoutMs);
    return answer.body;
  }

  const now = new Date();
  let remaining = [...held];

  /* At most one attempt per key held. A failover is a second chance, never a
     loop: a provider having a bad minute must not turn one map request into
     five. */
  for (let attempt = 0; attempt < held.length; attempt++) {
    const chosen = await chooseFrom(remaining, now);
    if (!chosen) return null;

    const answer = await ask<T>(buildUrl(chosen.value), timeoutMs);
    const verdict = classifyOlaAnswer({
      httpStatus: answer.httpStatus,
      bodyStatus: answer.bodyStatus,
      bodyText: answer.bodyText,
    });

    if (verdict !== "exhausted") return answer.body;

    await retire(chosen.name, signalFor(answer), now);
    /* Out of the running for THIS request as well as in the table, so a write
       that raced with another instance cannot make this loop choose it twice. */
    remaining = remaining.filter((k) => k.name !== chosen.name);
    if (!remaining.length) return null;
  }

  return null;
}

type Answer<T> = {
  httpStatus: number;
  bodyStatus: string | null;
  bodyText: string | null;
  body: T | null;
};

/**
 * One request, read once.
 *
 * The body is taken as TEXT and parsed here rather than with `response.json()`
 * because a refusal has to be readable as words — Ola names a quota in a
 * sentence, not in a documented code — and a body can only be consumed once.
 * A 200 that is not JSON is the same as any other failure to the caller.
 */
async function ask<T>(url: string, timeoutMs: number): Promise<Answer<T>> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    /* No answer at all. Zero is what `classifyOlaAnswer` reads as "says
       nothing about the key", which a timeout emphatically does not. */
    return { httpStatus: 0, bodyStatus: null, bodyText: null, body: null };
  }

  let text: string | null = null;
  try {
    text = await response.text();
  } catch {
    text = null;
  }

  let parsed: T | null = null;
  let bodyStatus: string | null = null;
  if (text) {
    try {
      parsed = JSON.parse(text) as T;
      const status = (parsed as { status?: unknown } | null)?.status;
      if (typeof status === "string") bodyStatus = status;
    } catch {
      parsed = null;
    }
  }

  return {
    httpStatus: response.status,
    bodyStatus,
    bodyText: text,
    /* A non-200 has no usable body however well it parsed. */
    body: response.ok ? parsed : null,
  };
}

function signalFor(answer: { httpStatus: number; bodyStatus: string | null }): string {
  if (answer.httpStatus === 429) return "http_429";
  if (answer.httpStatus === 403) return "http_403_quota";
  return "body_quota";
}

/**
 * Writing down that Ola has refused a key, and telling somebody.
 *
 * `spent_at` moves on every refusal, including a retry after the cooldown that
 * was refused again — otherwise the cooldown would expire once and the key
 * would be tried on every call from then on. The NOTIFICATION is keyed on the
 * month instead, so it is sent once when an account runs out and not once a
 * day for the rest of it.
 *
 * It can never fail the request that discovered it. A map line is already
 * falling back to the raw trail by the time this runs; a bell that could not
 * be written must not also take away the failover that was the point.
 */
async function retire(name: OlaKeyName, signal: string, now: Date): Promise<void> {
  const month = monthNow(now);
  try {
    const result = await db.execute<{ prior_month: string | null }>(sql`
      with prior as (select spent_month from ola_key_health where name = ${name})
      insert into ola_key_health (name, spent_at, spent_month, spent_signal, updated_at)
      values (${name}, now(), ${month}, ${signal}, now())
      on conflict (name) do update
        set spent_at = now(),
            spent_month = ${month},
            spent_signal = ${signal},
            updated_at = now()
      returning (select spent_month from prior) as prior_month
    `);
    const [row] = result as unknown as { prior_month: string | null }[];

    /* Already known to be spent this month — the cooldown restarted and that
       is all that happened. */
    if (row?.prior_month === month) return;
  } catch {
    return;
  }

  await announce(name, now).catch(() => {});
}

/**
 * SOMEBODY LEARNS AN ACCOUNT HAS RUN OUT BEFORE ALL FIVE HAVE.
 *
 * A decision nobody receives is not a decision, and this is the one event in
 * the pool that nothing else would ever surface: the maps go on working, the
 * screens say nothing, and the only evidence is a row in a table nobody opens.
 * Five accounts quietly becoming one is a thing to find out about on the day
 * it starts rather than on the day it finishes.
 *
 * It names the POSITION in the pool and how many are left. Never the key,
 * never its tail — a notification is a row in a table and a push payload on a
 * phone, which are two more places for a credential to be than there should
 * be. The last four are on the Maps screen for anybody who needs to tell one
 * key from another.
 */
async function announce(name: OlaKeyName, now: Date): Promise<void> {
  const position = OLA_KEY_NAMES.indexOf(name) + 1;
  const held = await heldKeys();
  const chosen = await chooseFrom(held, now);
  const left = chosen ? held.length - OLA_KEY_NAMES.indexOf(chosen.name) : 0;

  const admins = await db
    .selectDistinct({ id: users.id })
    .from(users)
    .leftJoin(appAccess, and(eq(appAccess.userId, users.id), eq(appAccess.app, "admin")))
    .where(
      and(
        eq(users.active, true),
        or(sql`${users.role} = 'admin'`, sql`${appAccess.id} is not null`),
      ),
    );

  if (!admins.length) return;

  const title = chosen
    ? `Ola Maps key ${position} has run out`
    : "Every Ola Maps key has run out";
  const body = chosen
    ? `Ola refused it for quota, so the maps are now drawing on key ${
        OLA_KEY_NAMES.indexOf(chosen.name) + 1
      } — ${left === 1 ? "the last one held" : `${left} keys are still available`}. It will be tried again after its cooldown, and again from the first of next month. Admin Console → Platform → Maps shows the pool.`
    : "Ola refused the last key held for quota, so the Live map, Territory's shop map and the handset's own map will draw no streets until a key is added or a quota resets. Admin Console → Platform → Maps shows the pool.";

  await notifyUsers(
    admins.map((a) => ({
      userId: a.id,
      title,
      body,
      /* `warn` rather than `warning`: the bell colours `warn` and `danger` and
         draws anything else as ordinary. */
      kind: chosen ? "warn" : "danger",
      href: "/admin/maps",
    })),
  );
}

export type LiveOlaKey = {
  /** The key to hand to a browser or a handset, or null. */
  key: string | null;
  /**
   * Whether the reason there is no key is that every one held has been
   * refused, as opposed to none being set.
   *
   * The two are different sentences on a screen, and drawing them alike is how
   * a manager who has configured everything correctly goes looking for a
   * configuration mistake. False where no key is set at all.
   */
  allSpent: boolean;
};

/**
 * The key a browser or a handset is handed, chosen at the moment the page is
 * rendered or the pull is answered.
 *
 * A BROWSER CANNOT FAIL OVER MID-SESSION and nothing here pretends otherwise.
 * The page already holds the key by the time tiles start being refused, and
 * the tab has no way to tell a spent quota from a flaky connection — so it
 * would be guessing, and a map that swapped its own key on a guess is a map
 * that swaps it on a train journey through a tunnel. What it gets instead is
 * the right key on every LOAD: a reload, a navigation, or the handset's next
 * pull picks up the failover, which for a screen somebody opens a few times a
 * day is the whole of the problem. What it gets when there is nothing left is
 * a sentence saying so, which is the half that matters — grey tiles with no
 * explanation is the failure this codebase refuses everywhere else.
 */
export async function liveOlaKey(): Promise<LiveOlaKey> {
  const held = await heldKeys();
  if (!held.length) return { key: null, allSpent: false };

  /* One key: hand it over exactly as `readSecret` did. There is nothing to
     fail over to, so reading its health would change nothing except the cost
     of every page that draws a map. */
  if (held.length === 1) return { key: held[0].value, allSpent: false };

  const chosen = await chooseFrom(held, new Date());
  return chosen ? { key: chosen.value, allSpent: false } : { key: null, allSpent: true };
}

export type OlaPoolStatus = {
  /** One entry per key HELD, in pool order. Empty where none is set. */
  keys: (KeyReport & { position: number })[];
  /** True only when at least one key is held and none may be spent. */
  allSpent: boolean;
};

/**
 * What the Admin Console's Maps section is shown.
 *
 * A HEALTHY POOL HAS NOTHING TO SAY, which is why this reports what is held
 * rather than what is missing: there is no empty slot, no "four more
 * available", no badge counting down. One key is a deliberate configuration
 * and not an unfinished one, and a screen that nags about it teaches people to
 * read past the line that is there for the day something is actually wrong.
 */
export async function olaPoolStatus(): Promise<OlaPoolStatus> {
  const held = await heldKeys();
  if (held.length <= 1) {
    return {
      keys: held.map((k, i) => ({
        name: k.name,
        position: i + 1,
        state: "live" as const,
        retryAt: null,
        spentAt: null,
      })),
      allSpent: false,
    };
  }

  const now = new Date();
  const [config, spends] = await Promise.all([
    getConfig(),
    spendsFor(held.map((k) => k.name)),
  ]);
  const report = olaPoolReport(
    held.map((k) => k.name),
    spends,
    now,
    monthNow(now),
    config["maps.olaKeyCooldownHours"],
  );

  return {
    keys: report.map((r) => ({ ...r, position: OLA_KEY_NAMES.indexOf(r.name as OlaKeyName) + 1 })),
    allSpent: report.every((r) => r.state === "resting"),
  };
}
