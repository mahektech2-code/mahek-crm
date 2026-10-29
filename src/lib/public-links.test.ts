import { test } from "node:test";
import assert from "node:assert/strict";
import { bareHost, isPublicPath, publicRouting } from "./public-links";

test("the public pages are the token links, and nothing else is", () => {
  assert.ok(isPublicPath("/t/W6T6WkVZpfl_cg0cTirqkD4N"));
  assert.ok(isPublicPath("/t/abc/doc/invoice"));
  assert.ok(isPublicPath("/track/abc"));
  assert.ok(isPublicPath("/po/abc"));
  assert.ok(!isPublicPath("/t"));
  assert.ok(!isPublicPath("/erp/transport"));
  assert.ok(!isPublicPath("/tracker"));
  assert.ok(!isPublicPath(null));
});

test("with no public host set, every request passes as before", () => {
  assert.deepEqual(publicRouting("one.mahekindia.com", "/t/abc", null), { kind: "pass" });
  assert.deepEqual(publicRouting("one.mahekindia.com", "/erp", ""), { kind: "pass" });
});

test("the public host serves the links and their assets, and refuses everything else", () => {
  const pub = "track.mahekindia.com";
  assert.deepEqual(publicRouting("track.mahekindia.com", "/t/abc", pub), { kind: "pass" });
  assert.deepEqual(publicRouting("TRACK.mahekindia.com:443", "/po/abc", pub), { kind: "pass" });
  assert.deepEqual(publicRouting("track.mahekindia.com", "/_next/static/chunks/a.js", pub), { kind: "pass" });
  for (const p of ["/", "/login", "/erp/transport", "/api/version", "/api/notifications", "/accounts"]) assert.deepEqual(publicRouting("track.mahekindia.com", p, pub), { kind: "refuse" }, p);
});

test("a public link opened on the staff host is sent to the public host; staff pages stay", () => {
  const pub = "https://track.mahekindia.com/";
  assert.deepEqual(publicRouting("one.mahekindia.com", "/t/abc", pub), { kind: "redirect", to: "https://track.mahekindia.com" });
  assert.deepEqual(publicRouting("one.mahekindia.com", "/erp/transport", pub), { kind: "pass" });
  assert.equal(bareHost(" https://Track.MahekIndia.com/x "), "track.mahekindia.com");
});
