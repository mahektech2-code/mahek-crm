import "server-only";
import { eq } from "drizzle-orm";
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
 * READING A SECRET IS A DELIBERATE ACT. `readSecret` is the only function that
 * selects the value, and it is called from the request that is about to use
 * it — never to populate a screen. Screens call `secretStatus`, which selects
 * the last four characters and the timestamp and nothing else, so a query that
 * grew a `select *` could not start leaking keys onto a page.
 * ------------------------------------------------------------------------- */

/**
 * The credentials MahekOne knows how to hold, and the environment variable
 * each one falls back to. Declared here rather than typed at call sites, so a
 * screen cannot ask for a secret nothing recognises.
 */
export const SECRET_NAMES = {
  "sarvam.apiKey": "SARVAM_API_KEY",
  "openai.apiKey": "OPENAI_API_KEY",
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
