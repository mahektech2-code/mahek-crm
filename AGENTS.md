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
npm run jobs -- sheet-payments             # pull the Payment Status tab
npm run jobs -- taken-order-sync           # pull the Taken Order tab, then
                           # rebuild who is held back from order chasing
npm run jobs -- taken-order-reparse        # re-read what is stored — the one
                           # to run when the RULE changed, not the sheet
npm run jobs -- project-sheet --owner=vikram@mahek.in --bills
                           # staged rows -> customers, orders and bills
npm run jobs -- revert-sheet-paid --dry-run
                           # what a default-settled run wrote over the Payment
                           # Status tab's word, and what undoing it gives back
npm run jobs -- revert-sheet-paid          # undo it, then rebuild the caches
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
| `vikram@mahek.in` | 9820011006 | manager | CRM, Accounts, Reports, People, HRMS, Admin | the launcher |
| `mahesh@mahek.in` | 9820011007 | field salesman | Salesman App | straight into that app |
| `deepa@mahek.in` | 9820011008 | accounts | Accounts | straight into order approvals |

## How sign-in works

**One sign-in for all of MahekOne** — there is no per-app login. `/login` takes
a work number *or* an email, because telecallers know their phone and office
staff know their email.

Where you land depends on what you can open:

- **one app** → straight into it, no launcher (a single option is not a choice)
- **several** → `/apps`, the launcher
- **none** → `/apps`, which says so plainly instead of showing a blank screen

`app_access` is a row per user per app. It is checked in each app's layout, not
just used to hide launcher tiles — a bookmarked `/accounts` must not open for
somebody who was never given it.

**An app is not the smallest thing that can be granted.** `app_module_access`
narrows a grant to particular screens, and a module is a destination in an
app's navigation — that is the whole rule: if it has a place in the sidebar or
the header it can be withheld, and if it does not, it is part of the screen its
link belongs to. The registry is `lib/modules.ts`, pure and client-safe, so the
review table on the access screen renders the same list `requireModule` enforces
on the route. Withholding is enforced twice: the sidebar draws only what
somebody holds, and each module folder has a layout that redirects a bookmark
past it to the first module they do hold.

**No module rows for an app means every module of it.** That is why adding this
moved nothing: every grant that already existed carried on meaning exactly what
it meant, on every screen, for everybody, and a grant narrows only once somebody
unticks something. It is also what keeps `npm run app:grant` and the
provisioning endpoint honest — neither knows modules exist, and an app granted
from a terminal has to open whole rather than open empty. A grant with every
module ticked stores no rows at all, so a fifteenth CRM screen reaches everybody
holding the whole app and nobody who was deliberately narrowed.

**Revoking an app takes its module rows with it.** Left behind, they would
silently narrow the app the day somebody granted it back — four screens of
fourteen, with nothing on any screen saying why.

**Access is granted to a person, and the people are in HRMS.** The console's
People section is one screen, Access, and its dialog reads the employee master
rather than the accounts table. Somebody with no MahekOne account gets one
created in the same breath — no password is typed into the dialog, because that is a password
somebody reads out over a phone; the account is created unusable and a
single-use reset link is what makes it usable. **The employee must be ACTIVE in
HRMS**, checked in the action and not only in the picker. A leaver is listed
with the reason rather than hidden, because a person missing from a search box
reads as a broken search box.

**One dialog per person, and it holds every app at once.** Granting an app,
narrowing one, widening one and taking one away are the same act — somebody
deciding what this person's MahekOne looks like — so they are one page and one
write. Doing them an app at a time meant opening the same dialog four times to
set up one telecaller, with no screen ever showing the whole answer. The middle
page IS the whole answer: every app with a checkbox, every module of a ticked
app beneath it. The page after it is the review, which names in words what is
granted, narrowed, widened and taken away before anything is written — revoking
happens by unticking a box, which is a small gesture for a large consequence.

**An app is granted if and only if at least one of its modules is ticked.**
That removes the one invalid state the screen could otherwise express — an app
held with nothing inside it, whose every route redirects somewhere else —
rather than drawing it and refusing it at the save. `setAccess` takes the whole
desired picture and works out the difference itself, so what was reviewed is
what is written.

**Disabling a sign-in is not revoking access, and the screen says which it is.**
Whether somebody can sign in and what they would find if they did are two
questions, and the Access screen answers both in the same row — Enabled or
Disabled beside the person, the apps beside that. A disabled account KEEPS its
apps: somebody away for a month comes back to the book they left, and a
leaver's grants are still the record of what they could reach. Conflating the
two would silently destroy that record on a click meant to stop a login.
`getCurrentUser` already refused an inactive account, so this was enforced
before it was reachable; what disabling adds is deleting the sessions, because
a row good for thirty days is a thing somebody has to reason about later and
disabling should leave nothing to reason about. Manage access is refused on a
disabled account rather than half-working, and says why.

**There is ONE place an app is granted.** The user record's Access tab used to
carry its own checkboxes, which made two ways to do it — and only one of them
knew about modules, so revoking and re-granting from there quietly widened a
narrowed grant back to the whole app. That tab is read-only now.

