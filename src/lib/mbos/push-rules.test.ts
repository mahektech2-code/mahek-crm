import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CHANNEL,
  channelFor,
  SOUND_CHANNELS_FROM,
  toneOfKind,
  chunk,
  looksLikeExpoPushToken,
  withinQuietHours,
  SEND_CHUNK,
  RECEIPT_CHUNK,
} from "./push-rules";

/* ------------------------------------------------------------ quiet hours */

/**
 * The wrap is the whole difficulty, and getting it wrong fails in the
 * direction nobody notices until somebody's phone goes off at three in the
 * morning — once, to a person who then turns notifications off for good.
 */
test("a window that wraps midnight covers the night, not the day", () => {
  const night = [22, 7];
  assert.equal(withinQuietHours(22, night), true, "ten at night is the first quiet hour");
  assert.equal(withinQuietHours(23, night), true);
  assert.equal(withinQuietHours(0, night), true, "midnight is inside a window that wraps");
  assert.equal(withinQuietHours(3, night), true);
  assert.equal(withinQuietHours(6, night), true, "six is the last quiet hour");

  assert.equal(withinQuietHours(7, night), false, "the end is exclusive — seven is working");
  assert.equal(withinQuietHours(12, night), false);
  assert.equal(withinQuietHours(21, night), false, "nine at night is one hour short");
});

test("a window inside one day behaves like the obvious reading", () => {
  const siesta = [13, 16];
  assert.equal(withinQuietHours(12, siesta), false);
  assert.equal(withinQuietHours(13, siesta), true, "the start is inclusive");
  assert.equal(withinQuietHours(15, siesta), true);
  assert.equal(withinQuietHours(16, siesta), false, "the end is exclusive");
  assert.equal(withinQuietHours(0, siesta), false, "midnight is nowhere near it");
});

test("equal bounds mean NO quiet hours, never all of them", () => {
  /* Read as "always quiet", a mistyped setting would silence the whole
     feature with nothing on any screen saying so — and there is an explicit
     switch for turning push off. */
  for (const hour of [0, 3, 9, 13, 22, 23]) {
    assert.equal(withinQuietHours(hour, [9, 9]), false);
    assert.equal(withinQuietHours(hour, [0, 0]), false);
  }
});

test("a missing or malformed window is not quiet", () => {
  /* Configuration can be absent, and defaulting to quiet would mean a
     deployment that never delivers a push and cannot say why. */
  for (const hour of [0, 9, 23]) {
    assert.equal(withinQuietHours(hour, null), false);
    assert.equal(withinQuietHours(hour, undefined), false);
    assert.equal(withinQuietHours(hour, []), false);
  }
});

/* ---------------------------------------------------------------- batching */

test("batches never exceed Expo's own limits", () => {
  const hundredAndOne = Array.from({ length: 101 }, (_, i) => i);
  const batches = chunk(hundredAndOne, SEND_CHUNK);
  assert.equal(batches.length, 2, "101 messages is two requests, not one refused one");
  assert.equal(batches[0].length, 100);
  assert.equal(batches[1].length, 1);
  assert.ok(batches.every((b) => b.length <= SEND_CHUNK));
});

test("chunking loses nothing and keeps its order", () => {
  const items = Array.from({ length: 250 }, (_, i) => i);
  const flat = chunk(items, 100).flat();
  assert.deepEqual(flat, items, "every message is sent exactly once, in order");
});

test("an exact multiple does not produce a trailing empty batch", () => {
  /* An empty batch would be a POST with no messages — a wasted request that
     Expo answers with an error, on the one path that looks healthy. */
  const batches = chunk(Array.from({ length: 200 }, (_, i) => i), 100);
  assert.equal(batches.length, 2);
  assert.ok(batches.every((b) => b.length > 0));
});

test("nothing to send is no batches at all", () => {
  assert.deepEqual(chunk([], SEND_CHUNK), []);
  assert.deepEqual(chunk([], RECEIPT_CHUNK), []);
});

/* ------------------------------------------------------------------ tokens */

test("only Expo's own token shape is ever sent", () => {
  assert.equal(looksLikeExpoPushToken("ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]"), true);
  assert.equal(looksLikeExpoPushToken("ExpoPushToken[xxxxxxxxxxxxxxxxxxxxxx]"), true);
});

test("a raw FCM token is refused rather than sent", () => {
  /* This is the mistake that matters: a bare device token is what
     `getDevicePushTokenAsync` hands back, and somebody reaching for it
     instead would produce a value that looks plausible, is accepted by the
     column, and fails one message of every batch it appears in. */
  assert.equal(looksLikeExpoPushToken("fcm-token-abc123"), false);
  assert.equal(looksLikeExpoPushToken(""), false);
  assert.equal(looksLikeExpoPushToken("ExponentPushToken[]"), false, "an empty body is not a token");
  assert.equal(looksLikeExpoPushToken("ExponentPushToken"), false);
  assert.equal(
    looksLikeExpoPushToken("prefix ExponentPushToken[abc]"),
    false,
    "anchored — a token with something in front of it is not one",
  );
});

/* ---------------------------------------------------------------- channels */

test("a build without the sounds keeps the channel it has always had", () => {
  for (const appVersion of ["1.15.0 (21) · 449c6734", "1.10.0", null, "", "garbage"]) {
    assert.equal(channelFor({ quiet: false, kind: "warn", appVersion }), CHANNEL.legacy, String(appVersion));
  }
});

test("from the sound build on, a decision and an update sound different", () => {
  const appVersion = `${SOUND_CHANNELS_FROM} (22) · embedded`;
  for (const kind of ["warn", "warning", "danger", "success"]) {
    assert.equal(channelFor({ quiet: false, kind, appVersion }), CHANNEL.decisions, kind);
  }
  for (const kind of ["info", "lead", null, undefined]) {
    assert.equal(channelFor({ quiet: false, kind, appVersion }), CHANNEL.updates, String(kind));
  }
  assert.equal(channelFor({ quiet: false, kind: "info", appVersion: "2.0.0" }), CHANNEL.updates);
});

test("quiet hours silence every build, whatever the message", () => {
  for (const appVersion of ["1.15.0", SOUND_CHANNELS_FROM, "3.1.0"]) {
    assert.equal(channelFor({ quiet: true, kind: "warn", appVersion }), CHANNEL.quiet);
  }
});

test("the banner's tone folds every spelling the server writes", () => {
  assert.equal(toneOfKind("WARNING"), "warn");
  assert.equal(toneOfKind("danger"), "warn");
  assert.equal(toneOfKind("success"), "success");
  assert.equal(toneOfKind("info"), "info");
  assert.equal(toneOfKind(null), "info");
});

/**
 * The handset creates these channels by name and the server sends to them by
 * name, in two projects joined only by a string. A typo on either side does
 * not fail: the push falls back to Expo's generic channel and simply loses its
 * sound and its banner. So the names are pinned against the handset's source.
 */
test("the channel names match the ones the handset creates", () => {
  const handset = readFileSync(join(import.meta.dirname, "..", "..", "..", "mbos-app", "src", "native", "push.ts"), "utf8");
  for (const id of [CHANNEL.decisions, CHANNEL.updates, CHANNEL.quiet, CHANNEL.legacy]) {
    assert.ok(handset.includes(`'${id}'`), `the handset never creates a channel called ${id}`);
  }
});
