import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  chooseOlaKey,
  classifyOlaAnswer,
  keyIsAvailable,
  olaPoolReport,
  type KeySpend,
} from "./ola-key-pool";

/* ---------------------------------------------------------------------------
 * THIS FILE IS THE WHOLE WARRANTY ON THE FAILOVER PATH.
 *
 * Production holds ONE Ola Maps key. The pool is insurance, so every line of
 * it below the single-key short circuit is code nobody will run until the
 * afternoon an account runs out — which is the worst imaginable moment to
 * find out it was wrong. Nothing about this can be checked by using the app,
 * because using the app is exactly what does not exercise it.
 * ------------------------------------------------------------------------- */

const HELD = ["k1", "k2", "k3"] as const;
const COOLDOWN = 24;
const at = (iso: string) => new Date(iso);
const spend = (iso: string, month: string): KeySpend => ({ spentAt: at(iso), month });

describe("what Ola's answer says about the key that was spent on it", () => {
  it("retires a key on 429, whatever the body says", () => {
    assert.equal(classifyOlaAnswer({ httpStatus: 429 }), "exhausted");
    assert.equal(classifyOlaAnswer({ httpStatus: 429, bodyText: "" }), "exhausted");
  });

  it("retires a key on a 403 that says it is about a limit", () => {
    assert.equal(
      classifyOlaAnswer({ httpStatus: 403, bodyText: '{"message":"Monthly quota exceeded"}' }),
      "exhausted",
    );
    assert.equal(
      classifyOlaAnswer({ httpStatus: 403, bodyText: "Rate limit reached for this project" }),
      "exhausted",
    );
  });

  it("does NOT retire a key on a 403 that is about the key rather than the quota", () => {
    /* A key restricted to the wrong domain, or one somebody mistyped. Taking
       it out of the pool would lose a good account to a typo, and the next
       call would be made with a key nobody meant to spend. */
    assert.equal(
      classifyOlaAnswer({ httpStatus: 403, bodyText: '{"message":"Invalid API key"}' }),
      "failed",
    );
    assert.equal(classifyOlaAnswer({ httpStatus: 401, bodyText: "Unauthorized" }), "failed");
  });

  it("does NOT retire a key on the failures that are about the request", () => {
    /* Snap-to-Road answers 400 to a batch of more than fifty points. That bug
       has shipped here once already; retiring the account over it would turn
       one request-shaping mistake into five dead accounts. */
    assert.equal(classifyOlaAnswer({ httpStatus: 400, bodyText: "Bad Request" }), "failed");
    assert.equal(classifyOlaAnswer({ httpStatus: 500 }), "failed");
    assert.equal(classifyOlaAnswer({ httpStatus: 503 }), "failed");
    /* Nought is a network error or a timeout — no answer at all, and an
       answer is the only thing that may retire a key. */
    assert.equal(classifyOlaAnswer({ httpStatus: 0 }), "failed");
  });

  it("reads a refusal that arrived inside a 200", () => {
    assert.equal(
      classifyOlaAnswer({ httpStatus: 200, bodyStatus: "QUOTA_EXCEEDED" }),
      "exhausted",
    );
    assert.equal(classifyOlaAnswer({ httpStatus: 200, bodyStatus: "SUCCESS" }), "ok");
    assert.equal(classifyOlaAnswer({ httpStatus: 200 }), "ok");
  });

  it("does not read a quota out of the prose of a successful answer", () => {
    /* Only the body's own status field is searched on a 2xx. A road named
       "Exceeded Lane" coming back in a successful snap is not a refusal. */
    assert.equal(
      classifyOlaAnswer({
        httpStatus: 200,
        bodyStatus: "SUCCESS",
        bodyText: '{"snapped_points":[{"name":"Exceeded Lane"}]}',
      }),
      "ok",
    );
  });
});

