# Raw SQL rule, Admin Console, settings pages, feedback

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**In raw SQL, qualify every column of the outer table.** Drizzle renders
`${customers.id}` as a bare `"id"`. Inside a correlated subquery that binds to
the *inner* table and the condition silently becomes false — types and unit
tests both pass. Write `customers.id` in the string instead. This one shipped
once; the integration tests exist partly to catch it.

**The Admin Console answers from the database, or it does not answer.**
Every platform screen — Overview, Apps, Data, Notifications, Audit — used to
render fixtures: a failing integration that did not exist, a nightly backup
nobody runs, "14 customers unassigned" that was a literal `14`, and a header
naming two invented people, Sandeep Rao and Vikram Shah, instead of whoever
was signed in. A console is where somebody goes to find out whether the
platform is all right, so one that answers from a file is worse than one that
does not answer: it is believed. `lib/services/admin-platform-service.ts` is
the one place those questions are asked.

**Where nothing can answer, the screen is GONE rather than filled in.** Access
requests, lockout counters, failed-attempt logs, grant expiry, unused-access
reports, feature flags, contract validation, export logs, backup status,
scheduled configuration changes and per-app roles were all deleted, because
MahekOne records none of them. Anything kept says plainly what it cannot show
— a session row has no device or IP because neither is stored.

**A screen that offers an action must do it.** "Trigger password reset" wrote
a line to an in-memory list and toasted as though mail had gone; "Create user"
created nobody. Those are real actions now (`sendPasswordResetFor`,
`endSessionsFor`, `createUser`), and the one save path with nowhere to write
says so instead of claiming success.

**THE CONSOLE IS ROUTES, NOT ONE PAGE.** It was a single `[[...path]]` page
that loaded every section's data on every visit — the catalogue, the sheet,
feedback, the expense policy and thirteen platform queries to draw one tab —
and switched screens in memory, so its links were a section and a tab named
as two loose strings. Nothing failed when one went stale: "Open contract
validation" pointed at a tab deleted two releases earlier, the Attention list
sent people to a section called "sheet" that was always "order-sheet", HRMS
linked to `/admin/access`, which was a blank page. Every screen is its own
route now, inside `admin/layout.tsx` — the same `AppFrame` and
`CollapsibleNav` every other app draws — and every address is built from
`ADMIN` in `lib/admin-routes.ts`. `admin-routes.test.ts` resolves each one, and
each redirect's destination, against the `page.tsx` files on disk, and fails
on any `/admin/…` literal written elsewhere. Old addresses are permanent
redirects in `lib/admin-redirects.ts`.

**THE CONSOLE WEARS THE V4 LOOK (Nov 2026), AND ITS SIDEBAR IS BY JOB.** Its
shell carries `data-v4 data-v4-app="admin"` — the ERP's frame, the lavender
header, the Mahek mark atop the sidebar and a System status card at its foot,
read off the same `attentionItems` Home draws. The groups are People & access,
Settings, Business data, Devices and System. `AdminPage` takes `metrics` (the
figure cards) and `routeTabs`, for a screen that is several routes: Security &
sign-ins is `/admin/sign-ins`, `/admin/otp` and `/admin/security` (the `auth.*`
settings, found in the schemas by key) under one `SECURITY_TABS` strip, and
Handsets is the two handset routes under `HANDSET_TABS`; a nav row's `match`
lights it on all of them. Five screens were added, each reading what is already
stored (`services/admin-console-service.ts`): Roles & permissions (the matrix,
read-only, lowest level per app), Change history (the `config.update` audit
rows; Restore goes through `updateConfigSetting` and only on a setting's newest
change), Data health (counts, plus a rebuild per derived figure —
`rebuildDerived`, platform admin, audited `job.rebuild`), App releases (builds
reported by `mbos_devices` and `factory_devices`) and Storage & files.

