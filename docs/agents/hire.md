# Hire

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

`/hire`, its own app. The PRD and functional spec are the client's; the
seeded Sales Executive blueprint is their AppSheet "Sales_Hire_App" rebuilt.
Everything below is a rule the code depends on.

**A ROLE IS A BLUEPRINT, AND A BLUEPRINT VERSION IS ONE ROW NOTHING UPDATES.**
`hire_blueprints.definition` holds the whole `BlueprintDefinition`
(`lib/hire/blueprint-types.ts`) — competencies, stages, questions, rubrics,
thresholds, briefing, documents, offer model, onboarding, provisioning,
fairness. An application records the VERSION row it entered under and is
scored against it for its whole journey; editing a published blueprint makes a
new draft, and publishing it retires the old one without rescoring anybody.
One document per version rather than eleven tables because a version is
published, frozen and read whole.

**THE FORMULA IS THE APPSHEET APP'S, AND ONE THRESHOLD GOVERNS EVERYTHING.**
`normalised = earned ÷ max × 100`, `final = normalised + grace`, pass at
`final ≥ passThreshold` — `engines/scoring.ts`, pure and tested. The old app
passed Level 2 at 70 for status and fired its message from 63 (D4); there is
no second number to fire from. Grace is shown beside the rubric score, never
merged, bounded by the stage's range, and needs a 20-character reason; a grace
that flips an outcome is flagged.

**The seeded blueprint is the rule, not a draft of one.** `seed/blueprints.ts`
resolves D4, D7, D8, D11 and D12 the way the design did, keeps the boss-rating
curve (a 10 scores 0 — a perfect rating from a former manager is read as
inflated) and caps the efficiency formula at 10. None of it is provisional: a
change is a new version published from the studio, and the diff shows what
moved. Sales Executive v2 is seeded RETIRED with the AppSheet defects in, so
that diff has something real to show.

**The validator blocks what would mis-score a real person** — weights not
totalling 100%, a question mapped to nothing, a reachable answer with no
score, an unapproved AI element, no decision gate before the offer.
`engines/validator.ts`; errors block publishing, warnings do not.

**IDENTITY IS THE PHONE NUMBER, NEVER THE NAME (D1).** `hire_candidates`
is unique on E.164 `primary_phone`. A returning number reuses the candidate
and links the earlier application; a near name in the same place raises a
POSSIBLE duplicate for a person. Nothing merges on its own, and a
reapplication inside the blueprint's cooling-off period needs an override.

**ENTRY GATING IS ENFORCED, NOT SUGGESTED (D5).** `moveApplication` in
`services/core.ts` is the one way a candidate changes stage; it asks
`engines/gating.ts`, and an override needs the capability, a reason and leaves
a marker on the record. `stageOutcome` derives a stage's outcome from its own
rows — a document verified or a topic ticked moves it without anybody
remembering to.

**AI EVALUATES; A NAMED PERSON DECIDES.** No candidate is rejected by the
system: a score below a floor PROPOSES a rejection that waits in Decisions for
`hire.rejection.reviewDays`. A decision gate needs reasoning (the database
refuses fewer than 20 characters) and records whether the person agreed with
the AI. An AI score is never committed until somebody presses Accept, Adjust
or Score myself, and every confirmation is a NEW `hire_answers` row — scores,
decisions, briefing responses and the audit trail are append-only, and
`hire_audit` has a trigger refusing UPDATE and DELETE.

**EVERY MODEL CALL GOES THROUGH `ai/orchestrator.ts`.** `runTask` checks the
switch and the key, redacts PII when asked, caches deterministic tasks, retries
a schema violation once, runs the caller's validation, rejects prohibited
inferences (`ai/guards.ts` — personality, emotion, appearance, accent, health,
religion, caste, family) and logs a `hire_ai_tasks` row whatever happens. It
never throws: an unavailable model is `ok: false` with a sentence, and every
screen has a manual path, because the pipeline runs without AI, slower.

**A SCORE WITHOUT A QUOTE IS NOT A SCORE.** `ai/score-answer.ts` rejects any
output whose evidence does not resolve, verbatim, in the candidate's own
response (`guards.locate` — exact first, then quote- and space-normalised).
The model is never shown the candidate's name or earlier scores, and a
response too short to assess comes back as insufficient with a probe — never
as a low score.