**Signing in writes a sign-in log, and that is NOT attendance.** One row per
person per day in `attendance` — a table whose name is a misnomer kept until
the real thing takes it. A sign-in says somebody opened MahekOne, from home,
on a phone, at 2am; `signedOutAt` fills in only for the few who press Sign out
rather than closing the tab, so hours cannot be derived from a pair of these.
Two screens used to say "attendance recorded for today" and "signing in opens
your attendance", and both have been corrected — no screen may present this as
a record of who was at work. **Attendance is a check-in system with its own
screens, and it is not built yet.** A second sign-in the same day reopens the
same row, so a lunch break does not read as two sessions.

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
    field/                 placeholder shell for an app not built yet
    accounts/              the Accounts app — today, order approvals, payments
                           to confirm, credit notes, record a payment, bills,
                           customer account, on account, sheet import, audit
                           (was `orders/`; /orders still redirects here)
    people/ reports/ admin/
                           admin/access-section.tsx — the People section, which
                           is now one screen: who opens what, and how far in
    crm/                   the CRM — header, sidebar, toasts
      dashboard/           telecaller day + manager team overview
      queue/               the calling queue, j/k/Enter driven
      reminders/  history/
      payments/  bills/  inactive/
      customers/  customers/[id]  customers/import
                           the record carries the full message history
      complaints/  targets/  eod/  whatsapp/
      help/  settings/     SOPs and the manager configuration screen
    hrms/employees/        HRMS — the employee master, one module
    api/search/            global search endpoint
    api/payments/          search and open bills, for the accounts capture form
    api/sheets/sync/       order, payment + taken-order sync, on demand, ?mode=
    api/hrms/sync/         employee sync, on demand — no schedule, see below
    api/dictate/           whether to draw a microphone, and the two calls
                           behind it: transcribe/ and refine/
    admin/components/      the live design system, a console section rather
                           than a CRM screen (components-section.tsx)
    admin/feedback/        the console section where the team's reports are
                           read and answered (feedback-section.tsx)
    feedback/              the other end of it — where the person who reported
                           something reads the reply and answers back
  components/
    feedback/              the thread, rendered the same for both sides
    ui/                    primitives + modal + overlays + toasts +
                           attachment-strip
                           dictate.tsx — the microphone, its modal, and
                           VoiceTextarea, the box that carries one
    shell/                 header, sidebar, icons, search, wordmark,
                           app chip, app placeholder, brand panel,
                           feedback-button.tsx — the Tell us dialog, in the
                           header of every app
    crm/call-panel.tsx     the call drawer, used by four screens
  db/                      schema, client, seed
    catalogue-seed.ts      the product master, GENERATED from the document
  lib/
    apps.ts                the MahekOne app registry
    config/                registry.ts (every setting + validation) and
                           store.ts (cached reads, audited writes)
    engines/               the derived-state engines — PURE, no I/O:
                           buying-cycle, queue, escalation, inactivity,
                           targets, eod, payment-followup, allocation
                           + engines.test.ts, allocation.test.ts
    services/              engines wired to data — one file per module
    access-control.ts      scope resolution + capabilities (§8)
    modules.ts             what a person can open INSIDE an app — PURE, and
                           read by both the review table and the route guard
    services/access-service.ts
                           who opens what, and who there is to grant to
    actions/access.ts      setAccess — one person's whole access, in one write
    recompute.ts           the rebuild path for every cached derived value
    business-date.ts       Asia/Kolkata, configurable day boundary
    catalogue.ts           name normalisation + cans/litres/boxes — PURE
    sheets.ts              the one place a Google Sheet is read — read-only
    sheet-parse.ts         the order tab's cells → typed values — PURE
    hr-parse.ts            the employee tab's cells → typed values — PURE
    taken-order-parse.ts   the Taken Order tab's cells → typed values, and
                           the open/dispatched rule itself — PURE
    password-reset.ts      reset tokens: minted, hashed, read back
    feedback-labels.ts     the four kinds and four statuses, and their
                           sentences — PURE, because the form is a client
    services/feedback-access.ts
                           who may read and answer a thread — its own file so
                           attachments can ask without importing the service
    mailer.ts              the one place mail leaves MahekOne
    dictation.ts           the one place speech becomes text — transcribe,
                           render into English, tighten, rewrite
    jobs.ts                scheduled work, idempotent and hand-triggerable
    result.ts              the Result type every action returns
    queries.ts             every scope-aware read
    actions/               every write
    journeys.test.ts       the six §11 journeys, end to end
    format.ts merge.ts csv.ts scope.ts auth.ts
  app/admin/               the console — platform sections (platform-real.tsx,
                           from admin-platform-service), the CRM's schema, and
                           the Catalogue section (catalogue-section.tsx)
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

**The working day is Asia/Kolkata, and where it starts is configuration.**
`today()` in `lib/recompute.ts` applies `workingDay.dayBoundaryHour`, which is
now 0 — the day changes when the date does, which is what everybody outside
the building means by the word. It shipped as 5, and a dashboard opened at 2am
showed the previous day's figures with nothing on the screen saying why.
Raising it again is a real option for a team that logs calls after midnight;
it is a decision somebody makes on the Settings screen, not a default.
`0042_day_boundary_midnight` moved the stored value on deployments already
carrying the old one, matching on `updated_by_id is null` so a value somebody
had actually chosen was left alone. Day windows in SQL carry an explicit
`+05:30` — without it Postgres reads them in the server's timezone and a 9am
call falls outside "today". The sync `today()` in `lib/format.ts` is for
client components only.

**A span of days is one window, not a loop over days.** The dashboard reads
today, yesterday, this week or this month, and every figure comes from
`eodMetricsForRange` — the same twenty subqueries a single day uses, over a
wider window, so a day and a one-day range cannot answer differently and a
month costs what a day costs. `periodRange` and `previousRange` are pure and
live in `lib/business-date.ts`. A span is measured against the equally long
one immediately before it, never against a whole previous month: a
month-to-date of twelve days beside a full month reads as a collapse every
time. Yesterday means the previous WORKING day, and the screen prints the
dates rather than implying them. What does NOT follow the span is the queue,
the reminders and the "needs you today" list — those are work waiting now, and
a month's worth of it is not a thing.

**Scope, not roles, filters lists.** `getScope()` returns `mine` or `team`.
Telecallers are pinned to `mine`; the cookie cannot widen it. Managers default
to `team` because their own book is usually empty.

**And there is ONE resolution of it, `scopeForUser`.** The My book / Team
switch is drawn for anybody `isManager` lets through, which includes an admin
— and the admin branch returned `all` before the preference was ever read, so
the highlight moved and every list stayed team-wide. Two definitions: the
cookie one relabelled the header while this one filtered the data. Accounts
are deliberately outside the narrowing, because `getScope` answers "mine" for
every non-manager and reading it for them would scope the approval queue to a
clerk's own book, which is empty.

**A team list says whose call each row is.** Not the owner: whose book a
record sits in is `ASSIGNED_TO_SQL`, so naming the owner puts a call against
somebody it was reassigned away from. Unassigned is said in words rather than
left blank — a call nobody owns is the one a manager most needs to see.

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

**The Call Log chases orders, not contact.** A customer with a measured buying
cycle gets a stock-check call at a percentage of their own cycle — 70% of 30
days is day 21 — and is chased from their due date onwards. Underneath it sits
a quiet window: no order is chased inside 15 days of the last one, because
somebody who ordered days ago is serving themselves. Customers who have never
ordered are prospects, worked on their own short cadence.

**The quiet window NEVER outlasts the customer's own due date.** It is a flat
fifteen days and cycles are not, so on anybody who reorders faster than that it
used to run past the day their order was actually due — a seven-day buyer was
held until day 15, a whole cycle missed, and the call that finally came was
eight days late. The people ordering most often were the ones chased last,
which is backwards, and the orders it lost were real. It is capped at the cycle
now, so every customer follows one rule: quiet until their order is due, chased
from the day it is. Only a MEASURED cycle caps it — a guess is not a due date,
and shrinking a real window on the strength of a number nobody measured would
chase people on the strength of a default.

**What a short cycle costs is the stock check, and nothing else.** At or below
`queue.routineMinCycleDays` (15) there is no call before the order is due. That
call asks what is left on the shelf and somebody buying every week already
knows; their order is still chased on their own due date exactly like a
thirty-day customer's.

**The weekly check-in goes to one group: customers whose cycle cannot be
measured yet.** There is no cycle to time a call from, so a steady cadence is
all there is. Everybody else is called from their own cycle.

