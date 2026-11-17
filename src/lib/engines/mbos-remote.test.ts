import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  bucketOf,
  compareVersions,
  inAudience,
  parseVersion,
  REMOTE_KEY_PATTERN,
  resolveRemote,
  validateRemoteItem,
  type RemoteItem,
  type Who,
} from "./mbos-remote";

const who: Who = { userId: "u1", role: "associate", appVersion: "1.26.0 (36) · f7f48848" };
const item = (over: Partial<RemoteItem>): RemoteItem => ({
  key: "feature.lead-scan",
  kind: "flag",
  value: true,
  audience: {},
  enabled: true,
  version: 1,
  ...over,
});

/* ------------------------------------------------------- the location fence */

test("no key can name a configuration setting, least of all a location one", () => {
  for (const key of [
    "mbos.location.trackEverySeconds",
    "mbos.location.trailKeepEverySeconds",
    "mbos.sync.currentAppVersion",
    "leads.suspectMaxVisits",
  ]) {
    assert.ok(validateRemoteItem({ key, kind: "flag", value: false, audience: {} }).length, key);
  }
});

test("no key may speak of location or tracking, whatever its prefix", () => {
  for (const key of [
    "feature.tracking",
    "feature.location-upload",
    "feature.trail",
    "menu.tracking-setup.hidden",
    "text.home.punch-in",
    "feature.gps-check",
    "banner.geofence-help",
  ]) {
    assert.ok(validateRemoteItem({ key, kind: key.startsWith("text") ? "text" : key.startsWith("banner") ? "banner" : "flag", value: true, audience: {} }).length, key);
  }
});

test("the screens that keep the day running cannot be hidden", () => {
  for (const route of ["home", "attendance", "travel", "phone-setup", "setup", "sync", "maps", "visit"]) {
    assert.ok(validateRemoteItem({ key: `menu.${route}.hidden`, kind: "flag", value: true, audience: {} }).length, route);
  }
  assert.deepEqual(validateRemoteItem({ key: "menu.salary.hidden", kind: "flag", value: true, audience: {} }), []);
});

test("the database refuses the same keys the engine does", () => {
  const sqlText = readFileSync(join(process.cwd(), "drizzle/0346_mbos_remote.sql"), "utf8");
  const ns = /"key" ~ '([^']+)'/.exec(sqlText)?.[1];
  const loc = /"key" !~ '([^']+)'/.exec(sqlText)?.[1];
  assert.ok(ns && loc, "both CHECKs present");
  assert.equal(new RegExp(ns!).source, REMOTE_KEY_PATTERN.source);
  for (const k of ["feature.tracking", "text.trail-help", "banner.punch"]) assert.ok(new RegExp(loc!).test(k));
});

/* The handset half of the fence: the trail and the remote-control code never
   import each other, so nothing here can be on the path a fix travels. */
const HANDSET = join(process.cwd(), "mbos-app");
const TRAIL_FILES = [
  "src/sync/trail.ts",
  "src/sync/background-sync-task.ts",
  "src/native/location-service.ts",
  "src/native/location.ts",
  "src/native/keepalive.ts",
  "src/engines/capture.ts",
  "src/engines/trail-watchdog.ts",
  "modules/location-service/index.ts",
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) ? [p] : [];
  });
}