**HIRE'S JOBS ARE ROLES, NOT LEVELS.** Six — recruiter, interviewer, hiring
manager, onboarding, HR head, admin — in `lib/hire/roles.ts`, stored in
`hire_user_roles` and set on the Admin Console's People → Access screen, as
"Role in Hire" under the Hire grant — the one place every app is granted, the
same way an ERP designation or HRMS powers are. Picking a role sets the app
level it needs (`LEVEL_FOR_ROLE`); taking Hire away takes the role with it.
Hire had a Team screen of its own and lost it on purpose: two doors to one
person's access is how the two come to disagree. With no row the app level
decides, narrowly: admin → Admin, manager → Hiring Manager, associate →
Interviewer. The app is ONE module (`hire.app`) because the role is the
narrowing. Scope is SQL — `scopeWhere` in `lib/hire/access.ts` — and an
interviewer sees only applications they are interviewing and never an
earlier stage's score.

**PII IS VAULTED, with nothing to configure.** Aadhaar, PAN and account
numbers live encrypted in `hire_vault` (AES-256-GCM) under a key derived from
the app signing secret MBOS sign-in already depends on (`MBOS_JWT_SECRET`, or
`JWT_SECRET`) — deliberately no Hire-only variable, because a key that can be
added later silently strands every number stored before it. Rotating that
secret means re-encrypting the vault. Numbers are drawn masked; unmasking is a
capability, a warning and an audit line with `is_pii_access`. Files are
`hire_files`, read through `/api/hire/files/[id]`, never a stored URL.

**HIRED IS SET BY PROVISIONING (D9).** The pipeline ends by creating the
MahekOne account and granting the apps the blueprint's provisioning names —
that act, and nothing else, makes an application `hired`.

**INSTALLING IS PART OF THE DEPLOY.** `installHire` (`lib/hire/install.ts`)
seeds the role blueprints that are missing and gives Hire, as Admin, to every
platform administrator who lacks it; `deploy:db` runs it as `hire:deploy`
after the migrations and the catalogue, and it is idempotent. The layout also
seeds the blueprints the first time Hire opens on an empty database. Everybody
else gets Hire, and their role in it, on the Access screen.
`npm run hire:seed -- --demo --reset`
wipes Hire and loads the demo pipeline, development only.

**AN ISSUED OR ACCEPTED OFFER CAN BE WITHDRAWN BY US, AND THAT IS NOT CLOSING
THE APPLICATION.** `withdrawOffer` (services/offers.ts) moves the current offer
to `withdrawn` — the status `hire_offers` always allowed and nothing set — with a
reason of at least 20 characters on the trail (`offer_withdrawn`) and a message
to the candidate in the log. The application stays open at Documents & offer:
the form opens again for a new offer, and rejecting the person is still the
gate's or the rejection queue's decision. A hired person is refused (leaving is
HRMS's). The UI is "Withdraw offer" on the offer panel, a `ReasonButton` with
the `hire-offer-withdraw` impact modal (id = the application), and the action
asks `confirmImpact` before the service writes.

**ONLY A DRAFT THAT WAS NEVER PUBLISHED IS EVER DELETED.** Blueprint editor →
Delete draft (`deleteDraftBlueprint`, impact `hire-blueprint-draft`) removes a
`draft` row with no `published_at` and no applications; a published or retired
version is refused — edit it as a new version. The trail keeps
`blueprint_draft_deleted` with the title and version.

**A CANCELLED INTERVIEW IS A STATUS AND A TRAIL LINE, NEVER A DELETE.**
Calendar → Booked this week → Cancel (`cancelBooking`, needs `addCandidate`)
takes a `scheduled` execution back to `not_started` with no time or
interviewer, so the candidate is on To schedule again; `interview_cancelled`
keeps the booking as it stood and the reason (10+ characters). The interviewer
is belled; the candidate is told through `recordMessage` — an email sent from
here, or a WhatsApp/SMS/call recorded `logged` — never while do-not-contact.
Started or completed interviews are refused.
