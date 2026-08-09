<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# MahekOne

Mahek Marketing India's connected workspace. One database, one design system,
many apps. The CRM is the first — built for the telecaller team and their
managers. Dispatch, inventory and accounts join later on the same schema.

## Stack

- **Next.js 16** (App Router, React 19, Server Components + Server Actions)
- **Postgres** on Neon, provisioned through the Vercel Marketplace
- **Drizzle ORM** — schema in `src/db/schema.ts`
- **Tailwind v4** — design tokens in `src/app/globals.css` under `@theme`
- **Auth** — email + password, admin-created, scrypt hashes, DB-backed sessions

## Commands

```bash
npm run dev          # localhost:3000
npm run build        # production build (runs tsc)
npm run test         # engine tests — pure, no database
npm run test:db      # (re)create mahekone_test from the migrations
npm run test:integration   # the six §11 journeys, end to end
npm run db:generate  # write a migration after editing src/db/schema.ts
npm run db:migrate   # apply migrations locally
npm run db:seed      # wipe and reseed with demo data (also clears sessions)
npm run db:studio    # Drizzle Studio
npm run jobs -- nightly    # run a scheduled task by hand
npm run hrms:sync    # pull the employee sheet now
npm run app:grant -- hrms vikram@mahek.in   # give somebody an app
npm run catalogue:parse    # regenerate the product master from the document
npm run catalogue:import -- --dry-run   # what the import would change
npm run catalogue:import   # apply it — idempotent, re-runnable
npm run check:links  # crawl the running app for broken links
npx eslint src       # lint, including the React Compiler rules
```

Development runs against your own local Postgres — `npm run db:setup` gets a
fresh clone from nothing to running. Only `DATABASE_URL` is required.

## Seeded accounts

Password for all of them: `mahek1234`

Sign in with the email **or** the work number.

| Email | Work number | Role | Apps | Lands on |
|---|---|---|---|---|
| `priya@mahek.in` | 9820011001 | telecaller | CRM | straight into the CRM |
| `rakesh@mahek.in` | 9820011002 | telecaller | CRM | straight into the CRM |
| `anjali@mahek.in` | 9820011003 | telecaller | CRM | straight into the CRM |
| `suresh@mahek.in` | 9820011004 | telecaller | CRM | straight into the CRM |
| `neha@mahek.in` | 9820011005 | telecaller | CRM, Reports | the launcher |
| `vikram@mahek.in` | 9820011006 | manager | CRM, Orders, Reports, People, HRMS, Admin | the launcher |
| `mahesh@mahek.in` | 9820011007 | field salesman | Salesman App | straight into that app |
| `deepa@mahek.in` | 9820011008 | accounts | Orders | straight into order approvals |

## How sign-in works

**One sign-in for all of MahekOne** — there is no per-app login. `/login` takes
a work number *or* an email, because telecallers know their phone and office
staff know their email.

Where you land depends on what you can open:

- **one app** → straight into it, no launcher (a single option is not a choice)
- **several** → `/apps`, the launcher
- **none** → `/apps`, which says so plainly instead of showing a blank screen

`app_access` is a row per user per app. It is checked in each app's layout, not
just used to hide launcher tiles — a bookmarked `/orders` must not open for
somebody who was never given it.

**Signing in opens an attendance record for the day; signing out closes it.** A
second sign-in the same day reopens the same row, so a lunch break does not read
as two shifts.

**A forgotten password is the person's own problem to solve.** `/login/forgot`
mails a link to the work email on the account; `/login/reset` spends it. Only
the SHA-256 of the token is stored, it works once, it expires in 30 minutes,
asking for a new one kills the old one, and using it deletes every session that
account had. The reply is the same whether or not the address has an account —
this form is not a staff directory. Without `RESEND_API_KEY` and `MAIL_FROM`
the mail is written to the server log rather than sent, and the screen says so
rather than claiming it went.

## Layout

