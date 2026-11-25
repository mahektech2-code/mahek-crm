import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/* ---------------------------------------------------------------------------
 * THE KAPSO KEYS HAVE A PLACE TO BE ENTERED.
 *
 * Both were credentials the server could hold and read — the Studio's WhatsApp
 * Inbox asked for them — while the Integrations page drew no row for either, so
 * the Inbox told people to "add the key in Admin Console → Integrations" where
 * there was nothing to add. The Integrations page draws each credential by
 * hand, so nothing else notices a held name with no row. This reads the page
 * and fails on one.
 * ------------------------------------------------------------------------- */

/* Read as text: `secrets.ts` opens the database on import, and this runs in the
   suite that needs none. */
const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");
const page = read("src/app/admin/integrations/page.tsx");
const secrets = read("src/lib/secrets.ts");
const ENV = { "kapso.apiKey": "KAPSO_API_KEY", "kapso.webhookSecret": "KAPSO_WEBHOOK_SECRET" } as const;

describe("Admin Console → Integrations draws a row for each Kapso credential", () => {
  for (const name of ["kapso.apiKey", "kapso.webhookSecret"] as const) {
    test(`${name} is a stored credential and has its own SecretCredentialRow`, () => {
      assert.match(secrets, new RegExp(`"${name.replace(".", "\.")}": "${ENV[name]}"`), `${name} must be a credential MahekOne can hold`);
      assert.match(page, new RegExp(`s\.name === "${name.replace(".", "\.")}"`), `no row filters on ${name}`);
    });
  }

  test("each row names the environment variable it falls back to", () => {
    for (const env of Object.values(ENV)) assert.match(page, new RegExp(`env: "${env}"`));
  });

  test("the section is titled for the Inbox, and no key value is ever written into the page", () => {
    assert.match(page, /title="WhatsApp Inbox \(Kapso\)"/);
    assert.doesNotMatch(page, /kapso_[a-z0-9]{12,}/i);
  });
});
