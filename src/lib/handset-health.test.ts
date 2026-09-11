import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  ageWords,
  handsetNotes,
  trailHasGaps,
  trailIsDead,
  type HandsetFacts,
} from "@/lib/handset-health";

const NOW = new Date("2026-09-11T09:00:00+05:30").getTime();
const T = { quietMinutes: 30, noTrailMinutes: 90, lowBatteryPercent: 20 };

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
  checkInAt: new Date(NOW - 30 * 60_000),
  /* A healthy handset is one whose trail is producing. The default says so,
     so every test above that is about something else is not quietly also a
     test of a dead trail. */
  trailSeenAt: new Date(NOW - 60_000),
  /* A clean start: the start-of-day gate found nothing wrong, so nothing was
     claimed and there is nothing to say. Null would be just as healthy — it is
     a handset too old to report — but it would make every test above this one
     a test of an unreported build rather than of a working one. */
  setupReady: true,
  setupAcknowledgedAt: null,
  setupUnverified: null,
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

describe("checked in, reporting, and no trail at all", () => {
  /* The production incident this module was corrected for: a vivo checked in
     at 04:16 and by half past twelve had posted not one position ever, while
     its check-in, its selfie and its sync all arrived perfectly — and while
     every permission it reported read correct. `backgroundTrackingGranted` is
     true and honestly so: the handset refuses to send it unless the OS granted
     the background permission. The service started and the phone killed it,
     which is a fact no column on the device row can carry. */
  const vivo = (over: Partial<HandsetFacts> = {}) =>
    facts({
      locationPermission: null,
      backgroundTrackingGranted: true,
      checkInAt: new Date(NOW - 8 * 3_600_000 - 12 * 60_000),
      trailSeenAt: null,
      lastHeardAt: new Date(NOW - 84 * 60_000),
      ...over,
    });

  test("names the dead trail, and names it FIRST", () => {
    assert.deepEqual(texts(vivo()), [
      "No position all day — checked in 8 hr 12 min ago",
      "Not heard from for 1 hr 24 min",
    ]);
  });

  test("fires though every permission it reports reads healthy", () => {
    /* THE WHOLE POINT. `trailHasGaps` is false and correctly so — nothing he
       has granted is wrong — so this is the only thing in the module that
       catches him. Before it, his row said one thing: that he had gone quiet. */
    assert.equal(trailHasGaps(vivo()), false);
    assert.notDeepEqual(texts(vivo()), ["Not heard from for 1 hr 24 min"]);
    assert.equal(trailIsDead(vivo(), T, NOW), true);
    assert.equal(handsetNotes(vivo(), T, NOW)[0].tone, "bad");
  });

  test("does not send the manager to a permission that is already correct", () => {
    /* The commonest reader of this line is looking at a row whose Location
       permission is right, and a sentence telling him to go and change it
       spends the one call that could have fixed this proving nothing. */
    const detail = handsetNotes(vivo(), T, NOW)[0].detail ?? "";
    assert.match(detail, /autostart/);
    assert.match(detail, /battery/);
    assert.ok(detail.indexOf("battery") < detail.indexOf("Location"));
  });

  test("fires on a handset we ARE hearing from", () => {
    /* The whole point: the phone synced a minute ago and still has no trail.
       A dead trail is not a signal problem and must not wait for one. */
    const talking = vivo({ lastHeardAt: new Date(NOW - 60_000) });
    assert.deepEqual(texts(talking), ["No position all day — checked in 8 hr 12 min ago"]);
  });

  test("sits under the permission line rather than replacing it", () => {
    /* Two different facts: the setting, and what today actually produced. A
       phone set to 'while using the app' with holes in its trail is not the
       same row as one with no trail at all, and the settings line is what a
       manager reads out to the salesman. */
    const both = vivo({ locationPermission: "while_using", lastHeardAt: new Date(NOW - 60_000) });
    assert.deepEqual(texts(both), [
      "Location only while the app is open",
      "No position all day — checked in 8 hr 12 min ago",
    ]);
  });

  test("a check-in fix is NOT evidence of a trail", () => {
    /* `seenAt` on the row is the newest of the trail, the check-in and each
       visit, so this salesman has a pin, a place and a time — which is exactly
       what hid him. Only `trailSeenAt` answers the question. */
    assert.equal(trailIsDead({ ...vivo(), trailSeenAt: new Date(NOW - 3_600_000) }, T, NOW), false);
  });
});

