import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/* ---------------------------------------------------------------------------
 * THE CALL LOG FORM'S WIRING, read as source.
 *
 * There is no DOM test harness in this repo, and these are not behaviour tests:
 * they pin the structural decisions that a refactor could undo without a type
 * error or a lint warning — one Notes box, one source of truth for it, one
 * microphone, and every way of changing the outcome going through the one
 * function that drops a Next Action the new outcome does not offer. They read
 * the source like `layout-rules.test.ts` does, for the same reason: none of it
 * is expressible in a type. The BEHAVIOUR behind them — what survives an
 * outcome change, what a proposal may fill — is `reconcileNextActions`, pure
 * and tested in `lib/call-reasons.test.ts`.
 * ------------------------------------------------------------------------- */

const read = (rel: string) =>
  readFileSync(join(process.cwd(), "src", rel), "utf8");
const panel = read("components/crm/call-panel.tsx");
const assistant = read("components/crm/call-assistant.tsx");

const count = (haystack: string, needle: string | RegExp) =>
  typeof needle === "string"
    ? haystack.split(needle).length - 1
    : (haystack.match(needle) ?? []).length;

/** The body of `function name(...) { ... }`, by brace matching. */
function bodyOf(source: string, name: string): string {
  const at = source.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name} not found`);
  const open = source.indexOf("{", source.indexOf(")", at));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  throw new Error(`${name} never closes`);
}

/* ------------------------------------------------------------------ notes */

test("the call has ONE Notes box, and it is bound to the one notes state", () => {
  assert.equal(count(panel, 'label="Notes"'), 1);
  /* Nothing else in the panel is bound to the call's notes. (The complaint's
     own description box is a different field with a different state.) */
  assert.equal(count(panel, "value={notes}"), 1);
  const at = panel.indexOf("<VoiceTextarea", panel.indexOf('label="Notes"'));
  const tag = panel.slice(at, panel.indexOf("/>", at));
  assert.match(tag, /value=\{notes\}/);
  assert.match(tag, /onChange=\{\(e\) => setNotes\(e\.target\.value\)\}/);
  assert.match(tag, /onDictate=\{setNotes\}/);
});

test("the assistant card carries no note box of its own", () => {
  assert.equal(count(assistant, "<Textarea"), 0);
  assert.doesNotMatch(assistant, /import \{[^}]*\bTextarea\b/);
});

test("the Notes box sits directly under the assistant, before the form's steps", () => {
  const assistantAt = panel.indexOf("<CallAssistant");
  const notesAt = panel.indexOf('label="Notes"');
  const stepsAt = panel.indexOf("How did this interaction happen?");
  const anchorAt = panel.indexOf('id="call-log-form-start"');
  assert.ok(assistantAt >= 0 && notesAt > assistantAt, "under the assistant");
  assert.ok(stepsAt > notesAt, "above the questions, not after an outcome is picked");
  assert.ok(anchorAt > notesAt && anchorAt < stepsAt, "the scroll target follows it");
  assert.ok(
    assistant.includes('getElementById("call-log-form-start")'),
    "the assistant scrolls to that anchor",
  );
});

test("the Notes box is not drawn once the call is saved", () => {
  const at = panel.indexOf('label="Notes"');
  const before = panel.slice(Math.max(0, at - 700), at);
  assert.match(before, /\{!saved \? \(/);
});

test("the assistant still writes to, and 'Read what I typed' still reads, that state", () => {
  assert.match(panel, /<CallAssistant[\s\S]*?notes=\{notes\}[\s\S]*?onNotes=\{setNotes\}/);
  assert.match(assistant, /onClick=\{\(\) => read\(null, notes\)\}/);
  assert.match(assistant, /const typedReady = notes\.trim\(\)\.length > 1/);
  assert.match(bodyOf(assistant, "importDictated"), /onNotes\(/);
});

test("reset clears the notes", () => {
  assert.match(bodyOf(panel, "reset"), /setNotes\(""\)/);
});

test("quick notes still add to and take from the same notes", () => {
  assert.match(panel, /addLabel\(t, n\.label\)/);
  assert.match(panel, /dropLabel\(t, n\.label\)/);
  assert.match(panel, /Quick notes/);
});

/* ------------------------------------------------------------- microphone */

test("the Notes box gives up its microphone only where the assistant offers one", () => {
  const at = panel.indexOf("<VoiceTextarea", panel.indexOf('label="Notes"'));
  assert.match(panel.slice(at, panel.indexOf("/>", at)), /hideMic=\{!micOnNotes\}/);
  /* Off when the assistant is on AND this is not an order received — the one
     place the assistant draws nothing, where the Notes microphone is the only
     dictation there is. Also the whole of what survives if the assistant is
     switched off. */
  assert.match(
    panel,
    /const micOnNotes = !\(assistantOn && !isOrderReceived\);/,
  );
  assert.match(panel, /onEnabled=\{setAssistantOn\}/);
  assert.match(assistant, /onEnabled\?\.\(s\.enabled\)/);
  assert.match(assistant, /interactionType === "order_received"\) return null/);
});

test("every other VoiceTextarea keeps its microphone by default", () => {
  const dictate = read("components/ui/dictate.tsx");
  assert.match(dictate, /hideMic = false/);
});

/* --------------------------------------------------- stale next actions */

test("every way of changing the outcome drops a Next Action it no longer offers", () => {
  /* The three buttons that set or clear the outcome all go through it — and
     the fourth caller is the reason button, which pre-sets Complaint (and
     takes it back off) so a complaint reason opens the complaint form. */
  assert.equal(count(panel, "pickOutcome("), 5, "the definition and four handlers");
  const outside = panel
    .replace(bodyOf(panel, "pickOutcome"), "")
    .replace(bodyOf(panel, "reset"), "")
    .replace(bodyOf(panel, "applyAssistant"), "");
  assert.doesNotMatch(outside, /setOutcome\(/, "no other path sets the outcome");
  assert.match(bodyOf(panel, "pickOutcome"), /reconcileNextActions\(/);
});

test("the assistant's proposal is checked against the incoming outcome and reason", () => {
  const body = bodyOf(panel, "applyAssistant");
  const at = body.indexOf("reconcileNextActions(");
  assert.ok(at >= 0);
  const call = body.slice(at, body.indexOf("});", at));
  assert.match(call, /reason: inbound \? callReason \|\| fill\.callReason \|\| null : null/);
  assert.match(call, /outcome: outcomeApplies \? fill\.outcome : outcome/);
  assert.match(call, /proposed: fill\.nextActions/);
  assert.match(call, /proposedDate: fill\.nextActionDate/);
});

test("the save sends only the actions the call still offers", () => {
  assert.match(panel, /const activeActions = nextActions\.filter/);
  assert.match(
    panel,
    /nextActions: actionOptions\.length \? activeActions : undefined/,
  );
  assert.match(panel, /const needsActionDate = wantsDate\(activeActions\)/);
});

test("choosing a reason still clears the Next Action", () => {
  assert.match(panel, /setReasonDetail\(\{\}\);\s*setNextActions\(\[\]\);\s*setNextActionDate\(""\);/);
});
