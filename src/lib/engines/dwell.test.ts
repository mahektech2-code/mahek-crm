import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { dwellStops } from "./dwell";

const at = (hm: string) => new Date(`2026-09-06T${hm}:00+05:30`);

/** Two fixes a few metres apart, near Nariman Point. */
const pt = (lat: number, lng: number, hm: string) => ({ lat, lng, at: at(hm) });

describe("where the trail stood still", () => {
  it("finds nothing in a trail that never stops", () => {
    const points = [pt(19.0, 72.8, "09:00"), pt(19.01, 72.81, "09:05"), pt(19.02, 72.82, "09:10")];
    assert.deepEqual(dwellStops(points, 60, 5), []);
  });

  it("finds nothing in fewer than two fixes", () => {
    assert.deepEqual(dwellStops([pt(19.0, 72.8, "09:00")], 60, 5), []);
  });

  it("marks a run that stays within the radius for long enough", () => {
    const points = [
      pt(19.0, 72.8, "09:00"),
      pt(19.0, 72.8, "09:05"),
      pt(19.0, 72.8001, "09:10"),
      pt(19.0, 72.8, "09:15"),
      pt(19.02, 72.82, "09:20"),
    ];
    const stops = dwellStops(points, 60, 5);
    assert.equal(stops.length, 1);
    assert.equal(stops[0].minutes, 15);
    assert.equal(stops[0].startAt.toISOString(), at("09:00").toISOString());
    assert.equal(stops[0].endAt.toISOString(), at("09:15").toISOString());
  });

  it("does not count a brief pause shorter than the floor", () => {
    const points = [pt(19.0, 72.8, "09:00"), pt(19.0, 72.8, "09:02"), pt(19.02, 72.82, "09:05")];
    assert.deepEqual(dwellStops(points, 60, 5), []);
  });

  it("closes a run that never moves again by the end of the trail", () => {
    const points = [
      pt(19.0, 72.8, "09:00"),
      pt(19.0, 72.8, "09:05"),
      pt(19.0, 72.8, "09:10"),
    ];
    const stops = dwellStops(points, 60, 5);
    assert.equal(stops.length, 1);
    assert.equal(stops[0].minutes, 10);
  });

  it("anchors to the run's first fix, so a slow drift away is not one long stop", () => {
    // Each step is under the radius of the step before it, but 09:00 to 09:15
    // together cover far more than 60m — anchoring to a running centroid
    // would keep this as one dwell; anchoring to the first fix must not.
    const points = [
      pt(19.0, 72.8, "09:00"),
      pt(19.0, 72.80045, "09:05"),
      pt(19.0, 72.8009, "09:10"),
      pt(19.0, 72.80135, "09:15"),
    ];
    const stops = dwellStops(points, 60, 5);
    assert.ok(stops.every((s) => s.minutes < 15));
  });

  it("reports the mean position of the run, not just its first fix", () => {
    const points = [pt(19.0, 72.8, "09:00"), pt(19.0002, 72.8002, "09:10")];
    const stops = dwellStops(points, 60, 5);
    assert.equal(stops.length, 1);
    assert.equal(stops[0].lat, 19.0001);
    assert.equal(stops[0].lng, 72.8001);
  });
});