```
src/
  app/
    login/                 the global sign-in
      forgot/  reset/      ask for a reset link, and spend it
    apps/                  the launcher, 1–9 opens an app
    field/ orders/         placeholder shells for apps not built yet
    people/ reports/ admin/
    crm/                   the CRM — header, sidebar, toasts
      dashboard/           telecaller day + manager team overview
      queue/               the calling queue, j/k/Enter driven
      reminders/  history/
      payments/  bills/  inactive/
      customers/  customers/[id]  customers/import
                           the record carries the full message history
      complaints/  targets/  eod/  whatsapp/
      help/  settings/     SOPs and the manager configuration screen
      components/          the live design system
    hrms/employees/        HRMS — the employee master, one module
    api/search/            global search endpoint
    api/hrms/sync/         the cron endpoint the employee sync runs on
  components/
    ui/                    primitives + overlays + toasts
    shell/                 header, sidebar, icons, search, wordmark,
                           app chip, app placeholder, brand panel
    crm/call-panel.tsx     the call drawer, used by four screens
  db/                      schema, client, seed
    catalogue-seed.ts      the product master, GENERATED from the document
  lib/
    apps.ts                the MahekOne app registry
    config/                registry.ts (every setting + validation) and
                           store.ts (cached reads, audited writes)
    engines/               the six derived-state engines — PURE, no I/O:
                           buying-cycle, queue, escalation, inactivity,
                           targets, eod  + engines.test.ts
    services/              engines wired to data — one file per module
    access-control.ts      scope resolution + capabilities (§8)
    recompute.ts           the rebuild path for every cached derived value
    business-date.ts       Asia/Kolkata, configurable day boundary
    catalogue.ts           name normalisation + cans/litres/boxes — PURE
    sheets.ts              the one place a Google Sheet is read — read-only
    sheet-parse.ts         the order tab's cells → typed values — PURE
    hr-parse.ts            the employee tab's cells → typed values — PURE
    password-reset.ts      reset tokens: minted, hashed, read back
    mailer.ts              the one place mail leaves MahekOne
    jobs.ts                scheduled work, idempotent and hand-triggerable
    result.ts              the Result type every action returns
    queries.ts             every scope-aware read
    actions/               every write
    journeys.test.ts       the six §11 journeys, end to end
    format.ts merge.ts csv.ts scope.ts auth.ts
  app/admin/               the console — platform sections, the CRM's schema,
                           and the Catalogue section (catalogue-section.tsx)
  scripts/parse-catalogue.mjs
                           document → src/db/catalogue-seed.ts, by hand
  scripts/grant-app.ts     give somebody an app, by hand
```

## Rules that keep the data honest

**Nothing business-critical is a constant.** Every threshold lives in
`lib/config/registry.ts` and is stored in `app_settings`. If you find yourself
typing a number that a manager might one day want to change, it belongs there
instead. Reads go through `getConfig()`, which caches for 30 seconds.

**The engines are pure.** Everything in `lib/engines/` takes configuration and
the business date as arguments and performs no I/O. That is what makes the
rules testable without a database — keep it that way, and put the data
fetching in `lib/services/` instead.

**Derived values are never hand-edited.** Buying cycles, outstanding, follow-up
stages, slow-payer flags and last-contact dates are all caches. If one is
wrong, the fix is to re-run the matching function in `lib/recompute.ts`, never
to update the row.

**Money is paise.** Integers everywhere; formatted only in `lib/format.ts` on
the way to the screen. Never store rupees.

**Reads live in `lib/queries.ts`; writes live in `lib/actions/`.** A number on
the dashboard and the same number on its own screen come from the same
function, so they cannot drift apart.

**Outstanding is derived, never typed.** `recomputeOutstanding()` rebuilds it
from bills after anything that touches a bill or a payment.

**The zone is named once, in `APP_TIMEZONE`.** `workingDay.timezone` stays the
configurable authority for anything that reads configuration; the constant
exists for the two places that cannot — client components, which have no async
config, and SQL, which needs a literal. Nothing else spells the zone out.

