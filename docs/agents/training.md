# Training (modules, MCQ tests, retraining) and /learn

<!-- The Onboarding & Training PRD §12–18. Read AGENTS.md and docs/agents/hire.md first. -->

`lib/training/` — `types.ts` (shapes, client-safe), `engine.ts` (the rules,
PURE), `service.ts` (reads and writes). Authored in Hire's **Train** group
(`/hire/train/*`, Insights → Training); taken by the employee at **`/learn`**.
Every rule below exists because the PRD's audit and fairness asks depend on it.

**A MODULE VERSION IS ONE FROZEN DOCUMENT, LIKE A BLUEPRINT.**
`training_module_versions.definition` holds content, questions, pass mark,
timer, shuffles, feedback mode and minimum study. Editing makes or updates the
module's single draft; publishing retires the previous published version. An
attempt records `module_version_id`, so a question edited tomorrow never
changes what somebody was tested on today, and somebody who passed v2 keeps
the pass when v3 raises the mark. Tracks (`training_track_versions`) are the
same; an enrolment records the track VERSION it started.

**THE PASS RULE IS ≥, ON ONE DECIMAL.** `score()` rounds to one decimal, so
8/13 is 61.5% — not 62 — against a pass mark of 62. Equal passes (PRD §16).

**THE SERVER DRAWS, KEEPS TIME AND MARKS.** `startAttempt` draws the questions
with a seed from the attempt id (`drawAttempt`), so a reload shows the same
order; `attemptQuestion` serves a question WITHOUT its correct key; the answer
is marked in `answerQuestion`; the deadline is `deadline_at` on the server,
and anything that reads an enrolment closes an attempt past it on what was
answered (`closeExpired`). In after-each feedback mode an answer, once its
feedback is shown, cannot be changed. Only active, APPROVED questions are ever
drawn.

**A SUBMITTED ATTEMPT IS NEVER CHANGED, AND NO ATTEMPT IS DELETED.** A trigger
on `training_attempts` refuses any UPDATE once `submitted_at` is set, and any
DELETE. The authorised correction (PRD §21, `attemptCorrect`, HR Head/Admin)
is a `training_attempt_corrections` row with a 20+ character reason, read OVER
the attempt by `attemptsWithCorrections`. `training_events` and corrections
are append-only too.

**A FAIL IS RETRAINING, AND THE RETAKE NEEDS TWO THINGS AFTER THE FAIL.**
`moduleStates`: a failed last attempt is `retraining_required` until (1) a
trainer's `retraining_signed_off` event dated after the fail, with a note of
10+ characters, and (2) `minStudyMinutes` of study logged after the fail.
Then it is `retake_open`. A sign-off or study from before the fail does not
count. The next module stays locked throughout.

**UNLOCKING IS PREREQUISITES, NOT POSITION.** A track item's `after` is a list
of module keys, `[]` for "runs alongside" (Company Induction), or `null` for
"the item before it" in a sequential track. Progress counts REQUIRED modules
only.

**STUDY TIME IS CAPPED PER BEAT.** The reader sends `studyBeatAction` while the
tab is visible; `recordStudy` caps each beat at 15 minutes so a tab left open
does not bank hours, and refuses a locked module.

**PRODUCT FACTS ARE READ LIVE.** A `product_facts` block names a match; the
reader and the editor read `products` (active SKUs, pack, packing, cans per
box, selling price) at view time, so the price list in training is the price
list. A QUESTION that mentions a price is frozen with its version — that is
what the module editor's warning is for.

**AI DRAFTS QUESTIONS, A PERSON APPROVES THEM.** `ai/draft-questions.ts`
through the orchestrator, from the module's own content only. Drafts land
`ai: true, approved: false`; `moduleProblems` refuses to publish a module with
an active unapproved question, and `drawAttempt` never draws one.

**ENROLMENT HAPPENS AT PROVISIONING.** The blueprint's `training.trackKey`
(latest published version) is enrolled in the provisioning transaction. When
every required module passes, the enrolment is `completed` and
`onTrainingCompleted` (services/training-status.ts) closes the Training stage
and, if it is the last, sets `onboarding_completed_at`. Hire's
`stageOutcome` asks `training-status.ts` lazily so core and training do not
import each other at load time.

**/LEARN IS NOT AN APP ID.** It is reached by any signed-in person and shows
only THEIR enrolments and assets — every learner write takes the session's
user id, never one from the request. That avoided an enum migration (an app id
cannot be granted in the migration that adds it, docs/agents/app-ids-and-journeys.md)
for something every new employee needs on day one anyway. The directory is
the `hire.directory` setting: "Department | work email or number | about",
resolved to a user at read time; a line that resolves to nobody is left out.

**Seeded content is a draft on a real deployment.** `seedOnboardingContent`
(part of `hire:deploy`) inserts the plan, templates, modules and tracks where
missing, as DRAFTS with every question unapproved; product, policy and credit
wording is bracketed for its owner to write. `npm run hire:seed -- --demo
--reset` publishes all of it and the PRD blueprint versions.