Customers reordering FASTER than the quiet window used to get it too, on the
reasoning that going silent on your best customers loses them. They no longer
do: a customer buying every seven days is in contact constantly through the
orders themselves, and a weekly call on top is noise on both sides of the
phone. Their own cycle is what calls them, and it calls them sooner than any
weekly cadence would. A customer with a measured cycle of 15 days or more never
had the check-in either: their cycle already says when to call, and a weekly
one on top would ring a 60-day buyer eight times before their order was due.

**The quiet window silences order chasing, not the customer.** The order
reasons are stripped rather than the whole customer suppressed, so a telecaller
with a reminder against them still sees the call they are actually making
rather than one about an order. A customer left with nothing at all is shown
in the held-back strip with the reason, never dropped silently.

**A reminder outranks the quiet window, the no-order cooldown, the inactive
watch and the WhatsApp cooldown.** A callback the customer asked for is not
chasing, and not making it is worse than any wasted call. The WhatsApp cooldown
was the one that did not bend, so a marketing message sent on Tuesday silently
cancelled a call promised for Wednesday — a broken promise caused by something
we chose to do, which is the worst kind. It does not outrank do-not-contact, it
does not outrank having already called them today, and it does not outrank the
external order system: the first is a standing instruction and the other two
mean the contact has already happened.

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

**A credit-note request is a yes, and nothing more.** The telecaller answers
whether the customer asked for one; which bill it is against and what it is
worth are accounts' work, because they hold the ledger. Asking mid-call for the
bill produced either the wrong one or no request at all — the form was three
fields deep behind a radio button, and the person on the phone was waiting.
`bill_id` and `goods_description` stay on the row and are still stored when
something supplies them; nothing on a telecaller's screen asks. The pending
list left-joins the bill, so a request that names none still reaches accounts.

**An attachment nobody can open is an attachment nobody uploaded.** Photographs
were write-only for as long as they have existed: no screen displayed one, and
`canRead` handed a raw snake_case row to `assertCustomerInScope`, which reads
camelCase — with `as never` silencing the compiler. `kind` was absent and
`ownerId` undefined, so the owner was refused their own file and every read
answered 404. It failed SHUT, which is the safe direction and exactly why it
survived: there was no screen to notice it on. A cast that quiets a type error
across a naming boundary is the bug, not the fix.

**A stored enum is not a label.** `packaging_damage` was reaching the screen
unchanged. The categories a person picks from are configuration and several
fold onto one enum value, so the way back cannot be derived from that list —
`lib/complaint-labels.ts` holds it, pure and client-safe.

**A photo picker adds, counts and lets one go.** Complaint photographs are
taken one at a time, so a second visit to the file dialog must not discard the
first; the limit — `attachments.maxPerComplaint`, six — is shown and refused at
the picker rather than silently truncated by `bindAttachments` after the save;
and a wrong photograph comes out on its own. One component, `crm/image-picker`,
because the complaints dialog and the call drawer ask the same question and had
drifted into two answers. Its accept list is `ACCEPTED_IMAGE_TYPES` and never a
literal: both screens offered WebP for months while `sniffContentType` refused
it, so the picker took a file the save would not.

**The microphone is tinted, small, and inside the box.** It shipped as a
muted grey glyph in the bottom corner, the same weight as the resize grip and
overlapping it — and the two read as one piece of furniture. Nobody presses
furniture, least of all the telecaller who is not confident with computers and
is exactly who it was built for. What fixed it was not size: it is that the
control is coloured, so it registers as something offered rather than
something structural, and that it is nudged clear of the grip it used to sit
on. Its words — "speak instead of typing, say it in any language" — ride on
`title` for hover and for screen readers, not in the layout, because twenty
prose fields each carrying a sentence of guidance is clutter, not help.

**No screen names a language.** Not the button, not the modal. A list of four
reads as the set of allowed answers, and somebody whose language is missing
from it stops before they start — which is the exact fear the sentence exists
to remove. "Any language" says more by naming none.

**Dictation shows what it heard before it writes anything.** A telecaller
thinks in Hindi, Marathi or Gujarati and types in English slowly with the
customer waiting, so the note that gets written is the short version of what
was actually said — a loss nobody can see later, because "will pay" reads
exactly like a sentence that never named a date or an amount. The microphone
on every prose box is there to close that gap, and it opens a modal rather
than writing into the box: the person reads the English, edits it, and decides
to import it. Nothing arrives in a field unseen.

**The English it shows first is faithful, not a summary.** Transcription and
translation are two passes and the second is instructed to drop nothing —
numbers, bill numbers, product names and commitments all survive. Tightening
is a THIRD pass somebody asks for by pressing a button, having read the long
version, and Undo puts it back. A summariser on the way in would quietly lose
the bill number, and the note it produced would look exactly like an honest
one. The original-language transcript is a click away, because the only way to
know a translation went wrong is to read the sentence it came from.

**A held recording captures nothing, and the screen has to look like it.**
Pause is `MediaRecorder.pause()`, so the held seconds are ABSENT from the blob
rather than recorded as silence — what comes back is what was said before and
after, joined. The audio track is disabled alongside it, which takes the
microphone out of the loop as well as the container. The timer stops, so
`elapsed` counts recorded seconds and not wall-clock ones: that is the number
the recording ceiling has to be measured in — a five-minute interruption must
not eat somebody's limit — and it is the number the server routes on, since
Sarvam's 30-second refusal is about the length of the audio and not how long
the modal was open. The pulse ring stops, the level meter goes STILL rather
than falling back to its idle loop, and the sentence says nothing is being
recorded. A meter travelling under the word "Held" is the screen claiming it
can still hear you. The button is not drawn at all where the browser cannot
pause — Safari only learned in 14.1 — for the same reason the microphone is
not drawn where it cannot record. Closing the modal from a pause has to
release the microphone too: the cleanup tests `state !== "inactive"`, because
a held recorder is neither recording nor inactive and `=== "recording"` left
it running.

**The audio is never stored.** It is read from the request, sent to the model
and dropped: no `attachments` row, no blob key, no retention window and no id
to fetch it back by. A recording of a customer conversation is a different
thing to hold than a photograph of a damaged can, and nothing here has asked
to hold it. That is also why dictation is a route handler rather than a server
action — two minutes of Opus is past the 1MB action body limit, and raising
that ceiling for every action in the app to carry one feature's audio is the
wrong trade.

**A microphone that fails when pressed is worse than one never offered.** It
draws nothing at all when `voice.enabled` is off, when there is no key, or
when the browser cannot record — and the setting is checked in the route as
well as in the interface, because a hidden box is not a disabled feature.

**Sarvam is asked first, and OpenAI catches what it cannot take.** `saaras`
is built for Indian languages and code-mixed speech — Hindi with English words
dropped in mid-sentence is what it is FOR rather than something it copes with,
which is how a telecaller actually talks. Its synchronous endpoint refuses
audio over 30 seconds, and rather than cap every recording at half a minute,
anything longer goes to OpenAI instead, as does anything Sarvam fails on. The
recording is never lost to a provider's ceiling, and `checkConsistency`
refuses a recording limit above 30 seconds only when the fallback is off —
otherwise the limit and the ceiling are allowed to differ, because the routing
is what reconciles them.

