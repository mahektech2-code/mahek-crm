import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ageWords, handsetNotes, type HandsetFacts } from "@/lib/handset-health";

const NOW = new Date("2026-09-11T09:00:00+05:30").getTime();
const T = { quietMinutes: 30, lowBatteryPercent: 20 };

const facts = (over: Partial<HandsetFacts> = {}): HandsetFacts => ({
  locationPermission: "always",
  backgroundTrackingGranted: true,
  locationServicesEnabled: true,
  connectionType: "wifi",
  batteryPercent: null,
  batteryCharging: null,
  deviceStateAt: null,
  lastHeardAt: new Date(NOW - 60_000),
  dayOpen: true,
  ...over,
});

const texts = (f: HandsetFacts) => handsetNotes(f, T, NOW).map((n) => n.text);

describe("a handset with nothing wrong says nothing", () => {
  test("draws no notes at all", () => {
    assert.deepEqual(handsetNotes(facts(), T, NOW), []);
  });

  test("says nothing on a closed day either, however long the silence", () => {
    /* A phone in a drawer overnight is not a fault. Flagging it would put a
       warning on every row every morning, which teaches people to ignore the
       warnings that matter. */
    const quiet = facts({ dayOpen: false, lastHeardAt: new Date(NOW - 40 * 3_600_000) });
    assert.deepEqual(handsetNotes(quiet, T, NOW), []);
  });
});

describe("null is never read as a refusal", () => {
  test("says nothing where the build reports no permission at all", () => {
    /* Rahul's case on the day this was written: granted the app, signed in
       once, never checked in — so the handset has never had cause to report.
       That is not the same as being refused and must not be drawn as one. */
    const unknown = facts({ locationPermission: null, backgroundTrackingGranted: null });
    assert.deepEqual(texts(unknown), []);
  });

  test("says the prompt has not happened where the OS says undetermined", () => {
    const asked = facts({ locationPermission: "undetermined", backgroundTrackingGranted: null });
    assert.deepEqual(texts(asked), ["Location not asked for yet"]);
    assert.equal(handsetNotes(asked, T, NOW)[0].tone, "info");
  });
});

describe("the three location answers are three different sentences", () => {
  test("separates 'while using the app' from an outright refusal", () => {
    const whileUsing = texts(facts({ locationPermission: "while_using" }));
    const denied = texts(facts({ locationPermission: "denied" }));
    assert.deepEqual(whileUsing, ["Location only while the app is open"]);
    assert.deepEqual(denied, ["Location refused for MahekOne"]);
    assert.notDeepEqual(whileUsing, denied);
  });

  test("falls back to the old boolean for a handset still in the field", () => {
    /* An APK cannot be recalled: every phone out there today sends the
       boolean and nothing else, and its `false` cannot say WHICH of the two
       it is — so the wording promises no more than the reading supports. */
    const old = facts({ locationPermission: null, backgroundTrackingGranted: false });
    assert.deepEqual(texts(old), ["Background location off — trail has real gaps"]);
  });

  test("reads the old boolean's true as 'always', so nothing is drawn", () => {
    assert.deepEqual(texts(facts({ locationPermission: null, backgroundTrackingGranted: true })), []);
  });
});

describe("location switched off on the phone outranks any permission", () => {
  test("says only that, never both", () => {
    /* Saying both would send somebody to the wrong settings screen: when the
       device's own location is off, what MahekOne was granted is irrelevant. */
    const off = facts({ locationServicesEnabled: false, locationPermission: "denied" });
    assert.deepEqual(texts(off), ["Location switched off on the phone"]);
  });
});

describe("a battery reading always carries its age", () => {
  test("prints when it was read, never a bare percentage", () => {
    const low = facts({
      batteryPercent: 8,
      batteryCharging: false,
      deviceStateAt: new Date(NOW - 12 * 60_000),
    });
    assert.deepEqual(texts(low), ["Battery 8% — read 12 min ago"]);
  });

  test("says charging, because 18% climbing needs no phone call", () => {
    const charging = facts({
      batteryPercent: 18,
      batteryCharging: true,
      deviceStateAt: new Date(NOW - 60_000),
    });
    assert.deepEqual(texts(charging), ["Battery 18%, charging — read 1 min ago"]);
    assert.equal(handsetNotes(charging, T, NOW)[0].tone, "info");
  });

  test("is dropped entirely where nothing dates it", () => {
    /* A percentage with no timestamp is the one that gets believed as live. */
    const undated = facts({ batteryPercent: 8, deviceStateAt: null });
    assert.deepEqual(texts(undated), []);
  });

  test("stays quiet on a closed day unless it is actually low", () => {
    const healthy = facts({
      dayOpen: false,
      batteryPercent: 80,
      deviceStateAt: new Date(NOW - 60_000),
    });
    assert.deepEqual(texts(healthy), []);

    const flat = facts({
      dayOpen: false,
      batteryPercent: 6,
      batteryCharging: false,
      deviceStateAt: new Date(NOW - 60_000),
    });
    assert.deepEqual(texts(flat), ["Battery 6% — read 1 min ago"]);
  });
});

describe("silence is the only evidence of no signal", () => {
  test("names the gap once a working handset goes quiet", () => {
    const quiet = facts({ lastHeardAt: new Date(NOW - 47 * 60_000) });
    assert.deepEqual(texts(quiet), ["Not heard from for 47 min"]);
  });

  test("adds what it was last connected by, where that was mobile data", () => {
    const cell = facts({ lastHeardAt: new Date(NOW - 47 * 60_000), connectionType: "cellular" });
    assert.deepEqual(texts(cell), ["Not heard from for 47 min — last on mobile data"]);
  });

  test("stays quiet inside the threshold", () => {
    assert.deepEqual(texts(facts({ lastHeardAt: new Date(NOW - 29 * 60_000) })), []);
  });

  test("separates never-synced from gone-quiet", () => {
    /* A phone that has never spoken and one that stopped speaking send a
       manager to two different questions. */
    assert.deepEqual(texts(facts({ lastHeardAt: null })), ["Handset has never synced"]);
  });
});

describe("ageWords", () => {
  test("reads at a glance at every scale", () => {
    assert.equal(ageWords(NOW - 60_000, NOW), "1 min");
    assert.equal(ageWords(NOW - 59 * 60_000, NOW), "59 min");
    assert.equal(ageWords(NOW - 60 * 60_000, NOW), "1 hr");
    assert.equal(ageWords(NOW - 190 * 60_000, NOW), "3 hr 10 min");
    assert.equal(ageWords(NOW - 48 * 3_600_000, NOW), "2 days");
  });

  test("never reads as being in the future", () => {
    /* A handset's clock is its owner's to set, and a phone an hour fast would
       otherwise produce "-60 min ago". */
    assert.equal(ageWords(NOW + 3_600_000, NOW), "0 min");
  });
});
