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
