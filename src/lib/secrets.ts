import "server-only";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { appSecrets } from "@/db/schema";

/* ---------------------------------------------------------------------------
 * Credentials for outside services.
 *
 * Two places a key can come from, in this order:
 *
 *   1. `app_secrets`, set from the Admin Console. This exists because on a
 *      deploy nobody has shell access to, an environment variable is not a
 *      fallback — it is a door somebody else has to open, and the feature
 *      stays off until they do.
 *
 *   2. The environment, unchanged. Local development sets a variable in
 *      `.env.local` and never opens the console, and a deploy that already
 *      sets one keeps working without anybody migrating anything.
 *
 * The console wins where both exist, because it is the one somebody edited on
 * purpose and can see the effect of.
 *
 * READING A SECRET IS A DELIBERATE ACT. `readSecret` — and `readSecrets`,
 * which is the same act asked about a declared list in one query rather than
 * several — are the only functions that select the value, and it is called from the request that is about to use
 * it — never to populate a screen. Screens call `secretStatus`, which selects
 * the last four characters and the timestamp and nothing else, so a query that
 * grew a `select *` could not start leaking keys onto a page.
 *
 * ONE NAMED EXCEPTION: `olamaps.apiKey` is handed to the browser, by
 * `/sales/live/page.tsx`, because it is the browser that asks Ola Maps for
 * map tiles — a key that never left the server could not load a single
 * street. That is true of every tile provider (Mapbox, Google, Ola), and the
 * usual answer is not secrecy but scope: restrict the key to this
 * deployment's own domain in the provider's own console, so a copy seen in a
 * network tab is not spendable anywhere else. `readSecret` is still the only
 * function that selects it — the exception is what the caller does with the
 * value once read, not a second way of reading it.
 *
 * AND NOW TO THE HANDSET, for the same reason and with one caveat that is
 * NOT the same. MBOS draws the same maps and must ask Ola for the same tiles,
 * so the key reaches it in the sync payload — the same exception, one client
 * further out. What does not carry across is the mitigation: a browser key is
 * restricted to a domain, and there is no domain on a phone. Ola's console
 * offers no package-name or signing-certificate restriction of the kind
 * Google Maps has, so a key in an APK is a key somebody can extract and spend.
 *
 * That is stated rather than hidden because it is a real cost and it is the
 * deployer's to weigh: the honest mitigations are a SEPARATE Ola key for the
 * handset, so a leak is revocable without taking the console's maps down with
 * it, and a spend cap on it. It is sent only to a device that has already
 * authenticated as a bound handset, which is the most this side can do.
 * ------------------------------------------------------------------------- */

/**
 * The credentials MahekOne knows how to hold, and the environment variable
 * each one falls back to. Declared here rather than typed at call sites, so a
 * screen cannot ask for a secret nothing recognises.
 */
export const SECRET_NAMES = {
  "sarvam.apiKey": "SARVAM_API_KEY",
  "openai.apiKey": "OPENAI_API_KEY",
  "msg91.authKey": "MSG91_AUTH_KEY",
  /**
   * WhatsApp's sending key — Wati's v3 API token (a scoped `wati_…` key). It
   * authenticates every template sent from the business number and signs the
   * webhook address Wati reports delivery back to (see `lib/wati.ts`). Holding
   * it does not switch anything on: nothing is sent unless the founder has
   * switched the service on as well.
   */
  "wati.apiToken": "WATI_API_TOKEN",
  /*
   * FIVE OLA ACCOUNTS' KEYS, SPENT IN THIS ORDER, and four of them empty on
   * every deployment that has not needed them.
   *
   * Five NAMED credentials rather than one holding a list, which was the other
   * shape available and is worse in every direction this table already
   * answers. `app_secrets` is keyed on the name and carries `last4` per row,
   * so five rows give a screen five distinguishable keys for nothing; one row
   * holding a list would give one tail for five values, and a manager could
   * not tell which of them he was looking at. Rotating the third would mean
   * reading the whole list back, editing it and writing it again — a
   * read-modify-write on the one value `readSecret` exists to keep nobody
   * reading. And `setSecretAction` / `clearSecretAction` / the console's own
   * credential row all work on these unchanged, so the pool cost no new way
   * of storing or setting a key at all.
   *
   * A deployment holding only `olamaps.apiKey` is byte-for-byte what it was
   * before this existed. Nothing is migrated and nothing behaves differently
   * until somebody sets a second one.
   */
  "olamaps.apiKey": "OLAMAPS_API_KEY",
  "olamaps.apiKey2": "OLAMAPS_API_KEY_2",
  "olamaps.apiKey3": "OLAMAPS_API_KEY_3",
  "olamaps.apiKey4": "OLAMAPS_API_KEY_4",
  "olamaps.apiKey5": "OLAMAPS_API_KEY_5",
  /** What the website's own backend proves it holds when it forwards a submitted enquiry to `/api/public/enquiries`. Server-to-server only — never reaches a browser on either side. */
  "enquiries.ingestSecret": "ENQUIRY_INGEST_SECRET",
} as const;

