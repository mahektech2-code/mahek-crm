import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { resolveReadiness, SARVAM_MAX_SECONDS } from "./voice-readiness";

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