describe("a morning that has only just started is not a fault", () => {
  test("stays quiet inside the threshold and speaks the moment it is past", () => {
    const inside = facts({ trailSeenAt: null, checkInAt: new Date(NOW - 90 * 60_000) });
    assert.deepEqual(texts(inside), []);

    const past = facts({ trailSeenAt: null, checkInAt: new Date(NOW - 91 * 60_000) });
    assert.deepEqual(texts(past), ["No position all day — checked in 1 hr 31 min ago"]);
  });

  test("says nothing at all where the day was never checked into", () => {
    /* No check-in is nothing to measure from, and a phone that has not started
       a day is not a phone failing to report one. */
    const notStarted = facts({ dayOpen: false, checkInAt: null, trailSeenAt: null });
    assert.deepEqual(texts(notStarted), []);
  });

  test("says nothing once the day is closed", () => {
    /* A day he has checked out of has produced whatever it was going to
       produce. Naming it now is a warning nobody can act on, on every row of
       every past day, which is how a screen teaches people to ignore it. */
    const done = facts({
      dayOpen: false,
      checkInAt: new Date(NOW - 9 * 3_600_000),
      trailSeenAt: null,
    });
    assert.deepEqual(texts(done), []);
    assert.equal(trailIsDead(done, T, NOW), false);
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

describe("a day that opened on a claim", () => {
  /* The gate stops a day from opening on a phone that cannot show it will
     record one. Where the failing steps are ones no API can check, it opens on
     the man SAYING he has done them — and the whole value of that claim is
     whether a trail then appeared. */

  test("says nothing where the claim worked", () => {
    /* He was stopped, he fixed his phone, the trail is producing. Nothing to
       do about this one, and a row that congratulated him would be furniture. */
    const fixed = facts({
      setupReady: false,
      setupAcknowledgedAt: new Date(NOW - 3 * 3_600_000),
      setupUnverified: ["battery-unrestricted"],
    });
    assert.deepEqual(texts(fixed), []);
  });

  test("names the claim rather than repeating the advice, where no trail followed", () => {
    /* The pattern the gate exists to surface: pressed the button, still not
       being recorded. Sending a manager to the same battery settings the
       salesman has already been through spends the one call that could fix it. */
    const failed = facts({
      trailSeenAt: null,
      checkInAt: new Date(NOW - 4 * 3_600_000),
      setupReady: false,
      setupAcknowledgedAt: new Date(NOW - 4 * 3_600_000),
      setupUnverified: ["battery-unrestricted"],
    });
    assert.deepEqual(texts(failed), ["No position all day — and he said the phone was set up"]);
    assert.match(
      handsetNotes(failed, T, NOW)[0].detail ?? "",
      /battery-unrestricted/,
      "what was still outstanding when he answered is the half a manager can act on",
    );
  });

  test("keeps the ordinary dead-trail sentence where nothing was claimed", () => {
    const dead = facts({ trailSeenAt: null, checkInAt: new Date(NOW - 4 * 3_600_000) });
    assert.deepEqual(texts(dead), ["No position all day — checked in 4 hr ago"]);
  });

  test("says a day opened unready before the trail has had time to fail", () => {
    /* A prediction of a lost day, made at nine in the morning rather than
       discovered at six in the evening. The gate is at `warn` in the office's
       own settings — nobody has claimed to have fixed anything. */
    const warned = facts({ setupReady: false });
    assert.deepEqual(texts(warned), [
      "Day opened on a phone that could not show it would record",
    ]);
  });

  test("says nothing where the build is too old to report any of it", () => {
    /* Null is not an answer. Every handset in the field reports none of this
       until it is updated, and drawing that as a fault would flag the whole
       team on the day the column shipped. */
    const old = facts({ setupReady: null, setupAcknowledgedAt: null });
    assert.deepEqual(texts(old), []);
  });
});
