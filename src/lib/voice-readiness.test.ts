import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  isPermanentRefusal,
  resolveReadiness,
  SARVAM_MAX_SECONDS,
} from "./voice-readiness";

/* ---------------------------------------------------------------------------
 * What dictation can do, given which keys exist.
 *
 * Every case here was reachable on a real deployment and three of them drew a
 * microphone that could not produce a note. They are pinned because the only
 * place the combinations showed themselves before was a telecaller's screen,
 * mid-call, after they had already said their piece.
 * ------------------------------------------------------------------------- */

const BASE = {
  provider: "sarvam" as const,
  fallbackToOpenai: true,
  maxSeconds: 120,
  hasSarvamKey: true,
  hasOpenaiKey: true,
};

describe("what dictation is able to do", () => {
  test("both keys: the configured limit stands", () => {
    const r = resolveReadiness(BASE);
    assert.equal(r.canHear, true);
    assert.equal(r.canRefine, true);
    assert.equal(r.maxSeconds, 120);
  });

  test("Sarvam only: the recorder stops at Sarvam's own ceiling", () => {
    // The bug this exists for. A 120-second limit against a provider that
    // refuses anything over 30 let somebody talk for two minutes into a
    // fallback with no key, and told them dictation was not set up — after
    // the recording, which is the worst moment to find out.
    const r = resolveReadiness({ ...BASE, hasOpenaiKey: false });
    assert.equal(r.canHear, true);
    assert.equal(r.canRefine, false);
    assert.equal(r.maxSeconds, SARVAM_MAX_SECONDS);
  });

  test("Sarvam only with the fallback off: same ceiling", () => {
    // The fallback flag changes nothing when there is no key behind it. It
    // used to be the only thing checkConsistency looked at, which is how a
    // deployment passed validation and then failed on every long recording.
    const r = resolveReadiness({
      ...BASE,
      hasOpenaiKey: false,
      fallbackToOpenai: false,
    });
    assert.equal(r.canHear, true);
    assert.equal(r.maxSeconds, SARVAM_MAX_SECONDS);
  });

  test("a limit already under the ceiling is left alone", () => {
    const r = resolveReadiness({ ...BASE, hasOpenaiKey: false, maxSeconds: 20 });
    assert.equal(r.maxSeconds, 20);
  });

  test("OpenAI chosen, only a Sarvam key: NO microphone", () => {
    // Sarvam is unreachable when it is not the chosen provider, so the one key
    // present can serve nothing. This drew a microphone that could not
    // transcribe a word, because the old check asked only whether any key
    // existed anywhere.
    const r = resolveReadiness({
      ...BASE,
      provider: "openai",
      hasOpenaiKey: false,
    });
    assert.equal(r.canHear, false);
  });

  test("OpenAI chosen with its key: the full limit, whatever Sarvam's is", () => {
    const r = resolveReadiness({
      ...BASE,
      provider: "openai",
      hasSarvamKey: false,
    });
    assert.equal(r.canHear, true);
    assert.equal(r.maxSeconds, 120);
  });

  test("OpenAI only, Sarvam chosen, fallback ON: it hears through the fallback", () => {
    const r = resolveReadiness({ ...BASE, hasSarvamKey: false });
    assert.equal(r.canHear, true);
    assert.equal(r.maxSeconds, 120);
  });

  test("OpenAI only, Sarvam chosen, fallback OFF: nothing can hear", () => {
    // The key exists but nothing is allowed to reach it.
    const r = resolveReadiness({
      ...BASE,
      hasSarvamKey: false,
      fallbackToOpenai: false,
    });
    assert.equal(r.canHear, false);
    // Tighten and Rewrite are a separate question and still work: they are a
    // text call that never goes near the transcription route.
    assert.equal(r.canRefine, true);
  });

  test("no keys at all: nothing", () => {
    const r = resolveReadiness({
      ...BASE,
      hasSarvamKey: false,
      hasOpenaiKey: false,
    });
    assert.equal(r.canHear, false);
    assert.equal(r.canRefine, false);
  });
});

describe("telling a refusal from a stumble", () => {
  test("out of credit is permanent — this exact string came off the wire", () => {
    // Verified against the live API while chasing "the transcription service
    // did not answer": the account had no credits, and the old code invited a
    // retry that could never have worked.
    assert.equal(
      isPermanentRefusal(
        "Failed after 3 attempts. Last error: AI_APICallError: You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.",
      ),
      true,
    );
  });

  test("the machine-readable forms of the same thing", () => {
    assert.equal(isPermanentRefusal("insufficient_quota"), true);
    assert.equal(isPermanentRefusal("credit_balance_exhausted"), true);
    assert.equal(isPermanentRefusal("You exceeded your current quota"), true);
  });

  test("a bad or revoked key is permanent", () => {
    assert.equal(isPermanentRefusal("401 Incorrect API key provided"), true);
    assert.equal(isPermanentRefusal("invalid_api_key"), true);
    assert.equal(isPermanentRefusal("403 Unauthorized"), true);
  });

  test("a timeout, a 500 and rate limiting are NOT permanent", () => {
    // Rate limiting is the one worth being careful about: it shares a status
    // code with the quota error and is the one case where trying again is
    // exactly right.
    assert.equal(isPermanentRefusal("The operation was aborted due to timeout"), false);
    assert.equal(isPermanentRefusal("500 Internal Server Error"), false);
    assert.equal(isPermanentRefusal("429 Rate limit reached for requests"), false);
    assert.equal(isPermanentRefusal("fetch failed"), false);
  });
});