**Never cast a stored timestamp to a date without naming the zone.** Postgres
casts a timestamptz in the SESSION zone, and Neon runs in GMT, so a bare
`ordered_at::date` puts a 1am IST call on the previous day. Local Postgres runs
in Asia/Kolkata and hides it completely. Two tests guard it: one forces the
session to GMT and asserts the difference, and one greps `lib/` for bare casts,
because the rule is invisible at runtime on a database that happens to agree.

**The working day is Asia/Kolkata, and it does not start at midnight.**
`today()` in `lib/recompute.ts` applies the configured day boundary (5am by
default), so a call logged at 2am belongs to the shift that started yesterday.
Day windows in SQL carry an explicit `+05:30` — without it Postgres reads them
in the server's timezone and a 9am call falls outside "today". The sync
`today()` in `lib/format.ts` is for client components only.

**Scope, not roles, filters lists.** `getScope()` returns `mine` or `team`.
Telecallers are pinned to `mine`; the cookie cannot widen it. Managers default
to `team` because their own book is usually empty.

**Manager-only actions are checked server-side** in the action, not just
disabled in the UI. Disabled buttons always carry a `title` saying why.

**Saving a call is one transaction** — the interaction, any order, reminder or
complaint it produced, the queue row and the customer's rolled-up figures.
Half-saved calls are how telecaller data goes wrong.

**A WhatsApp message is only sent when a human confirms it.** Until then it
sits as `copied`, and only a *confirmed* send sets
`lastConfirmedWhatsappDate` or suppresses the customer from the queue. A
copied-but-unconfirmed message is a customer who may or may not have been
contacted, and it is shown as exactly that rather than assumed either way.
There is a test for each half of this; do not collapse them.

**A customer reached two ways is two pieces of work.** `both` is a standing
instruction on a *customer*, never on a message: a message goes to exactly one
place, so a both-ways customer produces two rows and `prepareLegs` splits them,
personal leg first. The group can be pasted and confirmed while the personal
message is still sitting copied, and neither leg may borrow the other's
confirmation. One confirmed leg *does* set `lastConfirmedWhatsappDate` —
waiting for the second would chase somebody who has already heard from us.
`dest_kind` is shared with `wa_messages`, so read that column as
personal-or-group only; nothing writes `both` to it.

**The Call Log chases orders, not contact.** A customer with a measured
buying cycle is called on `cycle − lead`, where the lead is a percentage of
their own cycle, clamped: a 22-day cycle is called on day 18, a 60-day cycle
on day 50. Underneath it all sits a quiet window — no order is chased inside
15 days of the last one, because a customer reordering faster than that is
serving themselves. Customers who have never ordered are prospects, worked on
their own short cadence.

**The quiet window silences order chasing, not the customer.** A fast-cycling
customer still gets a weekly check-in inside it — that call asks whether
everything is running fine, not for an order, and the two must never be
confused. So the order reasons are stripped and the check-in reason is what
the telecaller sees. Weekly check-ins go to exactly two groups: customers
reordering faster than the quiet window, and customers whose cycle could not
be measured yet. A customer with a measured cycle of 15 days or more gets
neither — their cycle already says when to call, and a weekly check-in on top
would ring a 60-day buyer eight times before their order was due.

**A reminder outranks the quiet window and the no-order cooldown.** A callback
the customer asked for is not chasing, and not making it is worse than any
wasted call. It does not outrank do-not-contact, and it does not outrank
having already called them today.

**Asking for an order and being told no buys quiet.** Without the cooldown, a
customer past their call day returns to the top of the list every single day
until they order, which punishes the telecaller for working it.

**A payment term belongs to the customer, and the bill inherits it.** The term
is no longer agreed call by call — an order takes the customer's standing term,
or the configured default. It is still stored on the order, so a bill with no
due date of its own resolves one from that term, then from the customer's
standing term, then from the default. A customer on 45 days never quietly
becomes 30 because nobody typed a date onto the bill.

Orders taken before this change carry the term the telecaller agreed at the
time, and those values stand — the capture was removed, never the history.