**OpenAI is the floor; Sarvam is an improvement on it.** A deployment with
only an OpenAI key runs the whole feature — hearing, writing, tightening — at
the full recording limit, whatever the provider and fallback settings say.
Sarvam is what makes the short recordings better, not what makes dictation
work. The fallback switch exists to honour the opposite deployment, one that
HAS a Sarvam key and wants audio kept inside India at the cost of the
30-second ceiling; with no Sarvam key there is no such deployment to honour,
and the switch used to refuse OpenAI on behalf of a provider nothing was going
to ask — a configured account sitting unused behind a microphone nobody was
shown. Both `resolveReadiness` and the guard in `transcribeSpeech` now require
a Sarvam key to be present before the switch means anything, and the tests
sweep every provider/fallback combination against a missing Sarvam key to say
so.

**The duration comes from the browser, and being wrong about it is cheap.**
The recorder already counted the seconds for the timer on screen, so the
client sends them and the server routes on that. Decoding the audio
server-side would ship a decoder to answer a question the recorder had already
answered; a tampered value costs one refused Sarvam call and a fallback, which
is what would have happened anyway. A missing value reads as long, which is
the safe direction.

**Sarvam is asked twice, in parallel, on the same audio.** `transcribe` gives
what was said in the language it was said in; `translate` gives the English.
Both are needed because the "show what was heard" panel is the only way anyone
catches a translation that went wrong, and they run together so the person
waits for the slower rather than the sum. Where OpenAI serves instead, the
English is a second, text-only pass over the transcript — same two answers,
different shape.

**Claude could not have been the ear.** Its inputs are text, images and
documents, with no audio modality at all, so an Anthropic key buys the writing
half and none of the hearing half. Transcription is the half that decides
whether a microphone can do anything, which is why it is not offered there.

**Hearing and WRITING are two jobs, and only one of them needs a particular
provider.** The bytes can only go where the audio is sent, but turning what
was heard into English is a text call any chat model can make, so
`lib/writing-model.ts` tries OpenAI and then Sarvam and the note gets written
either way. Welding both jobs to one account is what produced a deployment
whose Sarvam key worked perfectly and whose notes were raw machine
translation, with Tighten and Rewrite hidden and nothing saying why. OpenAI is
asked first because English prose is what it is best at; Sarvam second because
a plainer sentence beats no sentence. A permanent refusal — no credit, revoked
key — moves straight to the next provider rather than being reported, because
the person is mid-call and does not care whose billing failed.

**Every path runs the written pass, including Sarvam's.** Sarvam's `translate`
is a translation and reads like one: correct in substance, rough in grammar,
unpunctuated where speech was. It was going to the telecaller verbatim, which
made them the proofreader mid-call — most of what dictation was supposed to
give back. The writing model is handed BOTH the original-language transcript
and Sarvam's English, because the two disagree usefully: the transcript holds
what was said, the draft holds a reading of it by a model built for these
languages. Rendering from the transcript alone throws away the better half of
the evidence for a name or a number.

**Correct English is a rule of the prompt, not a hope.** `RENDER_SYSTEM` makes
grammar, tense, agreement, articles, prepositions, word order and awkward
machine-translation phrasing all the model's to fix — and says in the same
breath that fixing the English is not licence to change a fact. A note somebody
has to decode is a note they stop trusting; a note that reads well and quietly
lost the bill number is worse than both.

**Tighten and Rewrite are left out rather than shown broken.** They are a text
call, so `/api/dictate` answers `canRefine` and the modal omits the buttons
when it is false — but that is now false only when NEITHER provider has a key.
Requiring OpenAI hid both buttons on a deployment that could have run them,
which is the microphone mistake one level down: a capability withheld because
of who was asked rather than because of what could be done.

**The keys are set from a screen, because a terminal is not a fallback.** On a
deploy nobody has shell access to, an environment variable is a door somebody
else has to open, and the feature stays off until they do with nothing saying
why — the same lesson the sheet import already learned. `app_secrets` is
DELIBERATELY not `app_settings`: settings are rendered on screens, exported as
JSON, and audited with their before and after values, so a key kept there
would be readable in four places and one of them is a log nobody prunes.
`readSecret` is the only function that selects the value and it is called by
the request about to spend it; screens call `secretStatuses`, which selects
the last four characters and nothing else. The audit row records who changed
which credential and when, never what to. The console wins over the
environment where both are set, and the environment still works alone, so a
deploy that already has variables needs no migration.

**A key is stored as written, and the screen says so.** There is nowhere to
keep an encryption key that MahekOne can read and a database backup cannot —
one in the environment puts us back to needing shell access, which is the
problem the table exists to solve. Pretending otherwise on the screen would be
worse than the storage itself, so the screen states the trade and says to
rotate at the provider if a dump ever leaves your hands.

**Dictated text is added, never substituted, unless somebody says otherwise.**
Where the box already has words, Add and Replace are two buttons and Add is
the default one. `VoiceTextarea` decides the joining and the `maxLength`
ceiling in one place rather than at twenty call sites that would each get one
of them slightly wrong — `maxLength` stops typing but not a programmatic set,
so the box would otherwise accept more than the field will save.

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

**Money the customer says has arrived is not money the business has seen.** A
payment reported by a telecaller sits at `reported` until accounts find it in
the bank, and `bills.paidAmount` — and therefore outstanding, aging, the
slow-payer flag and the collections worklist — counts CONFIRMED receipts only.
Before this, a telecaller's word reduced outstanding on the spot, so a transfer
that never landed erased real debt from every screen with nobody's name against
the decision. `recomputeBillPaid` rebuilds the figure from confirmed lines
rather than incrementing it, which is what makes confirming, rejecting and
re-confirming all land on the same answer.

**What a reported payment DOES do is stop the chasing.** The customer is held
back from collections with the reason said plainly, never silently dropped, and
the quiet expires after `payments.reportedQuietDays` — an unexpiring one would
let a customer take themselves off the list by saying they had paid, and the
account would simply stop appearing. Reported money outranks a promise, because
it is the better news; do-not-contact still outranks it.

**Reversing is not rejecting, and the difference is what the statement says.**
Rejecting means accounts looked for the money and never found it: it never
counted, and the customer's statement reads "never arrived". Reversing means it
counted and then failed — a cheque that cleared and bounced, the same transfer
entered twice, a receipt applied to the wrong customer. Telling a customer who
genuinely paid that their money was never seen is wrong on the one document
they might dispute a balance against, so `reversed` is its own status.
`reverseReceipt` takes the same capability as confirming, because taking money
off an account is the same kind of decision as putting it on; it refuses a
`reported` receipt outright, since nothing has counted yet and rejection is the
honest answer. Nothing else had to be taught about it — every money path keys
on `confirmed`, so a receipt that stops being confirmed stops counting
everywhere at once. It is offered on the customer account statement, on the
line itself, because reversing a payment begins with finding it and that is the
screen somebody is already on.

