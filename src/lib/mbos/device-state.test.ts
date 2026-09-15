import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readDeviceState } from "@/lib/mbos/device-state";

describe("a partial report is a partial update, never a reset", () => {
  test("omits every key the handset did not send", () => {
    /* THE REASON THIS MATTERS: an APK cannot be recalled, so a handset still
       running the old build posts `backgroundGranted` and nothing else. If a
       missing field came back as null, that phone's every report would wipe
       the richer answers a newer build had already given for the same device
       — and the columns would flap depending on which build spoke last. */
    assert.deepEqual(readDeviceState({ backgroundGranted: true }), {});
  });

  test("stamps nothing where nothing was reported", () => {
    /* "We heard, and it was nothing" must not come to look like "we heard
       nothing" — an undated row is what says the second. */
    assert.equal(readDeviceState({}).deviceStateAt, undefined);
  });
});

describe("what is stored is what the OS actually answers", () => {
  test("takes the four location answers", () => {
    for (const p of ["always", "while_using", "denied", "undetermined"]) {
      assert.equal(readDeviceState({ locationPermission: p }).locationPermission, p);
    }
  });

  test("drops a spelling nothing recognises rather than storing it", () => {
    /* A value the screens cannot read is worse stored than absent: it looks
       like an answer and renders as nothing. The check constraint behind the
       column would refuse it anyway. */
    assert.equal(readDeviceState({ locationPermission: "granted" }).locationPermission, undefined);
    assert.equal(readDeviceState({ connectionType: "5g" }).connectionType, undefined);
  });

  test("keeps the good fields beside a bad one", () => {
    /* Refusing the whole report over one field would lose the readings that
       were fine — the same trade the position batch makes when it drops one
       malformed fix out of two hundred. */
    const state = readDeviceState({ locationPermission: "nonsense", batteryPercent: 44 });
    assert.equal(state.locationPermission, undefined);
    assert.equal(state.batteryPercent, 44);
  });
});

describe("a battery percentage is a percentage", () => {
  test("rounds what the handset sends", () => {
    assert.equal(readDeviceState({ batteryPercent: 43.6 }).batteryPercent, 44);
  });

  test("refuses a figure outside 0–100", () => {
    /* A handset is free to post whatever it likes to a URL, and "137%" on a
       manager's screen destroys the credibility of every figure beside it. */
    assert.equal(readDeviceState({ batteryPercent: 137 }).batteryPercent, undefined);
    assert.equal(readDeviceState({ batteryPercent: -4 }).batteryPercent, undefined);
    assert.equal(readDeviceState({ batteryPercent: Number.NaN }).batteryPercent, undefined);
  });

  test("keeps a genuine zero", () => {
    /* 0% is a real and useful reading, and a falsy check would drop it on the
       one row where somebody most needs to see it. */
    assert.equal(readDeviceState({ batteryPercent: 0 }).batteryPercent, 0);
  });
});

describe("the timestamp is the server's", () => {
  test("stamps a report that carried anything at all", () => {
    const before = Date.now();
    const at = readDeviceState({ batteryPercent: 50 }).deviceStateAt;
    assert.ok(at instanceof Date);
    assert.ok(at.getTime() >= before);
  });

  test("ignores a time the handset supplies for itself", () => {
    /* A phone's clock is its owner's to set, and the whole point of this
       column is that a screen can say how old a figure is. */
    const state = readDeviceState({ batteryPercent: 50, deviceStateAt: "2019-01-01T00:00:00Z" });
    assert.ok(state.deviceStateAt!.getFullYear() > 2020);
  });
});

describe("a condition ending is a thing a handset can say", () => {
  /* ABSENT IS NOT NULL is the rule that lets an old build post its one boolean
     without wiping a newer build's answers. What it could not express is a mark
     going away: a recovered — or reinstalled — handset simply stopped sending
     the field, so a stall mark once written could never be cleared, and a phone
     fixing to three metres every three seconds went on reading "his phone
     stopped the tracker" off a timestamp from a previous installation. */

  test("an explicit null clears the mark", () => {
    const state = readDeviceState({ trackerStalledAgoSeconds: null });
    assert.ok("trackerStalledAt" in state, "the key must be written for the clear to reach the column");
    assert.equal(state.trackerStalledAt, null);

    const sync = readDeviceState({ backgroundSyncLastRunAgoSeconds: null });
    assert.equal(sync.backgroundSyncLastRunAt, null);
  });

  test("an absent key still leaves the column exactly as it was", () => {
    /* The protection this whole function is built on, and the half that must
       not move: an old build sends neither field and must clear neither. */
    const state = readDeviceState({ batteryPercent: 50 });
    assert.ok(!("trackerStalledAt" in state));
    assert.ok(!("backgroundSyncLastRunAt" in state));
  });

  test("a real duration still sets it", () => {
    const state = readDeviceState({ trackerStalledAgoSeconds: 600 });
    assert.ok(state.trackerStalledAt instanceof Date);
    assert.ok(Date.now() - state.trackerStalledAt.getTime() >= 600_000 - 5_000);
  });

  test("a nonsense value is neither stored nor read as a clear", () => {
    /* A string, a negative, a fortnight — all dropped by `instantFromAgo`, and
       none of them is somebody saying the condition is over. */
    for (const v of ["soon", -5, 60 * 60 * 24 * 30]) {
      const state = readDeviceState({ trackerStalledAgoSeconds: v });
      assert.ok(!("trackerStalledAt" in state), `${String(v)} must not touch the column`);
    }
  });
});

describe("how far behind the phone is", () => {
  test("zero is a real answer and is stored", () => {
    /* Unlike the two marks above, a handset reporting an empty queue is
       telling us something — it is caught up. Absence is what means "cannot
       say", and the two must not collapse. */
    const state = readDeviceState({ queuedPositions: 0 });
    assert.equal(state.queuedPositions, 0);
    assert.ok(state.queuedPositionsAt instanceof Date);
  });

  test("a backlog is stored with its own timestamp", () => {
    const state = readDeviceState({ queuedPositions: 12_412 });
    assert.equal(state.queuedPositions, 12_412);
    assert.ok(state.queuedPositionsAt instanceof Date, "a count with no age reads as now");
  });

  test("an absent count is not a clear queue", () => {
    const state = readDeviceState({ batteryPercent: 50 });
    assert.ok(!("queuedPositions" in state));
    assert.ok(!("queuedPositionsAt" in state));
  });

  test("nonsense is dropped rather than rounded into something plausible", () => {
    for (const v of ["lots", -1, Number.NaN, null]) {
      const state = readDeviceState({ queuedPositions: v });
      assert.ok(!("queuedPositions" in state), `${String(v)} must not reach the column`);
    }
  });
});
