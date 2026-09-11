# DESIGN.md

This is the pattern reference for MahekOne. `AGENTS.md` is the CRM's own
design record — narrative, specific, full of *why*. This file is the
distillation: the architectural rules that are not particular to the CRM and
that every app added under "Adding the next MahekOne app" in `AGENTS.md`
should follow **by default**, without re-deriving them from scratch or
re-reading three thousand lines to find them.

Read this before writing the first line of a new app. Read `AGENTS.md` for
the CRM's actual business rules — this file borrows its examples from there,
but every rule below is stated at the altitude of "any app on this schema,"
not "the CRM specifically." Where a rule only makes sense for the CRM's own
domain (buying cycles, quiet windows, mix categories), it is deliberately
left out of this file — those live in `AGENTS.md` and stay there.

---

## 0. The one-sentence version

**One database, one login, one design system, many apps** — and the four-way
split of engines (pure rules) / services (rules + data) / actions+queries
(the only doors in and out) / screens (dumb) is what keeps that promise from
rotting the day a second app is added.

---

## 1. Layered architecture

```
lib/engines/    pure functions — rules, no I/O, no clock, no database
lib/services/   engines wired to data — one file per module/domain
lib/queries.ts  every scope-aware READ, in one file
lib/actions/    every WRITE, one file per module, one Server Action per verb
src/app/<app>/  screens — Server Components + thin Server Actions calling lib/
```

**The dependency direction is one-way and it is not optional**: screens call
`lib/queries.ts` and `lib/actions/*`; actions and queries call
`lib/services/*`; services call `lib/engines/*` and the database. An engine
never imports a service. A screen never queries the database directly. A
service never renders anything or knows what a Server Action's return shape
looks like.

Why this specific split rather than "put it in a `utils` folder": each layer
answers a different question and gets a different kind of test.

| Layer | Answers | Tested by |
|---|---|---|
| `engines/` | "given these facts, what is the rule's answer?" | `*.test.ts`, pure, no DB, runs in milliseconds |
| `services/` | "what is the answer, right now, for this data?" | integration tests against a real (test) database |
| `actions/` `queries.ts` | "who is allowed to ask, and what do they get back?" | integration tests, capability/scope assertions |
| `src/app/**` | "how does a person see and act on the answer?" | manual / browser verification |

A bug that lives in the wrong layer is a bug that cannot be tested cheaply.
If you find yourself writing a unit test that spins up a database to check a
threshold comparison, the comparison belongs in an engine and you copied it
into a service by mistake.

---

## 2. The engine pattern

An engine is a **pure function**: it takes configuration, the business date
(or other explicit inputs), and data already fetched — and returns an
answer. No `db` import, no `fetch`, no `new Date()`, no reading `app_settings`
itself.

```ts
// lib/engines/<name>.ts
export function decideSomething(
  input: SomethingInput,
  config: SomethingConfig,
  today: string, // business date, passed in — never computed here
): SomethingResult {
  // ...
}
```

Rules for engines:

- **No I/O, ever.** If it needs a row, the caller (a service) fetches the row
  and passes it in. This is what makes `npm run test` fast enough to run on
  every save and honest enough to pin the actual rule rather than an
  approximation of it.
- **No clock reads.** `Date.now()` / `new Date()` inside an engine (or inside
  any component body, per the React Compiler rule in §12) is a bug. The
  caller passes the date down.
- **One engine, one rule family.** `lib/engines/queue.ts`,
  `lib/engines/allocation.ts`, `lib/engines/next-step.ts` are examples from
  the CRM — each answers one question and nothing adjacent. A second engine
  re-deriving a decision the first one already makes (as opposed to calling
  it) is a copy that will drift within a release.
- **Every business threshold is a parameter, not a literal.** See §4.
- **Every engine gets a `*.test.ts` beside it**, and the tests pin the rule
  itself — not just "does it run" but "given exactly these inputs, is this
  exactly the answer," including the edge cases (a null/missing value, a
  boundary date, a tie).

When a screen needs to explain *what will happen next* (a confirmation
message, a predicted date), that explanation should be produced by asking the
engine the question directly (e.g. "is this in the result set for day N")
rather than re-implementing the engine's logic in the screen or in a second,
simplified copy of the rule. A UI-facing explainer engine that wraps the real
one (see `next-step.ts` in the CRM) is the right shape when the two callers
need different granularity.

---

