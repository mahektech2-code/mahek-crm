import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { departedTrailIds, trailLayerIds, trailSourceId } from "@/lib/map-layers";

/*
 * The Live map used to draw exactly once and never again — every trail on it
 * was the one built at first paint. Redrawing into the sources that already
 * exist is what fixed that, and the only part of a redraw that is a DECISION
 * rather than a call into MapLibre is this one: who was drawn last time and is
 * not on the map now. Everything else in `street-map.tsx` needs a WebGL
 * context to run at all, which is why this is the half that lives here.
 */
describe("which trails a redraw takes down", () => {
  test("names the three layers and the source they read", () => {
    /* All three, every time. MapLibre refuses to remove a source a layer is
       still reading, so a partial teardown throws half way through a redraw
       and takes the rest of the day's drawing with it. */
    assert.deepEqual(trailLayerIds("u1"), ["trail-casing-u1", "trail-u1", "trail-gap-u1"]);
    assert.equal(trailSourceId("u1"), "trail-u1");
  });

  test("leaves everybody who is still being drawn alone", () => {
    assert.deepEqual(departedTrailIds(["a", "b"], ["a", "b"]), []);
  });

  test("names whoever has left the map", () => {
    assert.deepEqual(departedTrailIds(["a", "b", "c"], ["b"]), ["a", "c"]);
  });

  /* A salesman whose first fix arrives mid-morning was drawn by nobody, so
     there is nothing of his to take down — the redraw adds him instead. */
  test("says nothing about somebody who has only just appeared", () => {
    assert.deepEqual(departedTrailIds([], ["a"]), []);
  });

  /* A trail that shrinks to nothing drawable counts as departed, which is the
     case that leaks: his layers stay on the map for ever and nothing about
     the screen looks wrong. */
  test("takes down a trail that has stopped being drawable", () => {
    assert.deepEqual(departedTrailIds(["a"], []), ["a"]);
  });

  /* The same sequence twice, from the drawn side rather than a Set — a
     teardown that removes layers in a different order each time is a bug
     nobody can reproduce. */
  test("keeps the order it was drawn in", () => {
    assert.deepEqual(departedTrailIds(["c", "a", "b"], []), ["c", "a", "b"]);
  });
});