test("no trail file imports the remote-control code", () => {
  for (const f of TRAIL_FILES) {
    const text = readFileSync(join(HANDSET, f), "utf8");
    assert.doesNotMatch(text, /(from|import\()\s*['"][^'"]*(data\/remote|components\/remote)/, f);
  }
});

test("the remote-control code imports nothing on the trail's path", () => {
  const files = [join(HANDSET, "src/data/remote.ts"), ...walk(join(HANDSET, "src/components/remote"))];
  const banned = /from ['"][^'"]*(sync\/trail|background-sync-task|native\/location|location-service|keepalive|engines\/capture|trail-watchdog|native\/permissions)['"]/;
  for (const f of files) assert.doesNotMatch(readFileSync(f, "utf8"), banned, f);
});

test("the pull applies remote items in their own channel, never through config", () => {
  const pull = readFileSync(join(HANDSET, "src/sync/pull.ts"), "utf8");
  assert.match(pull, /c\('remote', \(\) => storeRemote\(pull\.remote\)\)/);
  assert.doesNotMatch(pull, /upsertConfig\(pull\.remote/);
});

/* ---------------------------------------------------------------- audience */

test("a build label reads as its version", () => {
  assert.deepEqual(parseVersion("1.26.0 (36) · f7f48848"), [1, 26, 0]);
  assert.equal(parseVersion("unknown"), null);
  assert.ok(compareVersions("1.26.0", "1.9.9") > 0);
});

test("a percentage is the same people every time, and about that many", () => {
  assert.equal(bucketOf("u1", "feature.x"), bucketOf("u1", "feature.x"));
  let inside = 0;
  for (let i = 0; i < 2000; i++) if (inAudience({ percent: 10 }, "feature.x", { ...who, userId: `u${i}` })) inside++;
  assert.ok(inside > 120 && inside < 280, String(inside));
});

test("a build range leaves out a phone that never said its build", () => {
  assert.equal(inAudience({ minVersion: "1.20.0" }, "k", who), true);
  assert.equal(inAudience({ minVersion: "1.27.0" }, "k", who), false);
  assert.equal(inAudience({ minVersion: "1.20.0" }, "k", { ...who, appVersion: null }), false);
});

test("roles and people narrow", () => {
  assert.equal(inAudience({ roles: ["manager"] }, "k", who), false);
  assert.equal(inAudience({ userIds: ["u2"] }, "k", who), false);
  assert.equal(inAudience({ userIds: ["u1"], roles: ["associate"] }, "k", who), true);
});

/* ----------------------------------------------------------------- resolve */

test("switched off, out of audience or invalid means absent — the handset's own default", () => {
  const out = resolveRemote(
    [
      item({ key: "feature.a", value: false }),
      item({ key: "feature.b", enabled: false }),
      item({ key: "feature.c", audience: { roles: ["manager"] } }),
      item({ key: "feature.tracking", value: false }),
      item({ key: "text.home.greeting", kind: "text", value: "Namaste" }),
    ],
    who,
    0,
  );
  assert.deepEqual(out.flags, { "feature.a": false });
  assert.deepEqual(out.texts, { "text.home.greeting": "Namaste" });
});

test("banners keep their window and their order", () => {
  const now = Date.parse("2026-11-17T06:00:00Z");
  const b = (key: string, v: object) => item({ key, kind: "banner", value: { screen: "home", title: key, ...v } });
  const out = resolveRemote(
    [
      b("banner.later", { startsAt: "2026-12-01T00:00:00Z" }),
      b("banner.over", { endsAt: "2026-11-01T00:00:00Z" }),
      b("banner.second", { order: 2 }),
      b("banner.first", { order: 1 }),
    ],
    who,
    now,
  );
  assert.deepEqual(out.banners.map((x) => x.id), ["banner.first", "banner.second"]);
});

test("the version moves when an item moves, and only then", () => {
  const a = resolveRemote([item({})], who, 0).version;
  assert.equal(resolveRemote([item({})], who, 0).version, a);
  assert.notEqual(resolveRemote([item({ version: 2 })], who, 0).version, a);
});

test("a banner link must be https and a route must look like one", () => {
  const v = (value: object) => validateRemoteItem({ key: "banner.x", kind: "banner", value: { screen: "home", title: "T", ...value }, audience: {} });
  assert.deepEqual(v({ route: "catalogue" }), []);
  assert.ok(v({ url: "http://x.com" }).length);
  assert.ok(v({ route: "../etc" }).length);
  assert.ok(v({ route: "leads", url: "https://x.com" }).length);
});