**Rejecting is not deleting.** The receipt keeps its row and its reason, gives
the balance back to the bills it named, and returns the customer to the worklist
with their stage floor intact. It lands on the timeline because somebody has to
ring back and say something. A rejected receipt stays on the customer's
statement too — a transfer that never arrived is a fact about the account, and
dropping it leaves the next person wondering why the balance never moved.

**A receipt is one arrival of money; `payments` rows are where it went.** Which
bills a transfer settles is a second question with a second answer, so a
₹50,000 payment across three bills is one receipt and three allocation lines.
Fusing the two — which is what a payment pinned to a single bill was — makes
part payment, a transfer covering several bills, and money received in advance
all impossible to record honestly. A line with a null `billId` is money on
account, and a remainder becomes one rather than being refused at the door:
refusing it is how a receipt gets recorded for the wrong amount to make the
screen accept it.

**Allocation is pure, and the screen runs the same function the server does.**
`lib/engines/allocation.ts` takes bills, an amount and one of three
instructions — oldest first, settle these, split it myself — and returns lines.
Accounts are deciding where the money goes, so a preview that disagreed with
the save would be worse than no preview. Money already REPORTED against a bill
is subtracted before allocating, because two people writing down one transfer
is the ordinary way an account ends up over-credited.

**A reference is asked of whoever asserts the money arrived.** Accounts match a
receipt against the bank statement by that string, so one confirmed without it
is money nobody can find again. It is not asked of a telecaller repeating what
a customer said: they rarely have the UTR, and refusing the save would lose the
claim rather than improve it.

**Confirming is checked server-side, and a stale allocation is refused rather
than moved.** If a bill a pending receipt names has been settled by something
else since, confirming fails and says so — silently re-allocating money is not
a decision code should take on its own.

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

**The slow-payer flag has a grace period, and the grace is on the due date.**
A payment landing a day or two past its term is ordinary business — a cheque in
the post, a bank holiday, an accounts department that pays on Fridays — and
counting those flagged customers who pay perfectly reliably, just not to the
calendar. `escalation.slowPayerGraceDays` (7) is what a payment has to exceed
before it counts as late at all; `slowPayerLateCount` still decides how many
late ones earn the flag. Forgiving the count instead would let a customer who
is genuinely a fortnight late three times over pass as reliable. The flag is
read as "be careful with this one", so it has to mean it, and it is a derived
cache — changing the grace and re-running `recomputeSlowPayers` reclassifies
the whole book without touching a row.

**A late bill is messaged before it is called.** For the quiet window — 15 days
past the due date — the customer gets a reminder message every four days and no
call at all, because a bill a few days late is usually paperwork rather than
refusal. Calls open the day the window closes, and from then the customer rests
three days after each logged call. Messages do not stop when calling starts.
The window and the stage-2 threshold are two statements of the same fact, so
`checkConsistency` refuses to let them drift: if the list offered a call on a
day `isAttemptAllowed` still called stage 1, saving it would be rejected.

**The list is ordered by WHY, then by what that reason is worth.** The tier
weight decides the order of reasons and does not move: a promise beats an order
due, which beats a stock check. Within a reason it was "who owes the most
money", which is a collections answer given to a sales question — among twenty
customers all due to order, the one who owes most is not the one to ring first,
and a telecaller working top-down spent the morning in the wrong half of the
book. `callValuePaise` asks the question the reason is about: a collections call
is worth the debt, a sales call is worth the order. The order figure is the
MEDIAN of the customer's own recent approved orders, never a figure derived from
the catalogue — there are no prices in the product master and a confident wrong
number would be worse than none.

**A prediction is discounted by how sure we are of it.** `cycleConfidence` was
computed, stored, banded and displayed, and nothing acted on it. Two customers
averaging thirty days are not alike if one orders every 29, 30, 31 and the other
after 15, 45, 22, 60 — so where the reason is a PREDICTION (order due, overdue,
stock check) the order value is multiplied by it. A lakh at a coin toss is worth
less than sixty thousand like clockwork. Reminders, prospects and check-ins are
facts rather than predictions and carry their value whole. A NULL confidence
discounts nothing: every cycle computed before the column existed carries one,
and halving them would be a uniform penalty dressed up as a judgement — missing
information must never demote anybody.

**Confidence also moves the stock-check day.** The call lands at
`queue.routineCallPercent` of the cycle, swung by `queue.routineConfidenceSwing`
— a perfectly regular customer is called LATER, closer to the day they actually
order, and an erratic one earlier, because the honest answer to a guess is a
wider net. Fifty is neutral, so a swing of zero is exactly the old flat
behaviour. It moves the day and never creates a call the cycle length says
should not exist — a short cycle still gets no stock check.

**Suppression is a return value, not a filter.** `buildQueue()` returns held-
back customers alongside the queue, and the screen shows them. A telecaller
must always be able to find out why somebody they expected is missing.

**An import of order history never sets `activeInOrderSystem`.** That flag
means live activity in the external order system, and the queue holds such a
customer back — `queue.excludeActiveInOrderSystem` is on by default. The
projection set it on every row it touched, which muted the whole book the first
time production filled itself: a full database and an empty Call Log, with the
cause living in a column no screen shows. `0021` clears what it wrote.

**What DOES set it is the Taken Order tab, and only through a full reconcile.**
That tab is where an order lands first — typed as the customer gives it, hours
or days before it is dispatched, billed, or written to the Order Details tab.
While any line of an order is still open the customer has already ordered, and
the Call Log must stop asking them to; `recomputeOrderSystemHolds()` is the one
thing that writes the flag and it rewrites every customer on every pass. A pass
that only ever SET it is how the book goes quiet for good: nothing would lift a
hold, and an order that shipped in August would still be muting its customer in
March.

**Two cells decide it, and the rule is asymmetric.** `Status` (column L) at
`Ready` AND `Entry status` (column R) at `Done` releases the customer; either
one falling short holds them — a Ready order the office has not finished with
is still open, and four of them are. Everything else holds too, because the
vocabulary is not closed: an unrecognised value must never read as dispatched,
and the cost of holding wrongly is one early call, shown in the held-back strip
with its reason.

**`Cancel` is the exception, and it has to be.** It releases on its own,
whatever the entry status says. Every other status eventually becomes `Ready`;
a cancelled row never changes again, so holding it is a mute with no event left
that could lift it — and the customer behind a cancelled order has not ordered
anything, which makes them exactly who should be rung. Reading it as "unknown,
therefore held" muted 294 rows' worth of customers permanently, which is how
the carve-out was found.