describe("choosing a key", () => {
  it("spends the first key while nothing has been refused", () => {
    const none = new Map<string, KeySpend | null>();
    assert.equal(chooseOlaKey(HELD, none, at("2026-09-19T10:00:00Z"), "2026-09", COOLDOWN), "k1");
  });

  it("moves to the second key once the first has been refused", () => {
    const spends = new Map([["k1", spend("2026-09-19T09:00:00Z", "2026-09")]]);
    assert.equal(chooseOlaKey(HELD, spends, at("2026-09-19T10:00:00Z"), "2026-09", COOLDOWN), "k2");
  });

  it("walks down the pool as each is refused in turn", () => {
    const spends = new Map([
      ["k1", spend("2026-09-19T09:00:00Z", "2026-09")],
      ["k2", spend("2026-09-19T09:30:00Z", "2026-09")],
    ]);
    assert.equal(chooseOlaKey(HELD, spends, at("2026-09-19T10:00:00Z"), "2026-09", COOLDOWN), "k3");
  });

  it("answers null when every key held has been refused", () => {
    const spends = new Map(
      HELD.map((n) => [n, spend("2026-09-19T09:00:00Z", "2026-09")] as const),
    );
    assert.equal(chooseOlaKey(HELD, spends, at("2026-09-19T10:00:00Z"), "2026-09", COOLDOWN), null);
  });

  it("goes back to the first key the moment its cooldown is up", () => {
    /* Not because the quota is known to be back — because the only way to
       find out is to ask, and a burst rate limit and a spent month arrive
       looking identical. */
    const spends = new Map([["k1", spend("2026-09-19T09:00:00Z", "2026-09")]]);
    assert.equal(chooseOlaKey(HELD, spends, at("2026-09-20T08:59:00Z"), "2026-09", COOLDOWN), "k2");
    assert.equal(chooseOlaKey(HELD, spends, at("2026-09-20T09:00:00Z"), "2026-09", COOLDOWN), "k1");
  });

  it("returns a spent key to the pool at the month boundary with no job firing", () => {
    /* A quota is monthly. A refusal recorded in September says nothing about
       October, so it is ignored rather than cleared — nothing has to run on
       exactly the right night, and a deploy over the month end cannot miss
       it. */
    const spends = new Map([["k1", spend("2026-09-28T09:00:00Z", "2026-09")]]);
    assert.equal(chooseOlaKey(HELD, spends, at("2026-09-28T10:00:00Z"), "2026-09", COOLDOWN), "k2");
    assert.equal(chooseOlaKey(HELD, spends, at("2026-10-01T00:05:00Z"), "2026-10", COOLDOWN), "k1");
  });

  it("does not read a refusal stamped in the future as ancient history", () => {
    /* A clock that jumped forward and came back would otherwise make a key
       that was just refused look like it had been refused long ago and
       therefore reset. It falls through to the cooldown instead. */
    const spends = new Map([["k1", spend("2026-10-01T09:00:00Z", "2026-10")]]);
    assert.equal(chooseOlaKey(HELD, spends, at("2026-09-30T23:00:00Z"), "2026-09", COOLDOWN), "k2");
  });

  it("holds a whole pool back only for as long as the cooldown", () => {
    const spends = new Map(
      HELD.map((n) => [n, spend("2026-09-19T09:00:00Z", "2026-09")] as const),
    );
    assert.equal(chooseOlaKey(HELD, spends, at("2026-09-20T10:00:00Z"), "2026-09", COOLDOWN), "k1");
  });

  it("a single-key pool behaves exactly as one key always has", () => {
    const one = ["k1"] as const;
    assert.equal(chooseOlaKey(one, new Map(), at("2026-09-19T10:00:00Z"), "2026-09", COOLDOWN), "k1");
    assert.equal(chooseOlaKey([], new Map(), at("2026-09-19T10:00:00Z"), "2026-09", COOLDOWN), null);
  });
});

describe("what a key is available on its own terms", () => {
  it("is available when nothing has ever been recorded about it", () => {
    assert.equal(keyIsAvailable(null, at("2026-09-19T10:00:00Z"), "2026-09", COOLDOWN), true);
  });

  it("honours a cooldown of a different length", () => {
    const s = spend("2026-09-19T09:00:00Z", "2026-09");
    assert.equal(keyIsAvailable(s, at("2026-09-19T11:00:00Z"), "2026-09", 1), true);
    assert.equal(keyIsAvailable(s, at("2026-09-19T11:00:00Z"), "2026-09", 72), false);
  });
});

describe("what the console is shown", () => {
  it("names one live key, the rest ready, and says when a resting one returns", () => {
    const spends = new Map([["k1", spend("2026-09-19T09:00:00Z", "2026-09")]]);
    const report = olaPoolReport(HELD, spends, at("2026-09-19T10:00:00Z"), "2026-09", COOLDOWN);
    assert.deepEqual(
      report.map((r) => r.state),
      ["resting", "live", "ready"],
    );
    assert.equal(report[0].retryAt?.toISOString(), "2026-09-20T09:00:00.000Z");
    assert.equal(report[1].retryAt, null);
    assert.equal(report[0].spentAt?.toISOString(), "2026-09-19T09:00:00.000Z");
  });

  it("says nothing is live when every key is resting", () => {
    const spends = new Map(
      HELD.map((n) => [n, spend("2026-09-19T09:00:00Z", "2026-09")] as const),
    );
    const report = olaPoolReport(HELD, spends, at("2026-09-19T10:00:00Z"), "2026-09", COOLDOWN);
    assert.equal(
      report.every((r) => r.state === "resting"),
      true,
    );
  });

  it("agrees with the key that would actually be spent", () => {
    /* The console and the request read the same two functions, so a screen
       naming a key the next call would not use is not a state this can be in. */
    const spends = new Map([
      ["k1", spend("2026-09-19T09:00:00Z", "2026-09")],
      ["k2", spend("2026-09-19T09:00:00Z", "2026-09")],
    ]);
    const now = at("2026-09-19T10:00:00Z");
    const report = olaPoolReport(HELD, spends, now, "2026-09", COOLDOWN);
    assert.equal(
      report.find((r) => r.state === "live")?.name,
      chooseOlaKey(HELD, spends, now, "2026-09", COOLDOWN),
    );
  });
});
