import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mbosApprovalStateEnum } from "@/db/schema";
import { MBOS_EVENT } from "@/lib/timeline";

/**
 * "SEND BACK" RETURNS AN APPOINTMENT FOR CORRECTION AND MOVES NO STAGE.
 *
 * That is the client's instruction in as many words, and it is the whole reason
 * the action exists: a reviewer who cannot answer yet had only approve, which
 * appoints a distributor on an application he cannot read, and refuse, which
 * ends the application and makes somebody ring the candidate. What he does
 * instead is ring the salesman, leaving the queue ageing with no record of why.
 *
 * The rule is one line inside `sendBackForCorrection` — it simply never touches
 * the ladder — and one line is exactly the kind of rule a later edit removes
 * without noticing. `advanceLeadStage` is one import away, both actions beside
 * this one call it, and adding "and move it back to `management_review`" reads
 * like tidying up. So this reads the SOURCE and fails on the import rather than
 * waiting for somebody to find out from a lead that slid down a rung.
 *
 * It is a source test for the reason `timeline-coverage.test.ts` is one: what
 * is being asserted is an ABSENCE, and an absence is not a value any unit test
 * can be handed. Running the action would need a database, and the integration
 * suite is where that belongs — but a stage that moves is invisible there too
 * unless somebody thinks to assert it did not.
 */

const SOURCE = readFileSync(
  join(import.meta.dirname, "actions", "distributor-appointment.ts"),
  "utf8",
);

/**
 * Comments are stripped before anything is read, because the doc comment on the
 * action explains at length that it does not move the stage and names
 * `advanceLeadStage` while doing so. Flagging the explanation would teach the
 * next person to delete the explanation rather than keep the rule — the same
 * reasoning `timeline-coverage.test.ts` gives for stripping first.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/** The body of one exported function, up to the next top-level export. */
function bodyOf(name: string): string {
  const code = stripComments(SOURCE);
  const start = code.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} is gone — the feature it guards has moved or been deleted`);
  const after = code.indexOf("\nexport ", start + 1);
  return code.slice(start, after === -1 ? undefined : after);
}

/**
 * Every `.set({ … })` in a function, which is the only place a Drizzle update
 * can change a column.
 *
 * The distinction matters here and a plain substring search cannot make it:
 * `sendBackForCorrection` READS `state` in its select — it has to, to refuse a
 * step somebody has already decided — and `state:` appearing in the source is
 * therefore not evidence of anything. What must never appear is `state` in the
 * object it WRITES.
 */
function writesIn(name: string): string {
  const body = bodyOf(name);
  return [...body.matchAll(/\.set\(\{([\s\S]*?)\n\s*\}\)/g)].map((m) => m[1]).join("\n");
}

test("sending back moves no sales stage", () => {
  const body = bodyOf("sendBackForCorrection");
  /* `advanceLeadStage` is the one door to the ladder — it owns the gate engine,
     the transition row and the `kind` flip — and both actions beside this one
     call it, so adding a call here reads like tidying up rather than like a
     reversal of what the client asked for. `customers` is named as well: an
     update written by hand would move the stage while sidestepping the ladder
     entirely, which is worse than calling the action. */
  for (const forbidden of ["advanceLeadStage", "customers.leadStage", "lead_stage"]) {
    assert.ok(
      !body.includes(forbidden),
      `sendBackForCorrection now references ${forbidden}. Mahek asked for a send-back to return an item for correction WITHOUT changing the sales stage — a lead in management review that is sent back is still in management review, and moving it would undo gates the salesman has already passed and write the reversal into §25's timeline as though somebody had decided it.`,
    );
  }
  assert.ok(
    !/\.update\(customers\)/.test(body) && !/update customers/i.test(body),
    "sendBackForCorrection now writes to `customers`. The candidate's record is not what a send-back is about: the application is, and the row carrying it is the approval.",
  );
});

test("sending back decides nothing", () => {
  const written = writesIn("sendBackForCorrection");
  /* The row stays `pending`, which is what makes every existing reader of
     `state` correct by doing nothing — including the "is anything still
     outstanding" count that stops management appointing a candidate the sales
     manager has not recommended. Writing `state` here, in any direction, is
     what would break it. */
  for (const column of ["state", "approverUserId", "decidedAt", "decisionNote"]) {
    assert.ok(
      !new RegExp(`\\b${column}:`).test(written),
      `sendBackForCorrection now writes \`${column}\`. Nobody decided anything — the row must stay pending, or the outstanding-steps count stops holding the appointment back.`,
    );
  }
  assert.ok(
    /\bsentBackNote: note\b/.test(written),
    "the note is no longer written to the row, so the screen has nothing to show and the correction lives only in a notification somebody has read and dismissed",
  );
});

