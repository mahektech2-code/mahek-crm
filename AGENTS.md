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
- **Postgres** in a container beside the app on a DigitalOcean droplet, not
  addressable from the internet — see DEPLOY.md. It was Neon behind Vercel
  until August 2026, which is why several comments still explain themselves in
  terms of a database running in GMT: that was true and the rule it produced
  (never cast a stored timestamp without naming the zone) outlives the move,
  because a local Postgres set to Asia/Kolkata hides the bug rather than fixing
  it.
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
npm run test:performance   # salesman targets and the score, on their own
npm run test:owner         # the owner's five KPIs, on their own
npm run db:generate  # write a migration after editing src/db/schema.ts
npm run db:migrate   # apply migrations locally
npm run db:seed      # wipe and reseed with demo data (also clears sessions)
npm run db:studio    # Drizzle Studio
npm run jobs -- nightly    # run a scheduled task by hand
npm run jobs -- sheet-payments             # pull the Payment Status tab
npm run jobs -- taken-order-sync           # pull the Taken Order tab, then
                           # rebuild who is held back from order chasing
npm run jobs -- recompute-order-holds      # just the rebuild — the Taken Order
                           # rows, or the ERP's open lines once it takes the
                           # orders. Also hourly, the hold's only schedule then
npm run jobs -- erp-seed-profiles          # ERP customer profiles from the Sales
                           # Party sheet — fills blanks only, re-runnable
npm run jobs -- erp-cycle-counts           # today's ABC cycle counts (Inventory
                           # Accuracy Control) — they also open hourly
npm run jobs -- erp-alerts                 # the ERP's unusual-activity checks —
                           # they also run hourly
npm run jobs -- erp-digest                 # yesterday's owner summary — it also
                           # runs nightly
npm run jobs -- erp-levels-plan --dry-run  # raw-material re-order levels from
                           # history, writing nothing — without the flag it writes;
                           # it also runs nightly and on every deploy (once a day)
npm run jobs -- field-activity-reparse     # re-read every stored EMP 2.0
                           # activity date in its own read's day/month order
                           # (also runs after the daily reconcile)
npm run jobs -- website-review-expiry  # website review: approvals past their 7 days
                           # become expired and the employee is told — also hourly
npm run jobs -- taken-order-reparse        # re-read what is stored — the one
                           # to run when the RULE changed, not the sheet
npm run jobs -- project-sheet --owner=vikram@mahek.in --bills
                           # staged rows -> customers, orders and bills
npm run jobs -- revert-sheet-paid --dry-run
                           # what a default-settled run wrote over the Payment
                           # Status tab's word, and what undoing it gives back
npm run jobs -- revert-sheet-paid          # undo it, then rebuild the caches
npm run jobs -- person-ids-backfill --dry-run
                           # the account ids 0353 added (advances, old petty
                           # cash, complaint salesmen, Locker holders) filled
                           # from the names beside them, through the person
                           # directory. Never guesses; counts what it leaves
npm run jobs -- person-ids-backfill        # write them — idempotent
npm run jobs -- customer-master-sync        # the EMP 2.0 shop master -> staging
npm run jobs -- customer-master-project --dry-run
                           # what the shop master would create, writing nothing
npm run jobs -- customer-master-project    # publish it into customers
npm run jobs -- place-tree-import --dry-run
                           # the reviewed state › district › city › area file
                           # (data/places/customer-places.csv) onto customers
npm run jobs -- place-tree-import          # write it — idempotent
npm run jobs -- resolve-typed-places       # place shops the review never saw,
                           # from their sheet text (also runs nightly)
npm run jobs:prod:sheets -- customer-master-sync
                           # the same against prod: .env.local FIRST for the
                           # Google credentials, .env.prod.local SECOND so its
                           # DATABASE_URL wins. Reversed, a "prod" job writes
                           # to the local database and reports success.
npm run jobs -- resolve-places-lookup       # reverse-geocode the shops that
                           # carry a pin. The ONE pass that spends requests
npm run jobs -- resolve-places --dry-run   # the master it WOULD build, off
                           # what is already stored — writes nothing
npm run jobs -- resolve-places             # build `places` and point every
                           # shop at its leaf. Also the REPARSE: the one to
                           # run when the READING changed, not the answers
npm run factory:seed       # a factory floor to look at locally — the design's
                           # people and products, made through the ERP's own
                           # handlers. Every PIN is 1234.