**One aggregation answers "what do they buy".** The order form's frequent
container and the Information tab's product history are the same query in
`lib/services/product-service.ts`, ranked and trimmed by configuration. They
were two queries once and disagreed about the same customer, which a telecaller
notices and then stops trusting the screen. External order lines carry a
product NAME rather than an id, so they are matched back to the catalogue by
name — an unmatched name contributes nothing, because a product the catalogue
does not carry cannot be put on an order.

**Product search runs in Postgres, not in the browser.** Matching is trigram
similarity as well as substring, because a name typed mid-call is a name typed
badly: "thiner" has to find Thinner on the first attempt. The extension and its
GIN indexes live in `drizzle/0008_products_and_no_order_reasons.sql` and
`drizzle/0013_nostalgic_psynapse.sql`; Drizzle cannot express an operator-class
index, so they are not in `schema.ts`.

**The catalogue is four levels, and only the bottom one can be ordered.**
Formulation → brand line → finished good → SKU. A formulation is the liquid and
no customer hears its name; a brand line is what they ask for; a finished good
is brand plus pack size; a SKU is a finished good in one packing configuration
and is the ONLY level `interaction_product_lines` may point at. "Nano Thinner -
5 Liter (6 Can/Box)" and "… (Loose)" are two SKUs of one finished good, and
choosing between them IS the order. The three upper levels deactivate rather
than delete, because deleting one orphans everything beneath it.

**The catalogue is never shipped to the browser.** Two hundred SKUs is a
search box's job, not a list's, so the order form is handed only what is worth
offering unprompted — the customer's own frequent products and a short starter
list of best sellers (`products.starterListCount`) — and everything else
arrives a search at a time. The panel remembers every product it has seen, so a
line put on an order keeps its name after the search that found it is typed
over. Nothing is hardcoded anywhere: a product list in the CRM, the console or
the seed is a query against `products`, never a literal.

**Search reaches the formulation and the brand, not just the SKU name.** One
liquid sells as Nano, Astar Nano and M5x4 Thinner, so a telecaller told "M5x4"
must find the Nano SKUs or conclude we do not stock it. The formulation comes
back as a subtitle, which is the only thing separating "Astar Nano Thinner - 20
Liter (Loose)" from "Nano Thinner - 20 Liter (Loose)" on a list read mid-call.

**An empty product list means three different things, and says which.** Still
searching, nothing matched, and nothing offered yet are three different
sentences — mid-call, a list that means "wait" and one that means "we do not
sell that" must never look alike. Where `products.searchOnOrderForms` is off
the box is hidden rather than shown and made useless, because a search that
finds nothing reads as a broken catalogue rather than as a policy.

**A SKU's name is the join key, so it is never edited.** Legacy orders and bills
reference the description as TEXT, not by ID, so `products.name` is the
normalised name and it is unique across the catalogue. A rename would silently
detach every historical line carrying the old spelling — a name that has to
change becomes a new SKU plus an alias. `product_aliases` is what makes an old
spelling keep resolving; aliases are read on the way in and never offered on an
order form. The raw name is kept beside the normalised one for reconciling
against records that still hold the original string.

**Quantity is cans, and it is shown as cans, litres and boxes.** Cans are what the telecaller counts and what the customer
says, so cans are what is stored; litres and boxes are derived in
`lib/catalogue.ts` from the SKU's own packing. Storing litres would make "six"
unrecoverable the moment a pack size changed, and sizes here run 0.5 L to 210 L.
`packing_cost_paise` is the empty box or drum and is a COST — never a price, and
never a way to value an order. Weight is per BOX where there is a box and per
CAN where there is not, so `weightBasis` decides the multiplier and no caller
adds the two kinds together. A drum is not loose: it is a container that costs
something, which is what keeps the two costs apart.