test("a send-back without a note is refused by the action, not only by the form", () => {
  const body = bodyOf("sendBackForCorrection");
  assert.ok(
    /note:\s*z\.string\(\)[^\n]*\.min\(1\)/.test(stripComments(SOURCE)),
    "the note is no longer required by the schema — a send-back with no note is \"do it again\" with no idea what was wrong, which is the failure this feature exists to prevent",
  );
  assert.ok(
    body.includes("safeParse") && body.includes("validation"),
    "the action no longer validates its own input; a server action is a URL and a required field on a form is not a rule",
  );
});

test("the capability is the step's own, exactly as the decision's is", () => {
  /* Sending a step back holds the decision, which is the same authority as
     taking it. A weaker hat able to turn management's step back would be a way
     to stall an appointment without the right to refuse one. */
  for (const name of ["decideDistributorAppointment", "sendBackForCorrection"]) {
    const body = bodyOf(name);
    assert.ok(
      body.includes('requireCapability("distributor.approve")') &&
        body.includes('requireCapability("distributor.terms")') &&
        body.includes("stepIndex >= 1"),
      `${name} no longer picks its capability off the step. Step 1 is \`distributor.approve\` and anything below it is \`distributor.terms\`, and the two are not interchangeable.`,
    );
  }
});

test("it tells the person it goes back to, with the note IN the message", () => {
  const body = bodyOf("sendBackForCorrection");
  assert.ok(
    body.includes("notifications"),
    "nobody is told. A decision nobody receives is not a decision, and a send-back nobody receives is a queue ageing for a reason living in one person's memory.",
  );
  assert.ok(
    /body:\s*`\$\{candidate\.name\}: \$\{note\}`/.test(body),
    "the note no longer travels in the notification body. It is the ENTIRE content of a send-back — somebody has to go and fix the thing it names — and a notification that makes them open a screen to find out what is one they read later, if at all.",
  );
  assert.ok(
    /kind:\s*"warn"/.test(body),
    'the notification kind is not `warn`. The bell colours `warn` and `danger` only; `warning` is drawn as an ordinary notification, which is what several existing callers get wrong.',
  );
});

test("it is audited, with the hat that allowed it", () => {
  const body = bodyOf("sendBackForCorrection");
  assert.ok(
    body.includes("auditLog") &&
      body.includes("actorRole: ctx.authorisedBy") &&
      body.includes("actorApp: ctx.authorisedIn"),
    "the send-back is no longer audited with its granting hat. With several hats per person, `was he allowed to do this` is not answerable from the person.",
  );
});

test("no fourth approval state was invented for it", () => {
  /* Semantically a sent-back row is still pending — nobody decided. And
     mechanically, a value added to an existing enum may not be USED in the
     transaction that adds it, while drizzle-kit applies every pending migration
     in ONE: the failure would appear only on a database built from scratch,
     which is the trap this repo has already been caught by. */
  assert.deepEqual(
    [...mbosApprovalStateEnum.enumValues].sort(),
    ["approved", "partially_approved", "pending", "rejected"],
    "a value has been added to `mbos_approval_state`. A sent-back step is PENDING with a note; a new state would be the row asserting a decision nobody took, and every reader of `state` would have to learn about it or quietly get it wrong.",
  );
});

test("the marks are cleared the moment the step is next acted on", () => {
  /* Left standing, last month's note about a missing warehouse answer sits on
     a row somebody has since corrected and had approved — sending the next
     reader to fix what is already fixed. Both paths that act on a live step
     clear them: the decision, and the terms being restated on a step 1 that is
     still waiting. */
  for (const name of ["decideDistributorAppointment", "agreeCommercialTerms"]) {
    const body = bodyOf(name);
    assert.ok(
      body.includes("sentBackAt: null") &&
        body.includes("sentBackById: null") &&
        body.includes("sentBackNote: null"),
      `${name} no longer clears the send-back marks, so an answered correction goes on asking to be corrected.`,
    );
  }
});

test("a send-back lands on the customer's own history", () => {
  const body = bodyOf("sendBackForCorrection");
  assert.equal(MBOS_EVENT.distributorSentBack, "distributor_sent_back");
  assert.ok(
    body.includes("MBOS_EVENT.distributorSentBack"),
    "the timeline entry has gone. A record showing only the eventual approval says the application went through first time, and `turned back twice before anybody signed it` is what a reader months later actually wants.",
  );
  assert.ok(
    /sourceRecordId: `\$\{approval\.id\}:sent-back:\$\{now\.toISOString\(\)\}`/.test(body),
    "the source id no longer distinguishes one send-back from the next. The natural key is (app, kind, source row), so the bare approval id collapses every send-back onto the first — and the first is the least informative of them.",
  );
});
