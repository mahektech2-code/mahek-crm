# Handset sync wire, tombstones, schema contract

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**A DELTA MUST SEND WHAT THE BOOTSTRAP SENDS, and the only way to be sure of
that is for it to be the same function.** The customers channel was two
queries — `customersForDevice` at sign-in and an anonymous `sql` template
inside `buildPull` — and they had drifted eleven columns apart: `thirdParty`,
`cycleDays`, `gstin`, `dealerCode`, `territoryRegion`, `customerType`,
`potential`, `creditDays`, `visitFrequencyDays`, `gpsAccuracyM` and the
`distributors` list, plus `healthBand`, which is in neither SELECT and is
computed by `bandFor` on the way out of the bootstrap alone.

**A MISSING COLUMN IS NOT A NULL, WHICH IS WHY IT LOOKED LIKE NOTHING.**
`upsert` writes exactly the columns that ARRIVE, so an omitted one is not
written over — the bootstrap's value sits on the row being right about the day
the salesman signed in and wrong from then on. `pullCursor` is set once in
`sync/engine.ts` and cleared nowhere: not by a migration, not by an app
upgrade. So "then on" is the life of the installation, and a column added for a
new screen reached a handset only if its owner happened to sign out and back
in. It cost three things on the customers card — the "Third party" chip, the
status dot and its word, and the reorder line — so a shop marked third-party in
the office on Tuesday still read as an ordinary customer, and a customer who
went dormant in March still read Active.

**`mbos-wire.test.ts` could not have caught it, and its `DELTA` list says so in
its own comment.** That test asks whether a payload sends something the handset
CANNOT HOLD — an extra column, which throws and takes the whole pull with it.
It cannot ask the opposite, because a column the delta merely omits is not a
fault in any file, it is an absence, and an absence has to be measured against
a second list. Retiring an entry from `DELTA` is therefore the goal rather than
a chore: an entry leaves that list exactly when its channel starts calling the
function the bootstrap calls, and at that point the `WIRE` entry above covers
both. Three have left. The 2,000 cap and the `updated_at` ordering stay on the
IDS, which is the half that has to be ordered — the cap must take the oldest
changes first, or the ones it drops are never asked for again.

**A pull says what exists; only a tombstone says what stopped.** A deleted row
has no `updated_at` for a delta to notice, so without `mbos_deletions` a
withdrawn document, a removed stop and a reassigned customer sit on the handset
for ever — and the salesman walks to a shop that is not his any more with
nothing anywhere looking wrong. It is reference data only: nothing he authored
is ever deleted by a sync, not a rejected order and not a visit that lost a
conflict. `user_id` null means everybody, which is what a withdrawn product is.

**A CONVERSION TOMBSTONES THE LEAD, because the leads channel just stops.**
The handset holds a lead in `customers` AND in `leads`, and asks "is this a
lead" of the second. The channel sends only leads that are not `won` or
`lost`, so a lead that converted simply stopped being mentioned — and stayed
on the phone at its last rung for the life of the installation, under Leads,
opening the funnel for a shop accounts were already billing. Nothing on the
server was wrong: the customer row arrived with `kind` moved. `recordConversion`
is the one place every conversion passes, so it writes a `leads` tombstone
there (never `customers` — the shop stays in his book), and the handset
ARCHIVES it, so anything still queued against it reaches the office.
`0215_converted_leads_leave_handsets` wrote the ones earlier conversions owed.

**A REPLAN IS A DELETE, so it tombstones.** Both the handset's own pick and
the office's replan delete the planned stops and write new ones under new ids.
Without a `journey_stops` tombstone for each, the phone kept every old stop
beside its replacement: the day doubled, unpicked shops stayed on it, and
"x of N done" counted both. A shop already visited or skipped keeps its stop
and is not added again when re-picked.

**The price list is replaced wholesale, and everything else is upserted.** A
rate that was withdrawn has to disappear, and a per-row upsert leaves it behind
— an order priced from a rate nobody sells at. It is a few hundred rows of three
columns; a delta would save nothing worth the way it fails.