export type SecretName = keyof typeof SECRET_NAMES;

export const isSecretName = (name: string): name is SecretName =>
  Object.prototype.hasOwnProperty.call(SECRET_NAMES, name);

export type SecretStatus = {
  name: SecretName;
  /** Where the value in force came from — or that there isn't one. */
  source: "console" | "environment" | "unset";
  /** Present only for a console-set key; an environment one is not read here. */
  last4: string | null;
  updatedAt: Date | null;
};

/**
 * The value to authenticate with, or null. The ONE function that selects it.
 *
 * Not cached. A key is read once per dictation — a handful of times a day per
 * telecaller — and a cache would mean a rotated credential kept working for
 * however long the window was, which is the opposite of what rotating is for.
 */
export async function readSecret(name: SecretName): Promise<string | null> {
  const [row] = await db
    .select({ value: appSecrets.value })
    .from(appSecrets)
    .where(eq(appSecrets.name, name))
    .limit(1);
  if (row?.value) return row.value;

  const fromEnv = process.env[SECRET_NAMES[name]];
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : null;
}

/**
 * Several values in ONE query, for a caller that holds a pool.
 *
 * The Ola Maps key is five names now, and asking `readSecret` five times to
 * find out which of them are set would make the single-key deployment — which
 * is the shipping one — pay four extra round trips on the hot path to support
 * a pool it does not have. One `in` costs exactly what one `readSecret`
 * always cost.
 *
 * Absent names are simply absent from the map; the caller decides what a
 * missing credential means, exactly as it does with `readSecret`'s null.
 */
export async function readSecrets(
  names: readonly SecretName[],
): Promise<Map<SecretName, string>> {
  const out = new Map<SecretName, string>();
  if (!names.length) return out;

  const rows = await db
    .select({ name: appSecrets.name, value: appSecrets.value })
    .from(appSecrets)
    .where(inArray(appSecrets.name, names as unknown as string[]));

  const stored = new Map(rows.map((r) => [r.name, r.value]));

  for (const name of names) {
    const fromConsole = stored.get(name);
    if (fromConsole && fromConsole.trim()) {
      out.set(name, fromConsole);
      continue;
    }
    const fromEnv = process.env[SECRET_NAMES[name]];
    if (fromEnv && fromEnv.trim()) out.set(name, fromEnv.trim());
  }

  return out;
}

/** Whether a credential exists at all, without reading it. */
export async function hasSecret(name: SecretName): Promise<boolean> {
  return (await readSecret(name)) !== null;
}

/** What a screen is allowed to know: which are set, from where, and when. */
export async function secretStatuses(): Promise<SecretStatus[]> {
  const rows = await db
    .select({
      name: appSecrets.name,
      last4: appSecrets.last4,
      updatedAt: appSecrets.updatedAt,
    })
    .from(appSecrets);

  const stored = new Map(rows.map((r) => [r.name, r]));

  return (Object.keys(SECRET_NAMES) as SecretName[]).map((name) => {
    const row = stored.get(name);
    if (row) {
      return {
        name,
        source: "console" as const,
        last4: row.last4,
        updatedAt: row.updatedAt,
      };
    }
    const fromEnv = process.env[SECRET_NAMES[name]];
    return {
      name,
      /*
       * An environment key is reported as present but never as four digits:
       * this process can read it, and that is not a reason to put any of it on
       * a screen that a manager's browser will cache.
       */
      source: fromEnv && fromEnv.trim() ? ("environment" as const) : ("unset" as const),
      last4: null,
      updatedAt: null,
    };
  });
}
