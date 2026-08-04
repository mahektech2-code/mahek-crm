# MahekOne

Mahek Marketing India's connected workspace. One sign-in, one database, one
design system, many apps. The Telecaller CRM is the first; dispatch, orders,
attendance and reports join later on the same schema.

## Getting set up

You need **Node 20+** and **Postgres**. You do *not* need access to anyone's
cloud account — development runs entirely on your own machine.

```bash
git clone <repo-url>
cd mahek
npm install
npm run db:setup      # creates the database, applies migrations, seeds demo data
npm run dev           # http://localhost:3000
```

`db:setup` is safe to re-run and tells you what to do if something is missing.

### If you do not have Postgres

**Docker** (any OS) — nothing to install but Docker:

```bash
docker compose up -d
npm run db:setup
```

**macOS** natively:

```bash
brew install postgresql@16
brew services start postgresql@16
npm run db:setup
```

**Ubuntu / Debian** natively:

```bash
sudo apt install postgresql
sudo service postgresql start
npm run db:setup
```

## Signing in

Every seeded account uses the password `mahek1234`, and accepts either the
email or the work number. Which account you use changes what you see:

| Sign in as | Number | Role | Lands on |
|---|---|---|---|
| `priya@mahek.in` | 9820011001 | telecaller | straight into the CRM |
| `neha@mahek.in` | 9820011005 | telecaller | the launcher (CRM + Reports) |
| `vikram@mahek.in` | 9820011006 | manager | the launcher (5 apps) |
| `mahesh@mahek.in` | 9820011007 | field salesman | straight into the Salesman App |

## Working with the database

Everyone runs their **own** local Postgres with the same seed, so the data
looks identical without anyone sharing credentials. Nothing you do locally can
affect a colleague or production.

```bash
npm run db:seed        # reset to fresh demo data (wipes local data, incl. sessions)
npm run db:studio      # browse the data
```

### Changing the schema

Schema changes travel through **committed migration files**, which is what keeps
everyone in step:

```bash
# 1. edit src/db/schema.ts
npm run db:generate    # writes a new file into drizzle/
npm run db:migrate     # applies it to your local database
# 2. commit BOTH the schema change and the generated drizzle/ file
```

When you pull someone else's schema change, run `npm run db:migrate`.

`npm run db:push` skips migration files. It is handy while you are still
shaping a table, but never commit a schema change without generating the
migration — a colleague's database has no other way to learn about it.

## Environments

| | Database | Credentials live in |
|---|---|---|
| **Development** | Postgres on your own machine | `.env.local`, from `.env.example` |
| **Preview / production** | Neon, on the company Vercel project | Vercel — never in git |

`.env*` is gitignored. To run against preview data (rarely needed):

```bash
vercel env pull .env.production.local
```

Never point `DATABASE_URL` at a shared database and run `db:seed` — it wipes
everything. `db:setup` refuses to run against a non-local URL for this reason.

### Applying migrations to preview or production

The app reads one variable, `DATABASE_URL`, so moving between databases is
configuration, not code. To apply pending migrations to a deployed database:

```bash
DATABASE_URL="postgresql://…" npm run db:deploy
```

`db:deploy` only runs migrations — it never seeds, so it cannot destroy real
data. An explicitly set `DATABASE_URL` takes precedence over `.env.local`.

## Commands

| | |
|---|---|
| `npm run dev` | development server on :3000 |
| `npm run build` | production build (runs `tsc`) |
| `npm run db:setup` | first-time setup, or repair a broken local database |
| `npm run db:generate` / `db:migrate` | create and apply schema migrations |
| `npm run db:seed` | reset local demo data |
| `npm run db:studio` | browse the database |
| `npm run test` | engine unit tests — pure, no database |
| `npm run test:db` | (re)create `mahekone_test` from the committed migrations |
| `npm run test:integration` | the six §11 journeys against a real database |
| `npm run jobs -- <nightly\|hourly\|day-boundary>` | run a scheduled task by hand |
| `npm run check:links` | crawl the running app and assert every internal link resolves |
| `npx eslint src` | lint, including the React Compiler rules |

## Testing

Two layers, and they catch different things.

**`npm run test`** exercises the six derived-state engines. They are pure
functions — configuration and the business date go in, a result comes out — so
these run in under a second with no database at all. This is where the rules
themselves are pinned down: what suppresses a customer from the queue, when a
payment escalates, how a buying cycle is derived.

**`npm run test:integration`** runs the real services against a real database:
scope resolution, capability checks, recompute paths, the lot. It proves the
wiring between the engines and the data holds — which unit tests structurally
cannot, and which is where the bugs actually live. It uses its own database:

```bash
npm run test:db            # once, and after any schema change
npm run test:integration
```

`mahekone_test` is separate from your development database and is truncated
between tests, so a test run can never touch the data you are looking at. The
runner refuses to start against any database whose name is not `mahekone_test`.

## Configuration, not constants

Every business threshold — queue intervals, escalation timing, ageing buckets,
the working week, the 5am day boundary — is a stored setting, not a number in
the code. A manager changes them at **Configuration** in the sidebar; the change
takes effect on the next read, with no restart and no redeploy, and is recorded
against their name.

The shipped defaults are placeholders. Every one of them is expected to be
tuned against real Mahek data during migration.

## Before you push

`tsc` and `eslint` cannot see a link pointing at a URL that no longer exists.
With the app running:

```bash
npm run check:links                      # as a manager
npm run check:links priya@mahek.in       # as a telecaller — different links render
```

It signs in, crawls every page, follows every internal link and fails on any
404. Run it after moving or renaming a route.

## Where things are

Architecture, conventions and the rules that keep the data honest are in
[`AGENTS.md`](./AGENTS.md).