## 3. Reads vs writes: one file each

**All scope-aware reads live in `lib/queries.ts`. All writes live in
`lib/actions/<module>.ts`.** This is not a style preference — it is what
guarantees that a number shown on a dashboard and the same number shown on
its own detail screen were computed by calling the *same* function. Two
screens that each write their own `select` for "this customer's outstanding
balance" will eventually disagree, and nobody will notice until someone is
on the phone with a customer holding a different figure.

- A Server Action is a URL. Anyone who can reach `/app/whatever` can, in
  principle, call the action directly with a crafted payload. **Every
  permission and scope check happens inside the action/query function
  itself**, never only in the component that renders the button. A disabled
  button is a UX courtesy, not a security boundary — see §6.
- A `page.tsx` (Server Component) calls a query function and passes the
  result down. It does not run SQL itself, so there is only one place a
  scope bug can hide.
- Money-affecting or state-affecting work that must succeed or fail as one
  unit (an interaction plus the order/reminder/complaint it produces plus the
  cached rollups it invalidates) is **one transaction, in one action
  function** — never a sequence of separate awaited calls from the screen
  that can leave a half-done write if the second call fails.

---

## 4. Configuration over constants

**Nothing business-critical is a hardcoded number, string list, or literal
threshold.** If a manager might plausibly want to change it without a
deploy, it belongs in `lib/config/registry.ts` (the schema + validation) and
is stored in `app_settings`. Reads go through `getConfig()`, cached briefly
(30s in the CRM) so a save takes effect almost immediately without hitting
the settings table on every request.

This generalizes past numeric thresholds:

- **A list of modes/categories/statuses that a person picks from on a form is
  configuration, not a hardcoded array.** Three different screens each typing
  out `["Cash", "Cheque", "UPI", ...]` is how one of them silently drifts
  from the other two the day a mode is added. One shared component reads the
  registry (`components/crm/payment-mode-fields.tsx` is the CRM's example);
  it is written once and every screen that needs the list imports it.
- **A weight, a percentage, a grace period, a cap, a window length** — all
  configuration. A migration that changes a default only touches rows that
  have never been explicitly set (`updated_by_id is null`), so a team that
  already curated its own value is left alone.
- Where two settings must agree with each other for the system to behave
  consistently (a window length and the threshold that reads as "past the
  window"), write a `checkConsistency()` assertion rather than trusting two
  independent screens to be edited in lockstep.
- A product/customer/status list that could be queried from the database is
  **never** typed as a literal anywhere — in the app, the console, or a seed
  script. If it's real data, it's a query.

---

## 5. Data conventions

### 5.1 Money is an integer, always

Store and pass money as **paise** (or your currency's smallest unit) as an
integer. Format to a display string only in one place on the way to the
screen (`lib/format.ts` in the CRM). Never store a float, never store rupees.
A total is a `sum()` of integer lines, not a running float accumulator.

### 5.2 Name the timezone at every stored-instant → date boundary

This is the single most repeated bug class in the codebase and it looks
different every time it shows up, which is exactly why it keeps shipping.
There are three distinct shapes, and a new app should have a grep-based test
guarding all three from day one (see §13):

1. **SQL: casting a `timestamptz` to a date.** `ordered_at::date` reads in
   the *session's* timezone, not a fixed one. Always write
   `(ordered_at at time zone '<zone>')::date` (or the equivalent for your
   configured `APP_TIMEZONE`), never a bare cast.
2. **SQL: casting a `date` column to an instant.** The mirror-image bug —
   `bill_date::timestamptz` is evaluated in the session's zone too. Use
   `bill_date::timestamp at time zone '<zone>'`.
3. **JavaScript: truncating a `Date` to a day.**
   `someTimestamp.toISOString().slice(0, 10)` and any bare `getHours()` /
   `getDate()` / `getMonth()` call answer in whatever zone the process
   happens to be running in — which is your laptop's zone in development and
   the deploy platform's zone (commonly UTC) in production. This is why it
   passes locally and fails only after deploy. Write one helper
   (`calendarDate()`, `stamp()`, `stampDate()` in the CRM) that names the
   zone explicitly, and never call the native getters directly in `src/`.

The general rule beneath all three: **a stored instant is not a wall-clock
answer, and a stored date is not an instant, until something names the
zone.** Whichever zone your local Postgres happens to be configured to will
silently agree with your code and hide the bug in development — that is not
evidence the code is correct, it is exactly the condition the rule exists
for.

### 5.3 Derived values are never hand-edited

Anything computed from other rows (a rollup, a cached "last contact" date, a
flag derived from a threshold) is a **cache**, not a fact. If it's wrong, the
fix is to re-run the function that builds it — never to `UPDATE` the row by
hand. `lib/recompute.ts` is the one place these rebuilds live; every write
path that changes an input calls the matching recompute function as part of
its transaction, and there is always a hand-triggerable version for backfills
and incident recovery (`npm run jobs -- ...` in the CRM).

A derived value is different in kind from a **decided mark** — see §9 — which
records that a *person* made a call at a *point in time*. A cache is rebuilt
freely; a decided mark is written once and later passes must not overwrite
it. Confusing the two is how a scheduled sync quietly reverses a human
decision (see §8).

### 5.4 Deactivate, never delete

Anything that other rows can reference (a product, a quick-note option, a
person, a customer) is soft-retired: an `active` flag, or a `status` column
that reaches a terminal "left/withdrawn" state. Historical rows keep
referencing the old identifier and it must keep resolving to something a
human can read. Deleting it orphans every row that pointed at it and turns a
readable history into a foreign key with nothing on the other end.

### 5.5 A stored enum value is not a label

The value the database holds is an identifier for code to switch on; the
sentence a person reads is a separate, pure, client-safe lookup
(`lib/*-labels.ts` in the CRM — `feedback-labels.ts`, `complaint-labels.ts`).
Two reasons to keep them apart: the label file can be imported by a client
component while the service stays `server-only`, and several enum values can
fold onto one label (or one enum value's label can change) without a
migration.

### 5.6 A name that legacy data references by string is never edited in place

Where historical rows hold a free-text reference to a name (not a foreign
key) — an order line's product description, for instance — renaming the
canonical row silently detaches every historical row that used to match it.
The fix is an alias table: the canonical name changes, the old spelling
becomes an alias that still resolves on read, and nothing on the way in is
ever offered the alias as a choice.

---

## 6. Access control model

This is the part of the schema every new app plugs into rather than
reinventing. Skim §"How sign-in works" in `AGENTS.md` for the full narrative;
the shape below is what to actually build against.

### 6.1 One login, apps are granted, not implied

There is exactly one sign-in for the whole product. `app_access` is a row
per person per app — checked in **every app's own layout**, not just used to
decide what a launcher shows. A bookmarked URL into an app a person was never
granted must 404/redirect exactly as hard as a hidden launcher tile hides it.
Where somebody can open exactly one app, they land straight in it; several,
they land on the launcher; none, the launcher says so rather than showing a
blank screen.

### 6.2 Modules narrow an app; no rows means the whole app

A module is a destination in an app's own navigation — if it has a place in
the sidebar or header it can be withheld via `app_module_access`; if it
doesn't, it's part of the screen its link belongs to. **No module rows for a
granted app means every module of it** — a grant narrows only once someone
deliberately unticks something, and a fifteenth screen added to an app later
reaches everyone holding the whole app for free. The module registry
(`lib/modules.ts`) is pure and client-safe: the same list drives what the
sidebar draws, what the access-review screen renders, and what each module
folder's layout enforces on a bookmark. Revoking an app takes its module
rows with it — left behind, they silently narrow the app the day it's
granted back.

### 6.3 Roles are hats, not identities

`app_access.role` is the role a person holds **under that specific app grant**
— someone can be a manager in one app and a clerk in another, which are
different powers over different data, not one power applied twice. A grant
with no role means "the account's own" (still-standard role), which is what
lets a terminal/script that knows nothing about per-app roles keep granting
apps that work.

What you may **do** is the union across every hat you hold — `canAny` /
`requireCapability` check the union, and holding a capability under any one
hat is enough. What you may **see** (scope: your own book vs. your team's vs.
everything) is still one answer, resolved from the *widest* role you hold
anywhere. Name this imprecision rather than hide it: an admin console role
reading everywhere is a known, accepted overreach, not a bug to quietly
special-case per screen.

### 6.4 Every audited action records which hat authorised it

With more than one role per person, "was this person allowed to do this" is
not answerable from the person alone. `requireCapability` returns the
**granting** role, and every audited write stores it (`audit_log.actor_role`
in the CRM). Ask for the **narrowest** hat that carries the capability, not
the most powerful one available — otherwise every senior person's action
gets stamped with the most powerful role they hold and the column stops
distinguishing "did their normal job" from "reached past a rule using a
different hat." A null means "not recorded," never "no role."

### 6.5 Conflicting hats are named, not refused

Two capabilities that should not sit with one person (e.g. the person who
chases a target should not also approve the orders that hit it) are kept
apart in the *default* capability matrix — but a union of legitimate roles
can still put both on one person in a small team, and a system that flatly
refuses that combination gets defeated in a minute by granting a far more
powerful role instead, with no record of why. The right answer: allow the
combination, have a review screen state in words what it lets someone do, and
make sure every action taken under it carries the hat that authorised it (see
§6.4). Keep the conflict rules in one pure, client-safe file
(`lib/role-conflicts.ts`) — the review screen and the enforcement must read
the same list or one of them will drift.

### 6.6 Access is granted to a person, from one place, in one screen

If there's a system of record for employees (an HRMS-style master), access
is granted against that master, not against a freestanding account list — and
only to someone marked active there, checked at write time and not merely
hidden from a picker. **One dialog per person holds every app at once**,
because deciding what someone's whole account looks like is one act, not one
act per app repeated N times with no screen ever showing the complete
picture. A middle screen shows every app with a checkbox and every module of
a ticked app beneath it; a review screen states in words what's granted,
narrowed, widened, and revoked before anything is written, because revoking
happens by unticking a box and that is a small gesture for a large
consequence. There is exactly one place in the UI that can grant or narrow
access — a legacy per-user "Access" tab that duplicates the same write is
worse than useless, because whichever one doesn't know about modules will
silently widen a narrowed grant back to the whole app the next time it's
used. Make it read-only, or remove it.

### 6.7 Disabling sign-in is not revoking access

Whether someone can log in and what they'd see if they did are two different
questions and a UI should answer both without conflating them. Disabling
clears sessions (so nothing is left to reason about later) but **keeps**
their app grants — the record of what a leaver could reach, and what a
person on leave comes back to, must not be silently destroyed by a click
meant only to stop a login.

---

## 7. Derived state & recompute

Every screen-visible number that isn't a raw stored value is a cache with:

- one function that rebuilds it from the underlying rows (`recompute*` in
  `lib/recompute.ts`),
- every write path that changes an input calling that function inside the
  same transaction,
- a hand-triggerable CLI/job entry point for backfills and incident repair,
  and
- **no direct `UPDATE` of the cached column anywhere else in the codebase.**

A corollary: a scheduled job that syncs external data must never blindly
rebuild a cache that also holds a human decision (§9's "decided marks"). The
fix is not "don't cache it" — it's "the recompute function must skip rows
where a decided mark says a human already settled the question," and there
should be a test asserting that a decided row survives N consecutive passes
of the sync unchanged.

---

## 8. External sync / projection pattern

Any app that mirrors an external source of truth (a spreadsheet, a third
system) should follow this shape rather than reinvent it per integration:

1. **Stage first, project second.** Read the external source into a staging
   table verbatim (or nearly so); a separate, idempotent "project" step turns
   staged rows into the app's own tables. This is what makes damage
   reversible — if the projection turns out to be wrong, the staged data is
   still there to re-project from, without re-reading the external source.
2. **Hash-driven, not timestamp-driven.** Store a content hash per external
   row; skip rows whose hash hasn't changed. An untouched source then costs a
   read and zero writes on every pass, which is what makes a tight polling
   interval affordable at all.
3. **The external source wins, except where a decision mark says otherwise.**
   For almost every column, the external system is simply right and should
   overwrite the app's copy. The exception is any column a *person* decided
   inside the app (an approval, a reassignment, a payment status) — see §9's
   "decided marks." The projection must check the mark before it overwrites,
   not after.
4. **Record disagreement instead of silently discarding it.** When the
   external source wants to write over a decided value, log the conflict
   (what the source wanted, what the app holds, who decided) rather than
   dropping it silently — someone eventually has to reconcile the two, and a
   list that only grows is what tells you the reconciliation isn't
   happening.
5. **One sync per source at a time, and a stuck one doesn't block forever.**
   Guard against overlapping runs with a `running` marker; treat one older
   than a sane ceiling as dead rather than as a permanent lock. A caller that
   collides with an in-progress run should get a **409, not a 500** — this is
   the expected shape of "a slow run and a fixed interval overlapped," not an
   error a monitor should page anyone about.
6. **A "resync" and a "reparse" are different operations.** If the reading of
   already-staged data changes (a rule about how to interpret a column
   changes, not the underlying source row), re-run the projection over what's
   already staged — don't force a full re-read of the external source, which
   costs a round trip and may not even produce different bytes to reparse
   against. Ship both as separate, nameable commands.
7. **Best-effort external schedulers are not a cadence.** A CI/Actions
   `schedule:` on a low-priority tier drops ticks rather than queuing them —
   green runs and a healthy-looking log can still mean hours of silent
   staleness. Where a tight interval actually matters, drive it from
   something that owns the wait (a trigger bound to the source document
   itself, a queue) rather than trusting a generic scheduler's cron string as
   a promise.
8. **Every projection is safe to run twice.** Match on a natural/business
   key, report created/updated/unchanged rather than assuming success, and
   support a dry run that reports what *would* change without writing
   anything. Fields that represent a one-time decision by *this app* (is this
   product currently offered) are set on create only — a re-import must never
   silently reset a decision the app itself made.
9. **The trigger has to be reachable from a screen, not only from a
   terminal.** If the deployment target has no shell access, a CLI-only sync
   is a door nobody can open. Every job the sheet/source needs should have a
   button behind it in an admin/console screen, with the same argument
   validation the CLI uses (parse and refuse bad flags loudly, don't guess or
   silently drop them).

---

## 9. Money & state-machine patterns

These generalize past the CRM's specific payment flow to any place a system
needs to hold "someone said X happened" separately from "we've verified X
happened."

### 9.1 A claim is not a confirmation

Where two parties can independently assert a fact that has financial or
operational weight (a payment was made, an order shipped), model it as a
**status progression**, not a boolean: `reported` (asserted, unverified) →
`confirmed` (verified) or `rejected` (verified false), with the aggregate
figures that matter (outstanding, aging) driven by **confirmed only**. A
claim can still *pause* the consequence that would otherwise follow from
inaction (e.g. it stops a chase) — but it must not itself move the number
that downstream screens treat as ground truth. Give the pause an expiry
unless the claim is being actively investigated, in which case use a
distinct status (`held`, not a flavor of `reported`) whose "don't chase this"
never silently expires — a human, not a clock, ends a hold.

### 9.2 Reversing is not rejecting

If a confirmed fact can later turn out to have been wrong through no fault of
the original claim (a cheque that cleared and then bounced, a duplicate
entry), that's a **third** status, not a rejection. Telling someone who
genuinely paid that their payment "was never received" is wrong on the one
record they might dispute a balance against. Reversing takes the same
capability as confirming (undoing money is the same weight of decision as
applying it) and must be refused on a claim that was never confirmed in the
first place, since there is nothing to reverse.

### 9.3 Recompute the aggregate from confirmed rows; never increment it

`outstanding = f(confirmed receipts)`, rebuilt wholesale, not
`outstanding -= amount` on every confirmation. Incrementing invites drift the
first time a confirm/reject/reverse cycle happens out of the expected order;
rebuilding from source rows on every change makes every path — confirm,
reject, re-confirm, reverse — land on the same answer by construction.

### 9.4 A decided mark records WHEN a human settled a question, not WHAT the answer is

Distinct from a derived cache (§5.3, §7): a column like `approved_at` /
`payment_decided_at` exists purely so that a later automated pass (a sync, a
recompute) knows a human already answered this question and must leave it
alone. It is written **once**, by the human action that settles the
question, and never by a scheduled job. Any recompute or projection that
touches the same row must check the mark first. Where a decision is made
that affects a value but there's nothing to change (nothing to reduce, no
existing row) the mark is written anyway — the absence of a side effect is
not evidence the decision wasn't made, and a later pass must not "helpfully"
redo the no-op.

### 9.5 An unverifiable figure is a state, not a fabricated zero

When an external, authoritative-looking source states a total but says
nothing about whether it was paid, the two available shortcuts — assume it's
all owed, or assume it's all settled — are both a lie, and one of them
(assume settled) is the *dangerous* lie because it hides real money from
every downstream screen with no person accountable for the guess. Add a
third value (`unstated`, counted as neither paid nor owed), show the row so
it isn't invisible, and hold it out of every aggregate that implies certainty
until a person actually speaks for it. Every screen that renders a balance
next to this kind of row must say in words which kind of number it's
looking at — an unstated balance rendered as a bare rupee figure is the
original mistake in different clothes.

### 9.6 A read that suggests a duplicate should suggest, never gate

If your matching logic offers "this might already be a match" as a soft
hint, don't block the save on an unanswered hint — a near-certain match
gates the ordinary case as often as the true duplicate, and a blocking gate
in front of the ordinary path gets learned around. Surface it, let a
yes/no answer clear it, re-ask if the underlying entry changes, and enforce
the "yes" answer server-side too (never trust a client-side tick alone) —
but let "no" (or an unanswered hint) save exactly like it would have with
no suggestion at all.

---

## 10. Attachments pattern (generalizable file-upload shape)

- **Validate the bytes, not the filename or the declared MIME type.** Both of
  those come from the same untrusted source as the extension. Sniff the
  actual file signature server-side and decide from that.
- **Store bytes in Postgres by default; move to blob storage only past a
  configured threshold or token.** One backup, one restore path, one point-
  in-time recovery story, for a feature whose volume doesn't yet justify a
  second service. Keep the bytes in a separate table from the row that
  references them (never a column on the parent), or every listing query
  drags megabytes through the pool to render a filename.
- **A file can exist before its parent does.** Upload starts the moment a
  file is picked, not when the surrounding form saves — bind it to the
  parent at save time. This is what makes orphaned, never-bound rows
  possible, and a scheduled sweep (with a grace window for an abandoned
  in-progress form) is part of the feature, not an afterthought.
- **A save must never fail because an attachment failed.** Every attachment
  slot is optional at the point of the parent's save; report how many
  uploaded, never all-or-nothing.
- **Removing is a status change, not a delete.** Detach from the parent,
  mark `removed`; only a retention policy deletes the bytes later. Evidence
  someone tidied off a screen (a payment proof, for instance) should still
  exist afterward.
- **Access is served through a route that re-checks the parent's own scope
  on every request** (`/api/attachments/[id]`-shaped), never a stored,
  guessable, or public URL. A file the caller may not see and a file that
  doesn't exist should answer identically, or the endpoint becomes a way to
  enumerate records by trying ids.
- **A capped, per-parent limit is enforced where the file is picked, shown,
  and refused there** — not silently truncated after the save. And a picker
  that lets someone add across multiple visits to the file dialog must not
  discard what was already added.

---

## 11. Audit & notification patterns

- **Never render fixtures.** An admin/ops console section that shows a
  number is either backed by a real query or it doesn't exist — a
  hardcoded "14 unassigned" or a fabricated header name is worse than an
  absent section, because it is *believed*. If a screen offers an action
  (a button that claims to trigger something), the action must actually
  happen; a save path with genuinely nowhere to write should say so plainly
  rather than toast success.
- **Every consequential write is auditable, and the audit records the
  granting role**, not just the actor — see §6.4.
- **Notify both sides of a change that affects two people's work**, once per
  person per action (not once per row it touched) — a bulk reassignment that
  moves 140 records should generate 2 notifications, not 140.
- **A notification that tells someone "something happened" without a link to
  go see it is a dead end.** If there's a place to read the detail, the
  notification points at it.

---

## 12. UI/UX conventions

- **A record page is fixed-length regardless of how much history the
  record has.** Cap every panel's read (a constant shared by the query, the
  "load more" control, and any sentence that counts the items), and page
  further reads with a **keyset cursor**, not an offset — an offset silently
  skips or repeats rows the moment new data lands between two page loads,
  and it gets slower as the table grows rather than staying flat. A tie in
  the sort column needs a tiebreaker (`order by at desc, id desc`, cursor on
  the pair) or a page boundary that lands mid-tie will drop or duplicate a
  row.
- **A capped list says what it's a slice of, and the count comes from SQL,
  not from what's already loaded in the browser.** A count computed over a
  loaded page understates the true total the moment the page is capped —
  which defeats the purpose of capping in the first place.
- **An empty result set is not one thing.** "Still loading," "searched and
  found nothing," and "nothing has been offered yet" read identically to a
  user unless the screen says which it is. Collapsing them into one blank
  state is how "the search is broken" gets reported against a search that's
  actually working correctly.
- **A disabled control always carries a reason** (a `title` attribute or
  equivalent) — a greyed-out button with no explanation trains people to
  stop trying rather than to understand the rule.
- **A validation error renders under the field it actually names**, not
  wherever the form happened to put the first input — a server-side field
  error has to carry its field identifier through to the client rather than
  being pinned to whatever box is first.
- **Design tokens live in one place** (`src/app/globals.css` under Tailwind's
  `@theme` in this codebase) and every screen in every app reads them — a
  second, app-local palette or spacing scale is how two apps under one
  brand start to look like two products.
- **A microphone/voice-input affordance (or any assistive input) should be
  visually distinct from structural chrome**, not the same muted weight as a
  resize grip or a disabled icon sitting next to it — controls that look
  like furniture don't get pressed by the people who need them most.
- **Speech/AI-assisted input shows what it produced before committing it
  anywhere.** Never write silently into a field the person hasn't read;
  open a review step, let them edit, and let them import deliberately. If a
  faithful rendering and a "tightened" rewrite are both offered, faithful is
  the first thing shown and tightening is a second, explicit, undoable step
  — never the default the person has to opt out of.
- **Never claim to support a capability the runtime can't provide.** Where a
  browser or environment can't do something a feature depends on (pause a
  recording, for instance), don't draw the control at all rather than
  drawing one that fails when pressed.

---

## 13. Testing conventions

- `npm run test` — pure engine tests. No database. These pin the actual
  business rule, including edge cases, and must stay fast enough to run on
  every save.
- `npm run test:db` — (re)creates the integration test database from the
  real migrations. Never point integration tests at a database not
  explicitly named for testing; the CRM's runner refuses to start against
  anything but `mahekone_test` and truncates between tests for exactly this
  reason.
- `npm run test:integration` — end-to-end journeys through the real
  services, signed in via a test-only auth seam (`setTestUser()`, gated on
  `NODE_ENV=test`). Scope, capability, and audit checks are exercised for
  real, not mocked — a test that stubs out the capability check to make a
  journey pass is a test that stops catching the thing it exists to catch.
- **Grep-based invariant tests** for rules that are correct-by-luck on a
  developer's machine and wrong only in production (the timezone traps in
  §5.2, a raw-SQL column left unqualified inside a correlated subquery). A
  rule that "happens to hold" because of a coincidence in the local
  environment needs a test that inspects the source, not just one that runs
  the code — a runtime test on a machine where the coincidence holds will
  pass right alongside the bug.
- **In raw SQL, qualify every column from the outer table explicitly**
  inside a correlated subquery — an ORM (Drizzle here) can render a
  reference as a bare, unqualified column name, which silently binds to the
  *inner* table's column of the same name inside the subquery. Types and
  unit tests both pass; only a correlated integration assertion or a careful
  read catches it.

---

## 14. Checklist: adding a new app under MahekOne

1. Add its tables to the shared schema file (`src/db/schema.ts`), referencing
   `customers`/`users`/etc. directly rather than copying them.
2. Register the app (flip a `built` flag, point its route at the first real
   screen) in the shared app registry (`src/lib/apps.ts`).
3. Gate its layout on the shared access check (`listUserApps()` /
   equivalent) the way every other app's layout does — see §6.1.
4. Give it a module list in `lib/modules.ts` if it has more than one
   destination worth withholding independently — see §6.2.
5. Give its launcher tile a real count/status line sourced from a query, not
   a placeholder string, and make the badge count exactly what the sentence
   describes.
6. Put every read behind `lib/queries.ts`, every write behind a new
   `lib/actions/<app>.ts` — see §3.
7. Any business rule that isn't a straight database fetch belongs in a pure
   engine under `lib/engines/`, tested on its own — see §2.
8. Any threshold, list, or weight the app's own admin might reasonably want
   to change belongs in `lib/config/registry.ts`, not a literal in the code
   — see §4.
9. If the app mirrors an external source, follow §8: stage first, hash-
   driven, external-wins-except-where-decided, one sync at a time.
10. If the app touches money, follow §9: claim vs. confirmed, recompute from
    source rows, decided marks, no fabricated confidence about an unverified
    figure.
11. Wire capabilities into the shared matrix and role-conflict list rather
    than inventing a parallel permission check — see §6.

Nothing about the rest of MahekOne is private to the CRM. Anything above that
looks CRM-specific and isn't documented as a generic pattern here is worth
asking about before copying — the goal is one system that behaves the same
way everywhere, not four apps that each reinvented the same five decisions
slightly differently.