**A hash-driven sync needs a reparse, or a changed rule never lands.** Nothing
was rewritten when `Cancel` changed meaning: not one of those 294 rows differed
by a character, every hash matched, and the customers stayed muted on the
strength of a decision already reversed in the code. `npm run jobs --
taken-order-reparse` re-reads what is stored, touches Google not at all, and is
the command to run whenever the READING of a row changes rather than the row.

**An order is contact, and the check-in dates from the LATER of the two.**
Somebody spoke to the customer to take that order, so an order that arrived
through the sheet counts as much as a logged call. Preferring the call and
falling back to the order only where there was none — which is what `??` did —
rang a customer who ordered on Tuesday to ask how they were getting on, on the
strength of a call three weeks old. Below both sits the record's creation date:
reading that first dates a customer of four years from the afternoon their row
was written, so an imported book sits off the queue for a week. Prospects still
fall back to it, having no order to be dated from.

**A date derived from a timestamp names its zone in JavaScript too.**
`createdAt.toISOString().slice(0, 10)` is a bare `::date` in different clothes —
it answers in UTC, so a row written at 2am IST is dated to the previous day.
`calendarDate()` is the way. This one hides better than the SQL spelling, which
at least behaves differently on a database running in GMT: `toISOString()` is
wrong on every machine equally, so it never looks like a timezone bug. It had
reached ten places, and the one that mattered was `writeCycle` — those dates
become the INTERVALS the buying cycle is the median of, so a 2am order
shortened one gap and lengthened its neighbour, and the cycle is what decides
when the entire book is called. A second grep test now guards `src/` for it,
beside the one that guards `lib/` for the SQL spelling. A full ISO timestamp is
left alone: an instant carries its own zone, and only truncating it to a day
loses one.