**AND THE REST OF THE REDRAW (Nov 2026).** Settings rows put their help
behind ⓘ, show the key, mark a changed value with its default, and filter to
"Changed only"; unsaved work turns the foot bar navy. People & access selects
rows for bulk reset links, ended sessions and a CSV. Jobs opens on four
cadence lanes (late at twice the interval) and each job shows its last runs.
Integrations draws a card per service with **Test connection**
(`testConnection`, one read-only request with the stored key) and **requests
this month**, counted by `lib/integration-usage.ts` off Node's
`undici:request:*` diagnostics channel — started in `src/instrumentation.ts`,
so every outbound call is counted whichever library made it, flushed once a
minute into `integration_usage`. A count, never rupees. **The recycle bin holds
files, documents and announcements too**: `removeAttachment` keeps
`removed_parent_*` and the orphan sweep leaves such a file for
`attachments.removedRetentionDays` (90) before purging (`purged_at`); an HRMS
announcement is soft-deleted (`deleted_at`) and restoring sends it again. App
releases reads `releases.*MinimumVersion` and marks phones below it — a floor
the console reads; no handset acts on it until a build reads it.

**One home per screen.** The app registry was drawn twice (Apps → Registry,
Overview → Health), credentials lived in three places (Voice, Maps, Overview →
Integrations, which listed neither of the other two), sheet sync history in
three. Each is drawn once now: Home, Integrations, Sheets → Every sheet's
history. The Lead oversight page, which held only links into apps an
administrator may not hold, is gone; the Lead funnel settings page links to
where the funnel is audited.

**A SETTING LIVES ON THE PAGE OF THE APP THAT READS IT.** The console rendered
one schema, the CRM's, and a setting with no `PRESENTATION` entry fell onto a
tab called "Other" in a group called "Not yet placed". 254 of them had — every
field-app, ERP, lead-funnel, performance, sign-in and payments setting, shown
as the Telecaller CRM's while the Sales Dashboard and the ERP each said they
had nothing to configure. `settings-placement.ts` is a list of rules over the
key, first match wins, and `settings-placement.test.ts` fails on any setting
no rule places. An app with nothing to configure has no page at all.

**Every settings page saves.** Only the CRM's ever did: HRMS's Save button
said "not stored yet" and threw the change away, although
`updateConfigSettings` accepts any setting in the registry. `SettingsEditor`
is the one editor for all of them.

**`users.lastLoginAt` is written on sign-in.** Nothing wrote it, so every
screen asking when somebody last signed in answered "never" — which made the
console's list of never-used accounts accuse the entire company. Attendance is
the fallback for accounts that signed in before the column was filled: a day
recorded is a sign-in, whatever the column says.

**The design system is a console section, not a CRM screen.** It sat at
`/crm/components` with a link from the telecaller Help centre, which put a
build-facing handoff artifact one click from somebody working a calling queue.
Every component in every state is exactly what whoever writes the screens
needs, and exactly nothing to whoever uses them. It is `admin/components` now,
under For builders, where nobody working a queue will trip over it.

**Feedback is a conversation, not a note.** The Tell us button sits in the
header of every app, and what it writes lands in `feedback` — kind, heading,
detail, and the screen the person was standing on, captured rather than asked
for. Anybody signed in may write one, because a form the telecallers cannot
reach only ever hears from managers. Answering one is a manager's or a platform
admin's, checked in the action rather than by hiding the control, and it is
the same shape as everything else here: reads in
`lib/services/feedback-service.ts`, writes in `lib/actions/feedback.ts`.

**Every line of it is a row in `feedback_messages`, from either side.**
`feedback.admin_note` was a single overwritable cell: a second answer erased
the first, and the person who reported the fault could not say "not quite" —
which, for a bug report, is usually the sentence that solves it. Both sides
write through one action, `replyToFeedback`, because the two directions are
the same act and splitting them would give one conversation two sets of rules
about length, files and who gets told. `0032` carried every existing note in
as the message it always was, and refuses to run rather than lose one whose
author was never recorded.

**A status change is a line of the conversation too.** `statusTo` on a message
carries it, so "Not doing" sits in the thread beside the reply that explains
it rather than in a column somebody has to go and look at. A row that says
neither — no body, no status — is refused by a check constraint, because an
empty message notifies somebody about nothing.

**Both ends read the SAME thread.** One component, `components/feedback/
feedback-thread.tsx`, renders it in the Admin Console and on `/feedback`,
where the reporter reads the answer; what differs is only which side is "you".
A submitter shown a shorter version of the conversation they are in is how
somebody concludes nobody answered them, and stops reporting.