**THE HANDSET'S SCHEMA IS THE WIRE CONTRACT, and one extra column empties the
phone.** `applyPull` upserts a pulled row by writing exactly the columns that
arrived — `INSERT INTO customers (<every key in the payload>)` — so a field the
server knows about and the handset has no place for throws on an unknown
column. It is ONE transaction, so that throw rolls back the whole pull: not the
customers, the pull. Products, the price list, the timeline, the journey, the
configuration, all of it. Seven of the ten pulled tables disagreed —
`customersForDevice` alone sent eleven columns that had nowhere to land — so no
MBOS handset had ever received a single row of reference data, on any build,
since the app shipped. What made it invisible is that everything a salesman
AUTHORS goes up perfectly: check-ins, visits, orders, the trail and the Live
map all worked, and only the book was empty.

**And the second half of the silence was in the sign-in.** `signIn` applies the
bootstrap inside the same `try` that wraps the network call, so the SQLite
error fell to a catch that reads "not an `ApiError`, therefore no answer at
all" and went down the OFFLINE path — which succeeds, because
`rememberForOffline` ran three lines earlier. The salesman was signed in
against an empty database with nothing on the screen to say so. A local
storage failure is now its own answer: `payload`, the fifth of the five checks
that screen already names.

**So the payload is trimmed to the handset, never the handset widened to the
payload.** An APK cannot be recalled — the server has to be able to move first,
and a phone in somebody's pocket cannot. `upsert` drops a column this build
does not know about rather than refusing the row, which is the same trade in
the other direction: a field the screens cannot read costs nothing, and
refusing it costs the book. `src/lib/mbos-wire.test.ts` reads both files as
text and pins it, because nothing else can — the server's SQL is a string, the
handset's schema is a string in a project `tsconfig.json` excludes, and the two
are joined only inside a phone. It type-checks, it lints, the integration tests
pass, and it is wrong.

**A FUNCTION WITH NO CALLER IS A FEATURE NOBODY CAN USE, and nothing was
checking for one.** An exported function that nothing imports is legal
TypeScript and clean lint — it is exported, so no unused-symbol rule fires, and
`tsc` has no opinion about who imports it. So a feature can be finished in
`data/`, given a server handler, given a wire payload, pass every test in the
suite, and simply have no screen. Nothing goes red and nothing looks wrong.
`markDeposited` and `markBounced` were complete on both ends for months with no
button anywhere, so cash in hand could only ever grow and a bounced cheque
could not be reported at all; `listTours` meant a salesman asked to work away
for a week and the manager's answer reached his phone, was stored, and was
never shown to him. `validationsFor`, `listOrders`, `listPayments`, `touchLead`
and `daysAwaitingAnswer` were the same shape. `mbos-app/src/data/reachable.test.ts`
asserts every export in `data/` is named somewhere outside its own definition,
with a `PARKED` allowlist that takes a REASON — the alternative is not "no
allowlist", it is the list this app already had, held nowhere and known to
nobody. It proves a function is reached, never that the path is one a person
can walk; the cheap half is what was missing.

**And a handler the handset never calls is the same bug across the wire.**
`dispatchItem` is the whole list of things a salesman can send us, and a `case`
with no matching `entityType:` on the handset means the server half shipped and
the phone half never arrived — both compile perfectly alone. `internal_note`
sat like that from the day the module shipped: §R had a table, a role list and
a bootstrap that narrowed by role, and `handleInternalNote` waited for a
payload nothing sent, so it was a read path over a table nothing could put a
row in. `mbos-wire.test.ts` now reads the dispatcher against the handset's
writes and fails on either direction, with a `SERVER_ONLY` map for the cases
where "the office sends this one" is the honest answer.

**A HAND-ROLLED HANDLER CANNOT THROW, and that is the trap rather than the
safety.** Three tables — `tasks`, `leads`, `samples` — are written by a handler
that types its column list out, because none of them is the same word twice on
the two sides: `companyName` is `company`, a lower-case `won` is `Converted`,
one note field is a list, and a sample's `state` is not on the wire at all. A
typed list cannot fail on an unknown column, so a field the handler READS and
the server never sends is simply `undefined` — and the `ON CONFLICT` clause
then writes that NULL over whatever was there. `upsertTasks` read
`completionNote`, `completionPhotoId` and `escalatedAt`, none of which were on
the wire, so every pull erased the note and the photograph off any task the
salesman had completed. Nothing failed, nothing logged, and the loss looked
like the salesman never wrote one.

