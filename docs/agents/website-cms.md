# Website CMS and review workflow

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**The Website app edits mahekindia.com's content, and an employee's edit reaches
the public only after somebody else has read it.** Content is `website_content`:
`data` is the working copy and `published_data` the live one, and saving only ever
touches the first. The working guide — the Access-screen steps, what turning
enforcement on does to people who edit today, the rollout order and what cannot be
rolled back — is `docs/website-review-workflow.md`. What follows is why the code is
shaped the way it is.

**TWO RIGHTS NOTHING IMPLIES.** `website.publish` is the right to make a change
live; `website.review` is the right to assign work, decide a submission and switch
enforcement. Both are `explicitOnly` modules: not carried by a whole-app grant, by
an administrator hat, by a migration or by a script — ticked, for a named person,
on the Access screen. No migration writes either to anybody, and no code names a
person: "Pritesh" appears nowhere. A person holding *neither* and an ordinary kind
module (Products, Pages…) is an **employee**: they edit and submit, and cannot
publish. Somebody holding `website.publish` keeps editing and publishing exactly as
before, and enforcement never touches them.

**ASSIGNMENTS ARE OFF UNTIL SOMEBODY TURNS THEM ON, and a missing setting row means
off.** `website_review_setting` is one row, `site`, in its own table rather than
`app_settings` — settings are edited by anybody holding `config.write`, and this is
a decision given to `website.review` holders alone, the reason the WhatsApp switch
is its own table. It is off at deploy, so nobody who edits today loses anything. The
row points at a user, so truncating `users` empties it; `assignmentsEnforced()`
answers false for no row rather than true, because the other answer locks every
editor out at once.

**ONE RULE FOR WHAT A PERSON MAY DO AND WHAT THEY ARE SHOWN.** `gateEdit(kind,
scope)` refuses an edit by somebody not assigned; `makeScope` in
`review-scope.ts` decides what they are *shown*. Both read the same rule
(`anyAssignmentCovers`, `hasKindWideAssignment`), because an editor offered a thing
the server then refuses is a nuisance and an editor shown another person's draft, a
name or a count is a leak. `gateEdit` takes its scope **required, never defaulted**
— "may this person edit products" asked without saying which item is how an
assignment gets skipped — and a static test fails on any call that omits it.
Creating needs a **whole-kind** assignment (an unborn item has no row to name), and
so does reordering, which renumbers every sibling and is published with the list.

**A SUBMISSION FREEZES, AND AN APPROVAL COVERS EXACTLY WHAT WAS FROZEN.**
`submitChange` locks the rows `FOR UPDATE` in id order and stores, per item, what was
live, the working copy, its sha256 of stable-key-sorted JSON (`stableStringify`, the
helper behind `revisionOf`) and the version. `publishApproved` re-reads every row,
locked, and compares **both** the version and the hash; one difference closes the
request as `stale`, publishes nothing and tells the employee. A version alone is not
enough (an import or a discard can leave the same number behind different content),
and content alone cannot say why it moved. Saves, discards and deletes of an item in
an open request are **refused**, not tolerated-and-staled: the reviewer is reading a
frozen copy, and the editor's fields are `disabled` rather than only Save, so nobody
types into a box the server will refuse.

**AN ITEM IS IN AT MOST ONE OPEN REQUEST, and the database says so.**
`website_change_item.open_content_id` equals `content_id` while its request is
`submitted` or `approved` and is null otherwise, with a unique index over the non-null
values — a partial unique index cannot look at another table's status, so the column
carries it. `closeRequest` is the **one** function that ends a request without
publishing it (rejected, revoked, expired, stale, withdrawn): it checks the move
against the transition table, clears the column, writes the audit row and queues the
message, in the caller's transaction. Publishing clears it inline for the same
reason. Two submissions racing for one item cannot both win; a test runs them.

**`publishApproved` IS THE ONLY WAY AN EMPLOYEE PUBLISHES, and it is not a way round
`gatePublish`.** It takes a request and no item ids, refuses unless the request is
approved and unexpired and the caller is its submitter (still holding the module of
every kind in it) or a reviewer, and publishes exactly the request's items. It does
**not** call `transitionItems`, `publishPending` or `syncPublishedOrder`: the last
would publish the working order of the whole kind, and with it somebody else's
unreviewed reordering. A new item gets its own `published_sort` (its position) and
no sibling is touched. Unpublish, archive, restore, import, refresh and "publish
everything" still ask for `website.publish`; `website-routes.test.ts` fails if any
of them stops. Reviewers have **no publish-on-behalf button** — the server allows a
reviewer to publish, the screens do not offer it, so the person who submitted is
the one who puts it live.

**NOBODY DECIDES THEIR OWN WORK, in three places.** The service refuses, and a CHECK
on `website_change_request` (`reviewer_id <> submitter_id`) refuses whatever code
writes the row, and a reviewer who submits their own change gets the others told and
not themselves. A rejection without a non-blank reason is refused by the service and
by a CHECK; an approval carries its reviewer, time and expiry by CHECK.

**EVERY CHANGE WRITES ITS AUDIT ROW IN ITS OWN TRANSACTION.** `audit(tx, …)` sits
beside the update, so there is no moment where the change exists and the record of
it does not; a test reads the service and fails on an audit written outside a
transaction other than the denial record. A **refusal** is also worth remembering —
`website.access.denied` carries who and what they attempted — and is written on its
own, never allowed to fail the refusal it describes. Codes are `website.review.*` and
`website.assignment.*`, each with a sentence in `audit-labels.ts`.

