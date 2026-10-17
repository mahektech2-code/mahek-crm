import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { minutesShut, shutMessage } from "./sign-in-throttle-rules";

const now = new Date("2026-10-03T10:00:00Z");
const ago = (min: number) => new Date(now.getTime() - min * 60_000);

describe("minutesShut", () => {
  it("is open when the limit has not been reached inside the window", () => {
    assert.equal(minutesShut(null, 15, now), null);
  });

  it("is shut until the limit-th newest failure ages out of the window", () => {
    assert.equal(minutesShut(ago(5), 15, now), 10);
    assert.equal(minutesShut(ago(0), 15, now), 15);
  });

  it("opens the moment that failure is a full window old", () => {
    assert.equal(minutesShut(ago(15), 15, now), null);
    assert.equal(minutesShut(ago(40), 15, now), null);
  });

  it("never says zero minutes while still shut", () => {
    assert.equal(minutesShut(new Date(now.getTime() - 15 * 60_000 + 5_000), 15, now), 1);
  });
});

describe("shutMessage", () => {
  it("names the wait and the way round it, and nothing about the account", () => {
    assert.match(shutMessage(1, true), /a minute/);
    assert.match(shutMessage(12, true), /12 minutes/);
    assert.match(shutMessage(3, true), /code sent to your phone/);
    assert.doesNotMatch(shutMessage(3, true), /account/i);
  });

  it("offers a phone code only where there is one", () => {
    assert.doesNotMatch(shutMessage(3, false), /phone/);
    assert.match(shutMessage(3, false), /reset your password/);
  });
});