**Leads and samples are the two OWNED tables with an office end, so a pull may
not overwrite what the outbox still holds.** They were on the bootstrap from
the day it was written, on no delta at all, and applied nowhere — so a lead
raised at a desk reached the phone only on a fresh sign-in, and in practice
never. They come down on every pass now, like `journeyStops` and `tasks`, and
they land under `where syncState = 'synced'`: a queued row is one this handset
has said something about and the office has not heard yet, so the local answer
is the newer fact and it stands until it is sent. The note list is written on
INSERT only, because it is APPENDED to locally and the wire carries one
flattened string — restating it every pass would replace a salesman's own notes
with the office's rendering of them.

**And a date off the wire is not an instant until something names the
midnight.** The fourth spelling of the rule, in JavaScript on a handset:
`Date.parse('2026-09-08')` is specified to read a date-only string as UTC, so a
`requestedDate` lands five and a half hours before the day it names. It is
invisible in IST, where it still formats to the right date, and wrong the
moment anything compares it to a local day boundary. `localInstant` spells a
date as local midnight and leaves a full ISO instant alone, because that one
carries its own zone.

**A parameter is a string, not a Date.** `postgres` serialises a JS Date by
asking Node to measure it as text, and on Node 25 that throws — inside the
driver, where no type check sees it. Every query in the MBOS pull delta carried
the cursor, so every one of them failed and the whole pull answered 500 the
moment a handset had a cursor; bootstrap passes no Date at all, which is exactly
why sign-in worked and syncing after it did not. An ISO instant carries its own
zone, so this is not the bare-cast rule in different clothes.

**A NUMBER SUBTRACTED FROM A DATE NEEDS ITS TYPE SAID OUT LOUD, and this one
took the whole delta down again.** Same endpoint, same 500, a different cause,
and it outlived the fix above: `p.plan_date >= (now() at time zone $tz)::date -
$days`. `$days` is a bind parameter and an untyped parameter beside a date lets
Postgres resolve the subtraction as `date - date` — which yields an integer, so
`date >= integer` has no operator and the query throws. `buildPull` ran two of
these inside its `Promise.all`, so the rejection took every other channel with
it: the journey, the customers, the products, the tasks, the price list, all of
it, on every pull from a handset holding a cursor. Which is every pull after
sign-in, because the bootstrap is what issues the first one. `::int` on the
parameter is the whole fix and `planDaysFor` is the one copy of it.

**And NOTHING HAD EVER EXECUTED `buildPull`** — that is why both of these
lived there. The wire test reads the file as TEXT to compare column names
against the handset's schema, which is a real check and cannot see a query that
throws; `buildBootstrap` was exercised and the delta was not. Correct columns
in a query nothing runs is exactly the state it was in for both bugs. There is
a test in `activity-location.test.ts` that RUNS the delta with a cursor now,
asserts every channel the handset applies came back as an array, and puts a
real plan day and stop through it. Its point is not the date arithmetic: it is
that the next query which only fails at the database fails there rather than on
a phone in Nagpur.

**And it came back, in the order handler, where it failed differently.**
`handleOrder` bound `orderedAt` — a Date — into both `update customers set
last_order_date …` statements, so EVERY field order was refused with a
`Failed query` message and came back as a **retry** rather than a rejection.
That is the worse of the two shapes: the outbox resends for ever, the salesman
sees an order that never lands, and nothing on either end names the cause. It
was found by the first test to send a real order payload through the handler,
which is the point — the rule is invisible until something actually binds a
Date, and no type check will ever see it. Grep for `${` followed by a Date
before adding a raw query, and pass `.toISOString()`.