**Both ends are told.** A new report notifies whoever can triage it — managers
AND whoever holds the Admin app, exactly the set `canTriageFeedback` lets in,
because notifying fewer people than may answer is how a report sits unread in
front of the one person who could have fixed it. Every reply and every status
change notifies the other side, and the submitter's notification carries an
href to `/feedback`: a bell saying somebody answered, with nowhere to go and
read the answer, is what this was before. Nothing is ever deleted.

**A screenshot is part of the report, and it must be openable.** The Tell us
form and every reply take images, bound to `feedback` and `feedback_message`
respectively. Feedback is the one attachment parent with no customer behind
it, so `canRead` cannot fall through to a customer's scope — the two sides of
the thread may open the file and nobody else, asked once in
`lib/services/feedback-access.ts`. That file exists to keep attachments from
importing the feedback service while the feedback service imports attachments.

**Who may see and answer a thread is defined once.** `canSeeFeedback` and
`canTriageFeedback` live in `feedback-access.ts` and are read by the action,
the console's read-only banner and the attachment endpoint. Three copies of a
permission rule is how one of them ends up more generous than the others.

**Its vocabulary is client-safe, and separate from the service.**
`lib/feedback-labels.ts` holds the kinds, the statuses and their sentences,
because the form that writes them runs in the browser and the service that
reads them is `server-only`. `bug_reports` is the empty table this replaced —
nothing writes to it; do not start.

**FEEDBACK IS READ INSIDE THE APP, not on a page of its own (Nov 2026).** The
reporter's side was `/feedback`, a bare page outside every app with no header
or sidebar, which read as being thrown out of MahekOne. Each app with a
sidebar now has a **Feedback** page under Support (or its last group) —
`FEEDBACK_APP_PATHS`: the CRM, Accounts, the Sales Dashboard, the ERP, HRMS and
the HQ (the command centre) — all rendering `MyFeedbackPage`, and every one is
in `ALWAYS_OPEN_MODULES`, for the reason My tasks is: a reply has to be
readable wherever somebody is. `/feedback` FORWARDS (with `?r=`) to the first of
those apps they hold, which is why every notification links there — the link
has to work from any app's bell. Somebody holding none of them still reads it
there, in a plain frame.

**THE BUTTON IS A MENU, THE FORM ASKS LESS.** `FeedbackButton` carries the count
of unread replies, opens on Report a problem / Suggest an idea / Ask a question
(each opening `TellUsDialog` with its kind chosen) and the last three things
sent with their stage. The form is one box — `titleFromBody` makes the first
line the heading, so `title` is optional on `submitFeedback` — plus, for a
fault only, how much it is getting in the way (`feedback.impact`: blocking,
slows, minor), which orders the team's queue. Screenshots are captured
(`getDisplayMedia`, one frame, the dialog hidden by `body.fb-capturing`),
pasted or picked — `components/feedback/shots.tsx`.

**EVERY REPORT HAS A NUMBER.** `feedback.number` is a sequence; `feedbackRef`
reads it "FB-1042". It is what a notification, the console's search and a merge
name, never the id.

**SAME PROBLEM, ONE CONVERSATION.** `feedback.duplicate_of_id` points a report
at another. It keeps its own words and files and reads the other's status and
thread; everybody who reported it is on the REPORTER side of that one thread
(`reportersOf`, `canSeeFeedback`), each notified with a link to their own row.
One level only — `rootOf` resolves every join to the root, and a merge
re-points anything that had joined the merged report. The form offers open
reports that read the same (`similarFeedback`, pg_trgm) as somebody types; the
console merges by number. The console lists roots only, with the others under
"Also reported by".

**TEAM NOTES.** `feedback_messages.internal`: written by triage, read only in
the team's view (`withThreads(…, team)`), never notified to the reporter, and
never counted as an answer when deciding who owes whom.

