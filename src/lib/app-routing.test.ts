import test from "node:test";
import assert from "node:assert/strict";
import { appFor, APP_HEADER } from "@/proxy";
import { APP_IDS } from "@/lib/apps";

/**
 * WHICH APP A REQUEST IS IN, which is now what decides how far somebody sees.
 *
 * `resolveScope` reads the grant for this app rather than `users.role`, so a
 * wrong answer here is a scope resolved against the wrong hat. The mapping is
 * a list of string prefixes, which is exactly the kind of thing that is right
 * until somebody adds a route — so it is pinned rather than trusted.
 */

test("every browser app id is reachable from some URL prefix", () => {
  /* `field` is MBOS's handset. It is `mobileOnly`, it has no browser route at
     all, and the API the handset calls carries its principal on a bearer token
     rather than on a path — so it is the one id that must NOT appear here. */
  const reachable = new Set(
    APP_IDS.filter((id) => id !== "field").map((id) => appFor(`/${id}`)),
  );
  const missing = APP_IDS.filter(
    (id) => id !== "field" && !reachable.has(id),
  );
  assert.deepEqual(missing, [], `no URL prefix resolves to: ${missing.join(", ")}`);
});

test("the handset app is deliberately not routable", () => {
  assert.equal(appFor("/field"), null);
});

test("a prefix matches the app root and everything under it, and nothing else", () => {
  assert.equal(appFor("/crm"), "crm");
  assert.equal(appFor("/crm/queue"), "crm");
  assert.equal(appFor("/crm/customers/cus_1"), "crm");
  /* The trap this guards: `startsWith("/crm")` alone would claim `/crmx`. */
  assert.equal(appFor("/crmx"), null);
  assert.equal(appFor("/crm-export"), null);
});

test("the old orders slug still resolves to accounts", () => {
  /* `orders` was renamed to `accounts` by ALTER TYPE and the URL is kept alive
     by a permanent redirect. The redirect fires after this runs, so the header
     has to be right for the request that is redirected as well — otherwise the
     one hop lands with no app and silently falls back to the derived role. */
  assert.equal(appFor("/orders"), "accounts");
  assert.equal(appFor("/orders/approvals"), "accounts");
});

test("a path belonging to no app resolves to nothing rather than guessing", () => {
  /* Null is a real answer and means "use the account's own role", which is
     what every one of these had before per-app scope existed. */
  for (const path of ["/", "/login", "/apps", "/api/search", "/feedback"]) {
    assert.equal(appFor(path), null, `${path} should not name an app`);
  }
});

test("the header name is stable", () => {
  /* Written by the proxy and read by `requestAppId`. They import the same
     constant; this fails if somebody inlines a literal on one side. */
  assert.equal(APP_HEADER, "x-mahek-app");
});
