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
| `vikram@mahek.in` | 9820011006 | manager | CRM, Orders, Reports, People, Admin | the launcher |
| `mahesh@mahek.in` | 9820011007 | field salesman | Salesman App | straight into that app |

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

## Layout

```
src/
  app/
    login/                 the global sign-in
    apps/                  the launcher
    field/ orders/         placeholder shells for apps not built yet
    people/ reports/ admin/
    crm/                   the CRM — header, sidebar, toasts
      dashboard/           telecaller day + manager team overview
      queue/               the calling queue, j/k/Enter driven
      reminders/  history/
      payments/  bills/  inactive/
      customers/  customers/[id]  customers/import
      complaints/  targets/  eod/  whatsapp/
      help/  settings/     SOPs and the manager configuration screen
      components/          the live design system
    api/search/            global search endpoint
  components/
    ui/                    primitives + overlays + toasts
    shell/                 header, sidebar, icons, search, wordmark,
                           app chip, app placeholder
    crm/call-panel.tsx     the call drawer, used by four screens
  db/                      schema, client, seed
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
    jobs.ts                scheduled work, idempotent and hand-triggerable
    result.ts              the Result type every action returns
    queries.ts             every scope-aware read
    actions/               every write
    journeys.test.ts       the six §11 journeys, end to end
    format.ts merge.ts csv.ts scope.ts auth.ts
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

**Suppression is a return value, not a filter.** `buildQueue()` returns held-
back customers alongside the queue, and the screen shows them. A telecaller
must always be able to find out why somebody they expected is missing.

**In raw SQL, qualify every column of the outer table.** Drizzle renders
`${customers.id}` as a bare `"id"`. Inside a correlated subquery that binds to
the *inner* table and the condition silently becomes false — types and unit
tests both pass. Write `customers.id` in the string instead. This one shipped
once; the integration tests exist partly to catch it.

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