**And it was in the visit handler too, where it cost the whole day.**
`handleVisit` bound `checkInAt` into the derived `last_visit_date` and into
the journey stop, so every visit came back as a **retry** — and a visit is the
DEPENDENCY of the order and the payment taken on it, so the order and the
payment never went either. A salesman's whole day sat in the outbox behind a
record that would never land, with the office seeing nothing and the handset
saying only that it was still trying. It was found by sending a real visit
payload through the HTTP endpoint rather than the service, which is the only
way any of these three ever show up.

**EVERY CAPPED CHANNEL HOLDS THE CURSOR, and the clamp list is where that is
said.** Tasks and the journey were capped at 500 and in neither
`nextPullCursorAt` list, so a manager reassigning 600 tasks put 100 behind the
cursor for good. Both are clamped now (`TASKS_PER_PULL`,
`JOURNEY_STOPS_PER_PULL`), and so is the new `myComplaints` channel. A capped
channel has to be ordered by its change time or its last row is not the newest
change it sent — the journey was ordered by day and is ordered by
`greatest(s.updated_at, p.updated_at)` now, with `updatedAt` stripped before it
goes (the `stripped` entry in the wire test's `DELTA`). `pull-cursor.test.ts`
reads the clamp list as text.

**A PULL THAT THROWS AFTER INGEST STILL ANSWERS THE RESULTS.** The items are
already written by then; a 500 made the handset count each one as a failure
and resend it towards `failed`. `/api/mbos/sync` catches round `buildPull`,
logs it, and answers `pull: null` — the handset keeps its cursor.

**THE OUTBOX'S HOUSEKEEPING IS `sync/outbox-ops.ts`, with the database passed
in**, so it runs against the real migrations under `tsx --test`
(`outbox-ops.test.ts`). `ENTITY_TABLE` lives there now. Its rules:

- **Letting a create go takes everything waiting on it.** Not accepted lists
  rejected, failed AND blocked entries; Remove on a create removes every entry
  blocked behind it (the approval of a refused leave, the payment against a
  refused order, an edit to the record itself) and their local records, and
  the confirm says how many go with it. They were blocked for ever and counted
  against the handover with nothing able to clear them.
- **A refused edit puts the phone's copy back.** `updateAndQueue` keeps the
  columns it changed, as they were, in `kv` (`prev:<queue id>`);
  `markRejected` and Remove restore them, Send again re-applies them. A task
  refused as Done comes back open even with no snapshot (an edit from an older
  build). Skipped while a later edit to the record is still waiting.
- **An edit waits on its own create while the create is in the outbox.** An
  edit that overtook its create was answered "retry"; one made after the create
  was refused was retried for ever. `presumedLanded` (in `ordering.ts`) is why
  this is safe: an edit that waits on its own record is not counted as the
  record "waiting", so once the create is pruned the edit is not waiting on
  itself.
- **Stuck work stops counting at handover after
  `mbos.sync.handoverIgnoreDays`** (14). Queued and in-flight work always
  counts; failed and blocked entries older than that do not, and the Sync
  screen says how many it is ignoring.
- **A row and its outbox item are one transaction.** `insertAndQueue`,
  `updateAndQueue`, `saveOrder` and `collectPayment` read the location first
  (`whereNow`, then `enqueue({ where })`) and write both inside `tx()`. `tx()`
  does not nest, so a write called from inside another save's transaction
  passes `inTransaction: true` — the visit's follow-up task and the order's
  approval do. A write added inside a `tx()` body without it waits on itself.
- **A record a crash left saved and never queued** (an older build) is marked
  `failed` with "Saved on this phone but never sent" by `sweepOrphans` on cold
  start — not re-queued, because the payload is the row plus the wire's own
  spellings, which the row cannot rebuild.

**Complaints have a delta channel: `myComplaints`**, `{ id, status }` from
`myComplaintStates`, the same function for bootstrap and delta, applied as an
UPDATE under `noPending` (a row the phone does not hold is not created). The
badge reads `syncBadge` first and the office's word second
(`sync/labels.ts`), so a refused complaint says Not accepted, never Open.

**`notification_read` is an entity**: tapping a push (and opening one on the
bell) marks the office's copy read too. The handler only ever touches the
sender's own row and always accepts.
