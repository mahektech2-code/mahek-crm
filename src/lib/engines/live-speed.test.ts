import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { currentSpeedKmh } from "./live-speed";

const T0 = new Date("2026-10-05T10:00:00+05:30").getTime();
/** One degree of latitude is ~111,195 m, so this many metres north of the start. */
const north = (metres: number) => 19 + metres / 111_195;

/** A fix every `step` seconds, moving north at `kmh`, ending at T0 + duration. */
function ride(kmh: number, durationS: number, step = 3, accuracyM: number | null = 10) {
  const out = [];
  for (let s = 0; s <= durationS; s += step) {
    out.push({ lat: north((kmh / 3.6) * s), lng: 72.8, at: new Date(T0 + s * 1000), accuracyM });
  }
  return out;
}

const opts = { minKmh: 5, accuracyThresholdM: 50 };
const endOf = (durationS: number) => T0 + durationS * 1000;

describe("how fast he is moving now", () => {
  it("reads a bike at 28 km/h", () => {
    assert.equal(currentSpeedKmh(ride(28, 90), endOf(90), opts), 28);
  });

  it("says nothing below the threshold — walking pace is where the noise lives", () => {
    assert.equal(currentSpeedKmh(ride(4, 90), endOf(90), opts), null);
    assert.equal(currentSpeedKmh(ride(6, 90), endOf(90), opts), 6);
  });

  it("does not turn GPS jitter at a counter into a speed", () => {
    const jitter = ride(0, 90).map((p, i) => ({ ...p, lat: p.lat + (i % 2 ? 25 : -25) / 111_195 }));
    assert.equal(currentSpeedKmh(jitter, endOf(90), opts), null);
  });

  it("says nothing when the newest fix is stale — a backlog is not now", () => {
    assert.equal(currentSpeedKmh(ride(28, 90), endOf(90) + 5 * 60_000, opts), null);
  });

  it("does not measure across a hole in the trail", () => {
    const before = ride(28, 30);
    const after = ride(28, 6).map((p) => ({ ...p, at: new Date(p.at.getTime() + 10 * 60_000) }));
    assert.equal(currentSpeedKmh([...before, ...after], endOf(6) + 10 * 60_000, opts), null);
  });

  it("needs more than two fixes' worth of time", () => {
    assert.equal(currentSpeedKmh(ride(28, 6), endOf(6), opts), null);
  });

  it("ignores fixes the handset rated as imprecise", () => {
    assert.equal(currentSpeedKmh(ride(28, 90, 3, 300), endOf(90), opts), null);
  });

  it("drops an impossible speed as a bad fix", () => {
    assert.equal(currentSpeedKmh(ride(400, 90), endOf(90), opts), null);
  });

  it("reads a fix slightly newer than the panel's clock as fresh", () => {
    assert.equal(currentSpeedKmh(ride(28, 90), endOf(60), opts), 28);
  });
});