**A name carried by two legacy Product IDs is held, never auto-picked.** The
import refuses, because order lines reference the name and choosing wrong
silently reassigns whatever history the losing ID carried. Those SKUs sit at
`needs_canonical_id`, are not orderable, and wait for a person in Admin Console
→ Catalogue → Duplicates. Choosing makes the losers aliases pointing at the
same SKU. A legacy row with packing but no sellable name is held the same way,
and packaging material is excluded outright — both stay listed rather than
dropped on the floor, because a row nobody can account for later is worse than
one that says why it is not a product.

**The import is idempotent, and it never unmakes a decision.** It matches on
the canonical name, reports created/updated/unchanged per field, and a dry run
shows exactly what a real run would change while writing nothing. Two things it
sets only on CREATE: `active`, because whether a SKU is offered is somebody's
decision and a re-import must not put every retired product back; and the
canonical ID, because a re-run must not reset a name somebody has already
settled. Both have a test saying so. Regenerate the seed from a new revision of
the document with `npm run catalogue:parse`, then `npm run catalogue:import`.

**Order value is not computed from the catalogue until a price source is
confirmed.** The product master carries no prices at all, so
`products.priceSource` starts `unset` and `canValueOrders()` answers no. An
order is worth what the telecaller typed, and the screens that would derive a
value say so rather than showing a confident zero — reaching for the packing
cost because it is the only number on the row would put believable wrong
figures on every target screen. `pricelist` is refused by `checkConsistency`
until a customer price list actually exists.

**How many quick notes an outcome takes is configuration, not a column.**
`interactions.singleSelectOutcomes` names the outcomes that take exactly one —
No Order today. Putting it on each `quick_notes` row would let two rows for the
same outcome disagree. A second pick replaces the first in the stored
identifier AND in the note text, so the note can never read "Stock sufficient
Price issue" and mean neither.

**Retired quick notes are deactivated, never deleted.** Historical
interactions hold their identifiers in `quick_note_ids`, and those references
must keep resolving to something a human can read. The save path deliberately
does not check `active`, so an old reference is never rejected on read.

**Attachment bytes live in Postgres by default, and in Blob only if a token
says so.** No second service, no token, and the bytes sit in the same backup
and the same point-in-time restore as the row that refers to them — which for a
few complaint photographs a week is simpler in every way that matters. Setting
`BLOB_READ_WRITE_TOKEN` switches the backend and nothing else changes, because
Postgres stops being right at volume: bytes in the database are bytes in every
backup, every restore and every replica, billed as database storage. They live
in `attachment_bytes`, never as a column on `attachments`, or every listing
would drag megabytes through the pool to display a filename.

**A file is validated on its bytes, never on its name.** `.jpg` is three
characters anyone can type. `sniffContentType` reads the signature and that is
what decides — an extension and the browser's declared MIME both come from the
same untrusted place. Permitted types are configuration, so removing one takes
effect immediately without touching code.

**An attachment is created before its parent exists.** The upload starts when
the file is chosen, not when the form saves, so a row begins life unparented
and is bound when the parent is written. That is what makes orphans possible,
which is why the nightly sweep is part of the subsystem rather than a tidy-up
somebody remembers. A form abandoned mid-call keeps its files for the
configured window first.

**A save is never blocked by an attachment.** Attachments are optional
everywhere. A failed upload leaves the complaint, call or follow-up intact and
the message says how many files made it — never all-or-nothing, and never a
lost call because a photograph did not upload.

**Removing an attachment is a status, not a delete.** It detaches from the
parent and moves to `removed`; the bytes go only when retention says so. A
payment proof outlives whoever tidied it off a screen.

**Attachments are read through `/api/attachments/[id]`, never a stored URL.**
Access follows the parent record's scope, so anyone who can see the complaint
can see its photographs and nobody else can. A file the caller may not see and
a file that does not exist answer identically, or the endpoint becomes a way to
enumerate customers.

**A retired outcome is readable, never writable.** "Part payment promised" is
gone from the follow-up form but stays in `PAY_OUTCOMES` marked `retired`, so
attempts already recorded against it still resolve to a label. The screen reads
`offeredPayOutcomes()`; the save schema simply does not accept it. Hiding it in
the interface alone would leave it reachable.

