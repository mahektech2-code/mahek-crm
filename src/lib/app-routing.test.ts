import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { appFor, appForApi, APP_HEADER, CRM_SALES_MANAGER_WORKSPACE, proxy, WORKSPACE_HEADER, workspaceFor } from "@/proxy";
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

test("the Sales Manager lead pipeline resolves as the Sales Dashboard, and /sales does not swallow it", () => {
  /* `/sales-lead-pipeline` starts with `/sales` but is not under it. The prefix
     rule is what keeps `/salesx` from claiming `/sales`, and this route is the
     one place a separate prefix is needed to reach the same app. */
  assert.equal(appFor("/sales-lead-pipeline"), "sales");
  assert.equal(appFor("/sales-lead-pipeline/list"), "sales");
  assert.equal(appFor("/sales-lead-pipeline/cus_123"), "sales");
  assert.equal(appFor("/sales-lead-pipelinex"), null);
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

/* --------------------------------------------------- the CRM Sales Manager workspace */

test("only /crm/leads/sales-manager names the CRM Sales Manager workspace", () => {
  /* The workspace header narrows SCOPE, so the same trap as the app prefix
     applies: a route that merely starts with the same letters must not claim it,
     and the rest of the CRM's lead screens must not be swept in. */
  assert.equal(workspaceFor("/crm/leads/sales-manager"), CRM_SALES_MANAGER_WORKSPACE);
  assert.equal(workspaceFor("/crm/leads/sales-manager/list"), CRM_SALES_MANAGER_WORKSPACE);
  assert.equal(workspaceFor("/crm/leads/sales-manager/cus_123"), CRM_SALES_MANAGER_WORKSPACE);
  assert.equal(workspaceFor("/crm/leads/sales-managerx"), null);
  for (const path of ["/crm/leads", "/crm/leads/intake", "/crm/leads/cus_1", "/sales-lead-pipeline", "/sales/leads", "/"]) {
    assert.equal(workspaceFor(path), null, `${path} must not be the CRM Sales Manager workspace`);
  }
  /* And it is still the CRM app, so the CRM hat is what resolves. */
  assert.equal(appFor("/crm/leads/sales-manager/list"), "crm");
});

test("the workspace header is written by the proxy alone, and a client-supplied one is stripped", () => {
  assert.equal(WORKSPACE_HEADER, "x-mahek-workspace");
  const forged = { [WORKSPACE_HEADER]: CRM_SALES_MANAGER_WORKSPACE };

  /* On a route that is NOT the workspace, a forged header is deleted. */
  const elsewhere = proxy(new NextRequest("http://localhost/crm/leads", { headers: forged }));
  assert.equal(elsewhere.headers.get(`x-middleware-request-${WORKSPACE_HEADER}`), null);

  /* On the workspace the proxy writes it itself. */
  const inside = proxy(new NextRequest("http://localhost/crm/leads/sales-manager/list"));
  assert.equal(inside.headers.get(`x-middleware-request-${WORKSPACE_HEADER}`), CRM_SALES_MANAGER_WORKSPACE);
});

/*
 * A SHARED API ROUTE NAMES NO APP OF ITS OWN, so the page that called it does.
 * Only a same-origin referrer is believed, only under /api/, and anything the
 * proxy cannot read names nothing — which is the old fallback, not a guess.
 */
test("an API call is in the app of the same-host page that made it", () => {
  const origin = "https://one.mahekindia.com";
  const host = "one.mahekindia.com";
  assert.equal(appForApi("/api/search", `${origin}/crm/customers?q=a`, host), "crm");
  assert.equal(appForApi("/api/payments/open-bills", `${origin}/accounts/payments`, host), "accounts");
  assert.equal(appForApi("/api/search", `${origin}/apps`, host), null);
});

test("a cross-host, missing or malformed referrer names no app", () => {
  const host = "one.mahekindia.com";
  assert.equal(appForApi("/api/search", "https://evil.example/crm", host), null);
  /* Behind Caddy the app sees http while the browser says https: same host, same app. */
  assert.equal(appForApi("/api/search", "http://one.mahekindia.com/crm", host), "crm");
  assert.equal(appForApi("/api/search", "https://one.mahekindia.com/crm", null), null);
  assert.equal(appForApi("/api/search", null, host), null);
  assert.equal(appForApi("/api/search", "not a url", host), null);
});

test("the referrer is read only for API routes", () => {
  const origin = "https://one.mahekindia.com";
  const host = "one.mahekindia.com";
  assert.equal(appForApi("/crm/customers", `${origin}/accounts`, host), null);
  assert.equal(appForApi("/apps", `${origin}/crm`, host), null);
});

test("the proxy writes the referrer's app on an API request, and still strips a forged header", () => {
  const res = proxy(
    new NextRequest("http://localhost/api/search?q=x", {
      headers: { referer: "http://localhost/crm/call-log", [APP_HEADER]: "admin" },
    }),
  );
  assert.equal(res.headers.get(`x-middleware-request-${APP_HEADER}`), "crm");

  const foreign = proxy(
    new NextRequest("http://localhost/api/search?q=x", {
      headers: { referer: "http://elsewhere.test/crm", [APP_HEADER]: "admin" },
    }),
  );
  assert.equal(foreign.headers.get(`x-middleware-request-${APP_HEADER}`), null);
});
