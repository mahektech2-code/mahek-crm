import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { splitTrailByGaps } from "./trail-gaps";

const pt = (lat: number, lng: number) => ({ lat, lng });

describe("where a trail is confident, and where it is a guess", () => {
  it("returns nothing for fewer than two points", () => {
    assert.deepEqual(splitTrailByGaps([pt(19, 72)], 200), []);
    assert.deepEqual(splitTrailByGaps([], 200), []);
  });

  it("is one dense run when every hop is under the threshold", () => {
    const points = [pt(19.0, 72.8), pt(19.0005, 72.8005), pt(19.001, 72.801)];
    const segs = splitTrailByGaps(points, 200);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].gap, false);
    assert.equal(segs[0].coordinates.length, 3);
  });

  it("splits a single far hop into its own gap segment", () => {
    // ~0.02 degrees of longitude at this latitude is well over 200m.
    const points = [pt(19.0, 72.8), pt(19.0, 72.82)];
    const segs = splitTrailByGaps(points, 200);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].gap, true);
    assert.equal(segs[0].coordinates.length, 2);
  });

  it("keeps dense runs on either side of one gap separate", () => {
    const points = [
      pt(19.0, 72.8),
      pt(19.0001, 72.8001), // dense
      pt(19.0, 72.82), // gap from the previous point
      pt(19.0001, 72.8201), // dense again
    ];
    const segs = splitTrailByGaps(points, 200);
    assert.equal(segs.length, 3);
    assert.equal(segs[0].gap, false);
    assert.equal(segs[0].coordinates.length, 2);
    assert.equal(segs[1].gap, true);
    assert.equal(segs[2].gap, false);
    assert.equal(segs[2].coordinates.length, 2);
  });

  it("never produces a one-point dense segment", () => {
    // A gap immediately followed by another gap must not leave a stray
    // single-point "run" sitting between them.
    const points = [pt(19.0, 72.8), pt(19.0, 72.82), pt(19.0, 72.84)];
    const segs = splitTrailByGaps(points, 200);
    assert.ok(segs.every((s) => s.coordinates.length >= 2));
    assert.ok(segs.every((s) => s.gap));
    assert.equal(segs.length, 2);
  });
});