**A credit note amount without a request is refused.** A figure sitting on a
complaint nobody asked a credit note for reads as an approved amount to whoever
opens it next. Requests have nowhere to go yet — there is no Accounts app — so
they surface on a manager's pending list rather than sitting invisible. That is
interim, and a credit note has financial consequences.

**An order taken on a call is the customer saying yes, not the business.**
Accounts check who they are and what they already owe before it is accepted,
so a new order sits at `pending_approval` until they decide. Two different
questions get asked of the same row and they have different answers: "did the
customer order" is true from the moment it is logged, and drives the calling
queue; "did we sell anything" is true only once approved, and drives EOD value,
targets, the buying cycle, the product history and outstanding. The second
question is asked in eight places and they all read `lib/order-status.ts` —
before that existed they said `status <> 'cancelled'`, which would have counted
every pending and declined order.

**`lastOrderDate` moves on capture, not on approval.** It is the signal that
stops the queue chasing somebody who ordered this morning, and a telecaller
must not ring them because approval is slow. A declined order drops out of it,
so the customer returns to the list on their own cycle. The buying cycle uses
approved orders only, which is why `writeCycle` takes the placed date
separately — computing both from the same rows put them in conflict.

**Approving is accounts' and nobody else's.** Not a manager by seniority: the
person chasing the target must not sign off the orders that hit it. Declining
requires a reason, and it lands on the customer timeline, because the telecaller
has to ring back and say something.

**A collections call is logged in one place, and it is one transaction.** The
follow-up panel opens over the worklist and never navigates away — a
telecaller working a list of twelve should not lose their place to look at a
bill. One outcome can produce a promise, its reminder, a payment spread over
the oldest bills first, a billing complaint and a raised stage floor; a
half-saved one leaves the account describing something that never happened.
The seven outcomes and what each requires are declared once, in
`lib/services/payment-followup-service.ts`, and the screen reads that list —
so the form and the action cannot disagree about which fields are mandatory.

**The stage is derived, but it has a floor.** A customer who refuses to commit
or cannot be reached has told you something their bill dates have not, so that
outcome raises `manualStageFloor`. `recomputeFollowUpState` takes the higher of
the derived stage and the floor: the stage still rises with the age of the
debt, and never reads below what the refusal earned. The floor leaves with the
row when nothing is overdue, because it described a debt that no longer exists.
A floor a recompute erases is not a floor, and there is a test saying so.

**A late bill is messaged before it is called.** For the quiet window — 15 days
past the due date — the customer gets a reminder message every four days and no
call at all, because a bill a few days late is usually paperwork rather than
refusal. Calls open the day the window closes, and from then the customer rests
three days after each logged call. Messages do not stop when calling starts.
The window and the stage-2 threshold are two statements of the same fact, so
`checkConsistency` refuses to let them drift: if the list offered a call on a
day `isAttemptAllowed` still called stage 1, saving it would be rejected.

**Suppression is a return value, not a filter.** `buildQueue()` returns held-
back customers alongside the queue, and the screen shows them. A telecaller
must always be able to find out why somebody they expected is missing.

**In raw SQL, qualify every column of the outer table.** Drizzle renders
`${customers.id}` as a bare `"id"`. Inside a correlated subquery that binds to
the *inner* table and the condition silently becomes false — types and unit
tests both pass. Write `customers.id` in the string instead. This one shipped
once; the integration tests exist partly to catch it.

**The employee master is a mirror, and mirrors do not get edited.** HRMS reads
the workbook's `Employee Details` tab and nothing on its screens can be
changed, because HR maintains that sheet and a field edited here would be
overwritten by the next sync without telling anybody. The sync is
hash-driven, so a tab that has not changed costs a read and zero writes —
which is what makes it affordable every minute rather than every night. One
mode, `reconcile`, not the order sheet's three: seventy rows is a single API
call, and only a full compare notices a salary corrected, a leaver marked
Inactive, or a row deleted.