npm run factory:staff -- 9850220231 --area=mixing --role="Machine operator" --crew=operator
                           # put a real person on the floor (grants the app)
npm run factory:staff -- --list
npm run hrms:sync    # pull the employee sheet now
npm run app:grant -- hrms vikram@mahek.in --level=manager
                     # give somebody an app; the level defaults to associate
npm run hire:deploy  # Hire's install step (blueprints + admins) — runs on every deploy
npm run hire:seed -- --demo --reset   # DEV: wipe Hire, load its staff and pipeline
npm run report:qualification   # READ-ONLY: what the Telecaller-owned Qualification
                     # rules mean for the leads already in the book — writes nothing
npm run report:hrms-managers   # READ-ONLY: every manager-level HRMS grant and the
                     # size of the team it now sees — who should be HR team instead
npm run catalogue:parse    # regenerate the product master from the document
npm run catalogue:import -- --dry-run   # what the import would change
npm run catalogue:import   # apply it — idempotent, re-runnable
npm run check:links  # crawl the running app for broken links
                     # scripts/perf-audit.sql — what the hot screens cost, on
                     # the real book. Read-only, no meta-commands, runs in the
                     # droplet's Postgres container. See its own header.
npx eslint src       # lint, including the React Compiler rules
```

Development runs against your own local Postgres — `npm run db:setup` gets a
fresh clone from nothing to running. Only `DATABASE_URL` is required.

## Seeded accounts

Password for all of them: `mahek1234`

Sign in with the email **or** the work number.

The **Level** is the role on the account, and what it means depends on the app
it is held in — see "A ROLE IS A LEVEL" below. The job in brackets is what that
pair amounts to, not a value stored anywhere.

| Email | Work number | Level | Apps | Lands on |
|---|---|---|---|---|
| `priya@mahek.in` | 9820011001 | associate (telecaller) | CRM | straight into the CRM |
| `rakesh@mahek.in` | 9820011002 | associate (telecaller) | CRM | straight into the CRM |
| `anjali@mahek.in` | 9820011003 | associate (telecaller) | CRM | straight into the CRM |
| `suresh@mahek.in` | 9820011004 | associate (telecaller) | CRM | straight into the CRM |
| `neha@mahek.in` | 9820011005 | associate | CRM | straight into the CRM |
| `vikram@mahek.in` | 9820011006 | admin (platform administrator — Admin on the Admin Console; associate on Accounts) | CRM, Accounts, HRMS, Founder, Admin (and the retired People) | the launcher |
| `mahesh@mahek.in` | 9820011007 | associate (field salesman) | Salesman App | signs in on the web to `/apps`, which says there is nothing for him there — his app is MBOS, the mobile handset, not a browser |
| `deepa@mahek.in` | 9820011008 | manager (the ledger desk) | Accounts | straight into order approvals |

Hire's own staff come from `npm run hire:seed -- --demo --reset`, not
`db:seed` — `kavita@mahek.in` (HR Head), `priya.sharma@mahek.in` and
`neha.k@mahek.in` (recruiters), `rakesh.iyer@mahek.in`, `meena@mahek.in`,
`nitin@mahek.in` (interviewers), `sanjay@mahek.in` (hiring manager),
`farida@mahek.in` (onboarding), `farhan@mahek.in` (admin); Vikram gets Hire as
HR Head. Same password.

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

**A bill's final amount is a round figure.** A sales bill, a purchase bill, a
purchase order and a debit or credit note all total to the nearest rupee,
fifty paise up — what Tally's "Round off" line does to the invoice the
customer holds. `lib/bill-round.ts` is the one place it happens; line amounts
stay exact, and where a bill's breakdown is shown the round off is a line of
its own so the parts still add up. Without it Accounts carried balances like
₹0.38 that no exact payment could ever clear.

**A number somebody types may have a point in it, and four things used to
lose it.** A handler stripping everything but digits — so "30.5" saved as
₹305, multiplied by ten rather than refused; `type="number"` with the browser's
default step of one, which refuses on submit; `inputMode="numeric"`, which on a
phone is a keypad with no point on it; and a box DERIVED from its stored figure,
where "30." re-renders as "30" before the 5 can follow it. So: rupees go through
`parseRupees` and come back through `rupeesFromPaise`, which keeps the paise; a
box bound to a figure is `PaiseInput` or `DecimalInput`, never `value={x / 100}`;
`MoneyInput` is `inputMode="decimal"`; `cleanDecimal` and `cleanWhole` in
`lib/format.ts` are the only cleaning. Litres, kilometres and percentages take a
fraction — `lib/decimal-schemas.ts` on the server, `double precision` in the
database so raw SQL and the handset wire still see a number. Cans, boxes,
drums and days stay whole, and a whole box KEEPS the point ("1.") rather than
dropping it: cleaned a keystroke at a time, a box that drops it turns 1 . 5
into 15.

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

**A person is an id; a name is a label.** Allocation, reporting lines, books
and seats never hang off a name string, because names change — HR renames
somebody and every comparison of names silently gives a different answer.
Who-is-whose goes through `users.id`, `users.employee_id` and
`employee_reporting`; a piece of TEXT (a sheet's "Sales Person", a CSV owner)
becomes a person only through `personDirectory()` in
`lib/services/person-identity-service.ts`, which also accepts every spelling
the person has carried (`person_name_aliases`) and refuses a name two people
share. A name lives in ONE place — HRMS for a linked person — and
`renameEmployee`/`alignAccountNames` carry it to the account and the name
copies on customers' seats. Admin → Manage access → Rename is the account-side
door. `identity-by-id.test.ts` fails the build on a name-keyed lookup.

**Manager-only actions are checked server-side** in the action, not just
disabled in the UI. Disabled buttons always carry a `title` saying why.

**Saving a call is one transaction** — the interaction, any order, reminder or
complaint it produced, the queue row and the customer's rolled-up figures.
Half-saved calls are how telecaller data goes wrong.

## Where the rest of the rules live

Everything else this file used to hold now lives in `docs/agents/`, moved word for word, one file per subject. Those files are NOT loaded automatically. **Before changing code in an area below, read its file.** It holds the decisions, reversals and gotchas that code alone cannot tell you, and most of them exist because something broke in production. When you learn a new rule, write it into the matching file, not here, unless it applies everywhere.

| Read | Before touching |
|---|---|
| `docs/agents/auth-and-modules.md` | sign-in, OTP, app_access, modules, module write levels, the field app |
| `docs/agents/mbos-maps-and-book.md` | Ola Maps keys, handset map, lead/customer cards on the handset |
| `docs/agents/places-and-territory.md` | customers.city, place resolution, territories, territory filters |
| `docs/agents/mbos-field-navigation.md` | pick lists, nearest ordering, Next Best Visit, navigate deep links |
| `docs/agents/mbos-orders-statements-timeline.md` | timeline kinds, order statuses, field order edits, handset statements/customer accounts |
| `docs/agents/samples-and-lead-qualification-flow.md` | samples, qualifyLead, validation calls, orders on leads |
| `docs/agents/mbos-travel-punch-and-visits.md` | travel sessions, punch in/out, arrival, check-in radius, check-out, suspect visit cap |
| `docs/agents/mbos-lead-capture-and-media.md` | lead litres/GST, visit-order linking, bindMbosMedia, lead_manager_id |
| `docs/agents/roles-access-security-ask.md` | can()/canFor, roles and levels, setAccess, passwords, OTP, team-ask SQL views, smart search, Ask AI |
| `docs/agents/erp.md` | anything under src/lib/erp or src/app/erp |
| `docs/agents/erp-units-and-can-photos.md` | erp_uoms, quantity fields, can photos/groups |
| `docs/agents/erp-inventory-and-traceability.md` | stock checks, cycle counts, level planner, box ids, dispatch scans, labels, TSPL |
| `docs/agents/erp-drums-and-scrap.md` | erp_empty_drums, scrap sales |
| `docs/agents/erp-petty-cash-and-bank.md` | erp_money_txns, advances, bank statement uploads/matching |
| `docs/agents/layout.md` | where things live in src/ |
| `docs/agents/whatsapp-and-contacts.md` | wa_messages, Wati, templates, customer_contacts, birthdays |
| `docs/agents/customer-record-and-paging.md` | customer record page, ERP list paging/windows/caps, timeline paging |
| `docs/agents/top-and-focus-customers.md` | top_customer_reports, focus_customers |
| `docs/agents/customer-types-third-party.md` | third_party, customer_distributors, account types, Add customer, bypass convert, customer code |
| `docs/agents/lead-ladder-and-gates.md` | lead_stage, gates, overrides, nurture, distributor approval |
| `docs/agents/call-log-and-next-step.md` | buildQueue, cycles, quiet windows, next-step engine |
| `docs/agents/catalogue-and-price-lists.md` | products, SKUs, catalogue import, price-list desk |
| `docs/agents/attachments-and-attendance.md` | attachments, selfies, attendance days, retention sweeps |
| `docs/agents/complaints-and-dictation.md` | complaints, image picker, dictation/Sarvam/OpenAI |
| `docs/agents/call-and-visit-assistants.md` | call form, call-intel, visit-intel |
| `docs/agents/voice-and-lead-scan.md` | ask-voice, MBOS dictation, lead-scan, lead-voice |
| `docs/agents/order-approval-and-bells.md` | pending_approval, order decisions, notification apps |
| `docs/agents/payments-and-collections.md` | payment_receipts, confirm/hold/reverse, allocation, follow-up stages |
| `docs/agents/call-log-holds-and-time.md` | held-back customers, active_in_order_system, calendarDate, clock |
| `docs/agents/account-seats-and-reassignment.md` | sales/back-office/sales-manager seats, amDecidedAt, handover |
| `docs/agents/sheet-sync-and-bills.md` | sheet projection, crons, bills from sheets, paymentPosition |
| `docs/agents/ledger-outstanding-cashflow.md` | bills ledger, outstanding, customer statement, cash flow, vendor payouts |
| `docs/agents/admin-console-and-feedback.md` | console routes, settings placement, feedback threads/fixes |
| `docs/agents/shop-master-import.md` | customer-master-sync/project |
| `docs/agents/hrms.md` | hrms_*, workday lock, holidays, employee sync |
| `docs/agents/app-ids-and-journeys.md` | enum app ids, journey plans and the Journeys screen |
| `docs/agents/mbos-release-and-ui-feedback.md` | APK workflow, motion/feedback, notification channels |
| `docs/agents/mbos-sync-wire.md` | buildPull/bootstrap, deletions, wire tests, Date params |
| `docs/agents/field-library-and-sheet-costing.md` | mbos_documents, courses, sheet_costing_paise |
| `docs/agents/owner-kpis-and-health.md` | owner dashboard, health bands, margins desk |
| `docs/agents/sales-performance-and-targets.md` | sales_targets, scoring, mix, handset performance |
| `docs/agents/salary-expenses-travel.md` | expense policies, expense ledger, travel legs, odometer |
| `docs/agents/location-tracking.md` | mbos_positions, native uploader, setup walkthrough, activity locations |
| `docs/agents/maps.md` | street-map, snap-to-road, gap routing, offline packs |
| `docs/agents/desktop-layout-rules.md` | AppFrame, CardGrid, Table widths |
| `docs/agents/crm-lead-desks-and-verification.md` | lead hub desks, lead record, calling desk, qualification review, verifier routing |
| `docs/agents/place-tree-filters.md` | placeFilterSql, place-tree-import, resolveTypedPlaces |
| `docs/agents/price-books.md` | price_changes, book lineage |
| `docs/agents/material-returns.md` | purchase/customer returns |
| `docs/agents/logistics.md` | erp_transports, LRs, transporter godowns, freight bills |
| `docs/agents/delivery-proof.md` | signed copies, Mahek Vehicle, documents desk |
| `docs/agents/customer-order-tracking.md` | /t/<token>, milestones, holds, invoice PDF |
| `docs/agents/tasks.md` | tasks, routines, automations |
| `docs/agents/hire.md` | src/lib/hire |
| `docs/agents/factory-app.md` | /factory, factory-mobile |
| `docs/agents/docs-app.md` | src/docs, /docs |
| `docs/agents/website-cms.md` | website_content, review workflow |
| `docs/agents/studio.md` | src/lib/studio |
| `docs/agents/locker.md` | src/lib/locker |

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
   does, and render `AppFrame` — that is the whole of being correct across the
   desktop range, and `layout-rules.test.ts` fails the build if the layout
   draws its own root instead. A card shelf is a `CardGrid` for the same
   reason: a typed column count is right at exactly one width.
4. Give it a launcher count and status line in `launcherApps()` so its tile says
   what is waiting inside — and make the badge count the same thing the sentence
   describes.
5. Reads go in `lib/queries.ts`, writes in a new `lib/actions/<app>.ts`.

Nothing about the CRM is private to it, so nothing has to be duplicated or
synced later.