**DONE CLOSES IT — Mahek's decision, Nov 2026.** Nobody waits for the reporter
to confirm. They are told and asked "Is it fixed for you?" (`answerFix`):
`fixed` is recorded in `feedback.verdict`; `still_happening` reopens it to
Being looked at and it comes back as owed. The queues (`triageQueue`, pure) are
Needs a reply / Waiting on them / Being looked at / Closed, decided per row by
the last line the REPORTER can read, and `feedbackCounts` counts through the
same function so a tab and its number cannot disagree. `assignFeedback` hands a
report only to somebody `triagerIds` names.

**A REPORT IS ASKED WHAT IT NEEDS BEFORE IT IS FIXED, and only code reaches
GitHub.** Most of what the team sends in is a wrong record, a setting, an
access grant or a question, fixed in minutes by the team; a developer handed
one finds there is nothing to change. `feedback_fixes` (`0326`) keeps, per
root report, its `need` — code_change, data_fix, setting, access, how_to,
not_a_fault — read by the AI after every new report (`after()` in
`submitFeedback`, `feedbackFix.*` settings) and overrulable by anybody
triaging (`need_decided_by_id`; the AI never writes over a person). Anything
but a code change opens "How the team can fix it" with the steps. A code
change is "Send to developer" (a GitHub issue through the `github.token`
credential) and "Ask Claude to fix", which only a PLATFORM ADMINISTRATOR may
press (checked in `askClaudeToFix`): it puts `feedbackFix.aiFixLabel` on the
issue and `.github/workflows/claude-fix.yml` runs Claude Code, which opens a
pull request a person reviews and merges. `lib/feedback-fix.ts` is the rule,
pure: what may be offered (`fixActions`), and `redact`, which takes phones,
emails, GSTIN, PAN and Aadhaar out of what goes to GitHub — customer names
stay, Mahek's call. The hourly `feedback-fixes` step reads each issue's
timeline for the pull request that mentions it and closes the report only
once GitHub's compare says the merge commit is in `MAHEK_BUILD`, the build
now serving — never at the merge — and tells everybody who reported it.

**CLAUDE IS ASKED BY ITSELF (Nov 2026).** Waiting for a platform
administrator to press "Ask Claude to fix" meant a code change sat as an issue
nobody acted on. `feedbackFix.autoFix` (on) sends it with no button:
`autoRequestAiFix` runs after every reading, after a person chooses "code
change", and in the hourly `feedback-fixes` step for anything still waiting
(`asked` in its result). `shouldAutoFix` (pure) is the rule — a person's "code
change" always goes; the AI's only at `feedbackFix.autoFixMinConfidence` (60)
or above. An automatic line of the thread has no presser, so it is written
under `automaticAuthor`: the assignee, else a platform admin, else a triager —
and closing a live fix falls back to the same. The model sometimes answers
confidence as 0–1 (FB-14 went to GitHub "1% sure"); `confidencePct` reads a
fraction as a percentage, on the way in and on old rows.

**The workflow's concurrency is on the JOB.** At the workflow level it was
taken before the job's `if`, so Claude's own first comment queued a run that
was going to be skipped and that cancelled the real one queued behind it.
Bot comments never trigger it now. Its first step checks `ANTHROPIC_API_KEY`
and says in words why Anthropic refused it — FB-14's run died in under a second
with nothing spent and the action said only `is_error: true`. Claude is told
opening the PR is its job (the action's own prompt says to leave a link), and a
last step opens one from the pushed branch if it did not.

**HQ'S SLUG IS /hq; ITS APP ID IS STILL `founder`.** The Founder Command
Centre was renamed HQ in every word a person reads (Nov 2026), and then its
URL moved too: `src/app/hq`, `/hq?s=<section>`, `/hq/price-lists`,
`/hq/whatsapp`, `/hq/margins`, `/hq/my-tasks`, `/hq/feedback`. `next.config.ts`
redirects `/founder` and `/founder/:path*` to the same path under `/hq`
permanently, so bookmarks and the links already stored in notifications,
tasks and automations keep landing. The app id `founder` was deliberately
NOT renamed: it is a Postgres enum value held in every `app_access` grant,
every `founder.*` module key, audit rows and settings, and nobody sees it.
`app-routes.ts` maps `/hq` to it; tests that walk `src/app/<folder>` list the
folder `hq`, not the id.