**NOTIFICATIONS ARE A COURTESY AFTER THE COMMIT.** `review-notify.ts` is told, by
`closeRequest` and the service functions, what to send, and `runAfterCommit` sends it
once the transaction has committed, each isolated: a failure is logged and swallowed,
and a rolled-back change tells nobody. Recipients are exactly the people with
something to do — the employee on assignment, every active `website.review` holder
with the Website app (but not the submitter) on submission, the submitter on
approval, rejection (reason in the message), revocation, expiry and a voided
approval — and a test reads the whole `notifications` table so an extra recipient
fails it. Links all begin `/website/`, which is what files them under the Website's
bell, and the app header carries that bell: a message nobody can see is a decision
nobody receives. A test breaks the table on purpose and proves nothing in the
workflow changes.

**THE LAUNCHER TILE COUNTS WHAT ITS SENTENCE SAYS.** A reviewer's badge is requests
waiting; an employee's is approved changes ready to publish plus requests sent back
to them; somebody who is both sees both. An approval past its seven days that no job
has swept is counted as sent back, never as ready — the tile must not say publish what
the server would refuse. `launcherCounts` is three counts, no sweep: it is the home
screen.

**SEVEN DAYS IS A RULE, AND AN HOURLY STEP ENFORCES IT.** A lapsed approval is refused
at publish time whether or not anything has run; `website-review-expiry`, a step of
`runHourly` (by hand: `npm run jobs -- website-review-expiry`), moves lapsed ones to
`expired`, frees their items and tells the employee. Without it an approval nobody
tries to use would hold its items for ever.

**NO "REMOVE" IN V1.** A submission is an *add* or an *edit*. Taking something down
is `website.publish`'s: a removal has no row left to freeze, and the CHECK on
`website_change_item.action` says so.

**TEXT AND CHECK, NOT ENUMS, in `0274_website_review_workflow`.** A value added to a
Postgres enum cannot be used in the transaction that adds it, and drizzle runs every
pending migration in one. `review-status.ts` states the allowed statuses and kinds
once and `review-logic.test.ts` reads the migration and fails if the two drift.

**A PROSPECT NEEDS ALL SEVEN ANSWERS, EACH A REAL ONE, ON EVERY DOOR.** Business
type, monthly litres, competitor, product, contact person, next action and the
coded reason. `lib/engines/lead-prospect-answers.ts` is the one reading of what
makes each an answer: the record page's Convert dialog draws its field errors
from it, `preparePromotion` refuses on it (so `convertLeadToProspect` and
`requestProspect` both do, whichever way `leads.callingDeskDirectPromotion` is
set), and `evaluateLeadStageMove` refuses on it for every other route — the
stage button, the verification, the board, the handset. The gate's own `has()`
calls any finite number an answer (zero litres passed it), which is why this is
stricter. For a Prospect, and only for a Prospect, two of the gate's escape
hatches are shut: a manager's override, and `leads.requireNextAction` switched
off. A value already on the record counts while it is valid and is never
overwritten by what the dialog supplies; an invalid one yields to it. The next
step the person types is kept on the audit row and the timeline, not in the
lead's next-action slot, because that slot becomes the Sales Manager's
verification call on conversion, exactly as before.

**A SAVE THAT DID NOTHING, AND WORKED AFTER A REFRESH, WAS A DEPLOY.** Two
causes, both on the same day as every deploy, and with hundreds of people
working at once there is always somebody mid-save. First, Next names every
Server Action by an id it salts with a key it made up fresh for each build, so
every id changed on every deploy — whether its code had or not — and a tab
open across one posted ids the new server had never heard of. Next refuses
those with a 404, and the ERP dialogs awaited the call with no catch, so the
button sat busy with nothing on the screen. Second, `restart.sh` recreates the
one app container, and for the seconds between the old one stopping and the
new one listening every request was a 502.

So: the build passes a fixed `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` (a GitHub
secret, mounted into the Docker build as a SECRET and never an ARG, because an
ARG is in the image history), and an id now moves only when its own file does.
Caddy's `lb_try_duration` holds a request it cannot connect with and retries
until the new container answers — only a request it never sent, so no POST
runs twice. `VersionGuard` in the root layout asks `/api/version` when a tab
comes back into view and on a jittered few minutes, reloads an IDLE tab that is
behind (never one with a dialog open or focus in a field), and where a save was
refused anyway says so in words over whatever the screen did. And
`safeKit` turns a thrown action into an `Err` every ERP and HRMS dialog
already draws. `lib/version-skew.ts` is the vocabulary the three share.

**Caddyfile and docker-compose.yml are NOT shipped by a deploy.** They live on
the droplet at /opt/mahekone and are copied by hand; a change to either here
does nothing until it is copied up and Caddy reloaded.

**A CATALOGUE EDIT STICKS, AND IT REACHES EVERYTHING.** Every deploy runs the
catalogue import (`catalogue:deploy`), and it used to write the generated seed
back over any SKU, finished good, brand or formulation that differed —
packing, cans per box, weight, packing cost, and where each is filed — and to
find the upper levels by slug, so a level renamed in the Admin Console would
have been created again under its old name. No harm had landed only because
every console edit so far happened to match the seed. Now a console edit sets
`edited_at` and the import leaves that row alone (reported as `kept`), and a
rename keeps the old slug in `former_slugs` so the import still finds it.

The formulation is stored three times — brand, finished good, SKU — and the
ERP's FG filling reads it off the FINISHED GOOD, so `moveBrandLine` and
`moveFinishedGood` write all of them in one transaction. The handset pulls
SKUs by their own `updated_at` and shows brand and formulation by name, so a
rename, retire or move of a level touches every SKU under it. Catalogue saves
revalidate every app, not just the console and the CRM, and drop the
reference cache. What deliberately does NOT move: fills, stock, orders and
bills already made keep what they were made against.