**A salesperson is a name, not an account.** The Sales Party tab's `Sales
Person` is who sells to a customer, and most of those people have never signed
in — several are not people at all ("Western Line Sale", "Company Own",
"JAIPUR"). `salesAmId` can only hold a `users` row, so the projection linked
the handful that matched and dropped the rest, and every screen fell through
to the owner: all 557 customers showed a telecaller as their salesperson.
`customers.salesPersonName` holds the name itself, the screens read it first
and the linked account only where the sheet is silent, and
`recomputeSalesPeople()` rebuilds it from what is already stored — the command
to run when the reading changed rather than the row.

**Changing an account manager is accounts' and admin's, and not a manager's.**
Whose book an account is in decides who is credited for its orders and whose
targets it counts toward, so a manager reassigning accounts is a manager moving
numbers between their own people, including themselves — the same conflict
`order.approve` exists to avoid, one level up. `customer.reassign` sits in
`ACCOUNTS_ONLY` and is checked in the action, not by hiding the button.

**An account has TWO managers and they move independently.** Sales is whose
book it is; back office is dispatch, billing and paperwork. Either or both can
be changed in one action, and each writes its own history row, because a
salesperson resigning says nothing about who raises the invoices. In the
dialog, a manager left untouched is OMITTED from the request rather than sent
as its current value — sending it would stamp a decision mark on an account
nobody decided anything about.

**A reassignment is a decision, so the sheet keeps its hands off it.**
`customers.amDecidedAt` is the third mark of its kind, after
`orders.approvedAt` and `bills.paymentDecidedAt`, and it guards TWO things
rather than one. `--reassign` no longer overwrites the ids on a decided
account — but the half that would have been missed is
`recomputeSalesPeople()`, which rewrites `salesPersonName` from the sheet every
night. Holding the id while letting the NAME revert is the worst outcome
available: the account moves for scope, the queue and collections, and every
screen goes on showing the old person, because the lists read the sheet's name
first. Nobody reports that as a bug — they report that reassignment does not
work. So the mirrors move with the ids, and a decided account is skipped by
both paths.

**A lead moves by `owner_id` and a customer by `sales_am_id`.** That is what
`ASSIGNED_TO_SQL` reads, so writing only `sales_am_id` leaves every lead
exactly where it was while the screen reports it moved.

**Why it moved is a column, not a sentence in a log.** `customer_am_changes`
stores a reason code from `people.amChangeReasons` beside the from and the to,
and the reason list is configuration because a manager should be able to add
one without a deploy. The question people actually ask is "what moved when
Suresh left, and why" — `audit_log` can only answer that by grep. Names are
stored ON the row as well as the ids, so a history stays readable after the
person leaves and their account goes.

**Both sides are told, and the new manager especially.** Work has moved onto
their queue without them asking; the first they would otherwise know is a list
that grew overnight. The person who lost the accounts is told for the same
reason in reverse — a book that shrinks silently reads as a bug in the queue.
One notification per person per action, never one per account, and a
reassignment that changes nothing notifies nobody.

**Accounts have their own customer list, and it is not decoration.** An
accounts user holds `apps: ["accounts"]` and `src/app/crm/layout.tsx` redirects
them out of the CRM, so offering this action only on the CRM's list would have
shipped a permission that nobody holding it could reach. `/accounts/customers`
runs `listCustomersPage()` — the SAME query the CRM list runs, because two
reads of "who are our customers" is how two screens disagree about one. The
presentation is its own: the CRM list offers reminders and WhatsApp and links
every row into `/crm/customers/[id]`, all of which are doors this app's users
are redirected away from.

**One person picker, not two.** A dropdown beats a search box while the list is
short and loses the moment it is not, but building both means two components
and two sets of bugs, and the day the eleventh salesperson is hired somebody
has to notice and swap them. It is always the same searchable list;
`people.pickerSearchThreshold` decides only whether the search field takes
focus.

**What it does NOT do is decide whose book a customer is in.** That stays
`salesAmId`, because scope has to resolve to somebody who can sign in and see
the work. The two answer different questions and a name with no account cannot
be given a queue.

**Whose book is one definition, and it is `ASSIGNED_TO_SQL`.** A lead answers
to its owner; a customer answers to its sales account manager, falling back to
the owner. Every scoped list reads it — the queue, collections, bills,
complaints, targets, the inactive watch, WhatsApp replies and global search.
Reading `owner_id` alone silently drops every customer whose sales AM has been
set, including off the collections list while they still owe money.

**The sheet wins every column except a decision somebody made.** The team
works in the spreadsheet and the CRM projects what they type, so for almost
everything the sheet is simply right and should overwrite. `orders.status` is
the exception: accounts approve and decline in the app, and the projection
used to reset that to `dispatched` on every pass. The approval columns are not
part of that overwrite, so the row was left reading "declined by Deepa, over
credit limit" beside a status of `dispatched` — and approved status drives EOD
value, targets, the buying cycle, the product history and outstanding, so the
reset moved figures on five screens with nobody's name against it. `approvedAt`
is the mark of a decision, written by decline as well as approve and never by
the projection, so the upsert keeps the app's status wherever it is set.

**A kept decision is written down, not just kept.** Silence would trade one
invisible loss for another: the sheet still says something different and
somebody has to reconcile the two. `sync_conflicts` records what the sheet
wanted, what the app holds and who decided, with a partial unique index on the
unresolved ones — an uncorrected sheet is re-read every thirty minutes, and a
list that grows by forty-eight rows a day is one nobody reads.

**One sync per source at a time.** Nothing checked this, which was fine on a
laptop and is not on a schedule: a run that hangs on a slow Google response is
still `running` when the next fires, and two passes race through the same
upserts. A `running` row older than ten minutes is treated as dead rather than
blocking forever, because the route is capped at five — waiting on a killed
process would let one timeout stop every future sync. Refusing returns **409
and not 500**: two overlapping calls are the ordinary result of a slow run and
a fixed interval, and a scheduler must not page somebody about a sync that was
working perfectly.

**The schedule lives outside the deployment, because Vercel Cron is paid.**
Two cycles: every thirty minutes for the read modes and the projection, and
one a day for `reconcile` — the only pass that sees an edit to an old row or a
deletion — followed by `nightly`, which is the only thing that rebuilds the
derived caches. Steps run in sequence on purpose: no single call may exceed
the route's five-minute ceiling, but a caller may take twenty minutes, so the
cycle is chunked into calls rather than made into one long one, and the order
matters — the read modes land rows in the staging tables and `project`
publishes what has landed, so projecting first ships the previous cycle's data
as though it were fresh. Reading is cheap when nothing changed, since every
row carries a content hash — an untouched tab costs a read and no writes,
which is what makes the cadence affordable.

**A `schedule:` in GitHub Actions is a hope, not a cadence.** It is
best-effort, and on a private repo belonging to a free account it is the
lowest priority tier there is: a tick that cannot be served is DROPPED, never
queued, so the interval you wrote is an upper bound on frequency and nothing
more. `*/30` delivered three runs in eleven hours here — gaps of 2h01, 4h48
and 4h07, about one tick in ten — with every run green and finishing in two
minutes, which is what makes it so hard to notice: nothing fails, the log
looks healthy, and the CRM is just quietly hours stale. The half-hourly cycle
is an Apps Script time-driven trigger on the workbook instead
(`scripts/sheet-sync-trigger.gs`), which is not best-effort and lives beside
the sheet it reads. Cron minutes are `:07`/`:37` and `:13` rather than `:00`,
because the top of the hour is exactly when ticks get dropped.

**The nightly stays in Actions, because `curl` waits and `UrlFetchApp` does
not.** The daily pass is the one place ORDER is load-bearing across a
five-minute boundary — `nightly` rebuilds the caches from what `reconcile`
landed, so starting it early rebuilds them from half a compare.
`--max-time 310` blocks until the server answers; Apps Script gives up at
about sixty seconds with no way to raise it, and a full compare takes longer
than that, so the script would start the second step over an unfinished first
and have no way to know it had. One tick a day also has far better odds of
being delivered than forty-eight. Where a fetch DOES time out in the
half-hourly script it is logged and the cycle carries on: the request reached
the deployment and the job runs to completion server-side, so only the answer
is lost, and the next tick's 409 guard stops a second pass climbing on top.

**A flag that is silently discarded is worse than one that is rejected.**
`npm run jobs -- project-sheet --bills` used to run the projection with no
options whatsoever: the argument was read into argv, dropped before `runJob`,
and the run then reported "bills skipped" — which reads as a fact about the
data rather than an option that never arrived. Sales Bills was empty and the
command said so in words that sounded like an explanation. Parsing lives in
`lib/job-args.ts` so it has tests; an unknown option, a `--owner` with nothing
after it, and a switch given a value are all refused rather than guessed at.

**The import has to be runnable from the screen.** On a deploy nobody has
shell access to, a terminal is not a fallback — it is the only door and it is
locked. The sheet jobs were reachable from a CLI and from a cron endpoint
guarded by a secret, which on this deployment meant neither, so the import ran
on somebody's laptop against the production database or it did not run at all,
and Sales Bills stayed empty through three releases that each claimed to fix
it. Admin Console → Order sheet → Sync runs both steps, and `triggerJob` takes
the owner because the sheet cannot supply one. A merge has to be enough.

**A bill number is unique across the TABLE, so uniqueness cannot be worked
out from one run.** `bills_no_key` is a unique index over every row, and the
import used to decide numbering by counting Tally numbers within its own batch
— blind to a bill somebody typed in, one the Payment Status path wrote, or one
a half-finished run left behind. The insert threw, and it threw after thousands
of rows had already landed. Existing numbers are read first and a contested one
falls back to `<tally>/<order number>`, then `ORD-<order number>`; an order
that still cannot get a unique number is counted and skipped, never renamed
into something nobody can reconcile and never thrown, because one unusable
number must not cost the other ten thousand rows.

**A sales bill IS the order.** Bills are projected from the Order Details tab,
one per order, valued as the SUM of its lines — Final Amount is line-level and
half these orders are multi-line. The number is the Tally number, gaining the
order number where that repeats. `--bills` swaps the source to the Payment
Status tab — never both, since they key on the same `SHEETPAY-<order number>`
and would give one bill two authors.

**The sheet never writes money. Not in any column, not by any path.** No
receipt, no `paid_amount`, no `status`, no `outstanding`. Whether money arrived
is the app's to record and nobody else's, and a sync that touches a payment
figure is a bug however reasonable its reading of the tab was.

It was not always so, and the reasoning that got it wrong was good. The Order
Details tab records what was billed and never what was received, so the only
two readings were assume-everything-owed — which invents the whole order book,
nine crore of it, as debt and puts every customer on the collections list — or
assume-everything-settled, which understates rather than fabricates and was
called the safer of two lies. It was still a lie, and it was the one that hides
money: every customer's every bill read as paid on a spreadsheet's authority
with no person behind any of it.

**So there is a third position, and it is stated rather than guessed.**
`bills.paymentPosition` is `stated` or `unstated`, and `unstated` counts as
NEITHER paid nor owed. The bill exists and shows on the customer record; it is
held out of outstanding, the aging strip, the collections worklist, the
slow-payer flag and the WhatsApp reminders until somebody speaks. Nothing
chases a debt nobody has vouched for, and nothing is written off either. The
column defaults to `stated`, deliberately: every row that existed when it
arrived kept exactly the behaviour it had, so adding it moved no figure on any
screen. Only the projection writes `unstated`, and only on INSERT — a bill
somebody has since spoken for must not be returned to silence because a
scheduled pass re-read the row it came from.

**What states a bill is a person.** Recording or confirming a receipt against
it — every route to confirmed money passes through `applyToLedger`, which is
where the mark is set, because a decision recorded in three places is a
decision missed in one — or Tally's receivables report naming it through
`leaveOwing`. `payment_decided_at` says WHEN and is set once; `paymentPosition`
says THAT, and is set unconditionally, because a bill can carry a decided
timestamp from before the column existed while still reading `unstated`.
`source <> 'sheet_import'` is what keeps the two apart: a receipt the
spreadsheet wrote is not somebody deciding.

**A screen showing a balance has to say which kind of number it is.** On an
`unstated` bill the balance is the full amount purely because nothing has been
recorded against it, so the bill screen says "no payment recorded either way"
rather than "₹0 received" and explains why. Rendering it beside real balances
presents an unknown as a debt, which is the original mistake wearing different
clothes.

**The Payment Status tab is evidence, not an author.** It has the best claim of
anything in the workbook — real received/not-received on 8,277 rows — and it
still does not write money. A receipt is the assertion that funds reached the
bank; a spreadsheet cell cannot make that assertion, because no person is
behind it and there is nobody to ask when it turns out to be wrong. What it
says is COUNTED and reported — `paidWithoutDate`, `blankStatus` — so accounts
can go and confirm it. A BLANK status is no longer read as settled, nor as
unpaid as it was before that; it is read as what it is, the same `unstated`
every other row gets.

**What the old assumption did is still in the database, and the revert is kept
for it.** Production carries thousands of `source = 'sheet_import'` receipts
and they are why the book reads as paid; they were deliberately left in place
when the writing stopped, so that no figure moved on the day of the change.
`revertSheetSettledBills` deletes only those whose order the Payment Status tab
affirmatively calls unpaid — silence is not evidence in either direction — and
`unpaidPerPaymentTab()` is the single definition both it and the old importer
shared, because two copies of that rule would clean up a different set to the
one the importer stopped writing, and the difference is money. The projection
can no longer produce that damage, so the tests build it by hand.

**The projection no longer rebuilds paid amounts.** `recomputeAllBillPaid` and
`recomputeBillStatuses` derive from confirmed receipts, and the sheet writes
none, so there is nothing new for them to read and running them would make a
pass that touches no money look like one that rewrites the ledger every thirty
minutes. Outstanding IS still rebuilt, because a corrected bill AMOUNT changes
what a stated bill is worth, and the follow-up stage and slow-payer flag follow
it in that order.

**The mark goes on before the receipt comes off.** `leaveOwing` writes
`paymentDecidedAt` first and unconditionally — including for a bill it finds no
assumed receipt to cut. The report naming a bill IS the decision, and a bill it
names must not be settled by assumption later just because there was nothing to
delete at the time. Marking it after the delete would leave a window, and the
window is exactly where the cron lives.

**A part payment is locked too.** Where some money did arrive `leaveOwing`
REDUCES the assumed receipt rather than deleting it, so the key stays taken and
the old bug could not bite — but the lock applies anyway, because "the customer
paid ₹1,000 of ₹2,360" is as much a decision as "they paid nothing", and a
later pass must not decide the remainder arrived too. There is a test for each
of the three: fully owed, part owed, and five consecutive syncs.

**The fix went in the projection, not in the two callers that spell the URL
out.** Adding `bills=1` to the workflow and the Apps Script would have worked
until the third caller, and a rule about money that lives in a query string is
one deployment away from being forgotten. The staging tables are what make the
damage reversible at all: `sheet_payment_rows` holds the tab's own verdict,
the projection reads it and never writes to it, so the receipts that SHOULD
exist stay derivable however badly the published side is mangled. `npm run
jobs -- revert-sheet-paid --dry-run` reports the count, the money and the
customers affected; without the flag it deletes and rebuilds the caches. It
touches `source = 'sheet_import'` receipts only — a telecaller's reported
payment and an accounts confirmation are somebody's word, and no cleanup of an
import's mistake may reach them.

**A recompute that filters is a recompute that freezes.**
`recomputeAllFollowUpStates` is the only thing that REMOVES a follow-up row
when the debt behind it goes, so restricting it to active customers did not
skip work — it stranded eight customers at stage 3 claiming crores overdue
while owing nothing, beyond the reach of any later run. It visits every
customer; nothing is created for one who owes nothing.

**The ledger is cut by financial year, not paged from the top.** Ten thousand
bills across three years is not a list anybody scrolls, and Mahek's own bill
numbers already carry the year — MMI/26-27/1119. The current year is the
default, the server filters to it, and the table pages within it. Paging is
over what is filtered IN, so the totals row, the aging strip and the export all
describe the whole year while only the table is cut into pages — a page that
changed the totals under it would show a different figure on every click.

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

**An app id may not collide with a platform section key.** `people` and `apps`
are both, and a bare section address let the app win — `/admin/people` opened
"Attendance & People, registered but not built" instead of the roster. App
sections are addressed `app-<id>`; a bare id still resolves for anything that
is not a platform key, so `/admin/crm` keeps working.

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
under the platform nav, where the rest of the build-facing material already
lives.

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

**The employee master is a mirror, and mirrors do not get edited.** HRMS reads
the workbook's `Employee Details` tab and nothing on its screens can be
changed, because HR maintains that sheet and a field edited here would be
overwritten by the next sync without telling anybody. The sync is
hash-driven, so a tab that has not changed costs a read and zero writes —
which is what makes it affordable every minute rather than every night. One
mode, `reconcile`, not the order sheet's three: seventy rows is a single API
call, and only a full compare notices a salary corrected, a leaver marked
Inactive, or a row deleted.

**What keeps it current is the open screen, and only that.** It asks every
minute, so somebody who adds a row and switches tabs sees it. There is no
schedule behind it: Vercel Cron is a paid feature and this account is on the
free plan, so a sheet edited on Friday afternoon stays unread until somebody
opens HRMS on Monday. `/api/hrms/sync` still exists for an external scheduler
or a person to call, guarded by `CRON_SECRET`. Both paths land in the same
action, which refuses to run twice inside twenty seconds — ten open tabs must
not be ten reads of one sheet a minute.

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

**Renaming an app's slug is a RENAME, never an add-and-migrate.** `orders`
became `accounts` when the app outgrew the name it was given for its first
screen. Adding the new enum value, updating `app_access` and dropping the old
one cannot be done at all — a value added to an enum may not be USED in the
transaction that adds it, and drizzle-kit runs every pending migration in one
— and doing it across two deploys revokes the app from everybody who has it in
between. `ALTER TYPE app_id RENAME VALUE` changes it in place: every existing
grant keeps pointing at the same app without being touched. The old URLs are
kept alive by a permanent redirect in `next.config.ts`, because a slug lives in
bookmarks, in emails and in screenshots long after it has changed in the code.

## Testing

`npm run test` runs the engine tests: pure, fast, no database. They pin the
business rules themselves.

`npm run test:integration` runs the six §11 journeys, the Accounts app and the
feedback threads against `mahekone_test` using the real services. Create it
with `npm run test:db` first, and again after any schema change. The runner
refuses to start against a database not named `mahekone_test`, and truncates
between tests.

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