**Two things keep it current, and they cover different failures.** The open
screen asks every minute, so somebody who adds a row and switches tabs sees
it; and a Vercel Cron hits `/api/hrms/sync` every five minutes, so a sheet
edited on Friday afternoon is already right on Monday morning. Both land in
the same action, which refuses to run twice inside twenty seconds — ten open
tabs must not be ten reads of one sheet a minute.

**The employee sheet's password column never reaches the database.** It holds
plaintext credentials to a different system, MahekOne has no use for it, and
the raw snapshot is stored with it redacted. The hash is still taken over the
sheet's own cells, so a changed password still reads as a changed row.

**A bank account and an Aadhaar number are stored as four digits.** Enough to
recognise the account against a passbook, useless to whoever photographs the
screen. The full values stay in the row's `raw` snapshot, which no list query
and no screen selects — a leak of this kind is never a breach, it is an
ordinary query that selected everything.

**A date that can be read two ways says so rather than being guessed at.**
The tab mixes `1-Nov-2024`, Google's month-first rendering of real dates, and
day-first text somebody typed, so `hr-parse.ts` resolves what it can from the
value itself and falls back on a convention only when it must — and records a
note when it does. Those notes are kept apart from real problems: two thirds
of the rows carry one, and counting them as faults would put everybody under
"needs attention", which is the same as putting nobody there.

**The employee workbook's id is hardcoded, and the credential is not.** A
spreadsheet id names a document; it does not open one — the service account
does, and that stays in the environment. Keeping the id in
`employee-sync-service.ts` means one less variable to set correctly on every
deploy, and no HRMS reporting "not configured" because one was missed.
`HR_SHEET_ID` still overrides it, which is how a staging deploy points at a
copy.

**An employee who leaves the sheet is marked, never deleted.** Payroll history
outlives a spreadsheet edit, and somebody tidying a leaver off a tab is not
asking for their record to be erased.

**A new app id cannot be granted in the migration that adds it.** Postgres
refuses to USE a value added to an enum until that transaction commits, and
drizzle-kit applies every pending migration in ONE transaction — so a grant in
the next migration file fails on any database that has not already been
through the first. `npm run app:grant` is the way in, which suits HRMS anyway:
salaries and home addresses are granted deliberately.

## Testing

`npm run test` runs the engine tests: pure, fast, no database. They pin the
business rules themselves.

`npm run test:integration` runs the six §11 journeys against `mahekone_test`
using the real services. Create it with `npm run test:db` first, and again
after any schema change. The runner refuses to start against a database not
named `mahekone_test`, and truncates between tests.

Integration tests sign in through `setTestUser()`, a seam in `lib/auth.ts`
that only exists under `NODE_ENV=test`. Everything downstream — scope,
capabilities, audit — is the real thing.

## React Compiler

The React Compiler lint rules are on and the build is clean. Two consequences:

- **Do not reset state in an effect when a prop changes.** Give the component a
  `key` and let it remount with fresh initial state. Every modal and drawer here
  does this; see `ConfirmDialog` and `CallPanel`.
- **Do not read the clock during render.** `Date.now()` and `new Date()` are
  impure. Read the clock in a server component via `nowMs()` and pass the value
  down as a prop.

## Adding the next MahekOne app

Every app already has a login, an entry on the launcher, access control,
attendance and a switcher — only its own screens are missing. To build one:

1. Add its tables to `src/db/schema.ts` — same file, same database. Reference
   `customers` and `users` directly rather than copying them.
2. Flip `built: true` on its entry in `src/lib/apps.ts`, and point `href` at its
   first real screen.
3. Replace `src/app/<app>/page.tsx` (currently an `AppPlaceholder`) with the app
   itself. Gate its layout on `listUserApps()` the way `src/app/crm/layout.tsx`
   does.
4. Give it a launcher count and status line in `launcherApps()` so its tile says
   what is waiting inside — and make the badge count the same thing the sentence
   describes.
5. Reads go in `lib/queries.ts`, writes in a new `lib/actions/<app>.ts`.

Nothing about the CRM is private to it, so nothing has to be duplicated or
synced later.
