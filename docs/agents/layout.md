# Source layout

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

```
src/
  app/
    login/                 the global sign-in
      forgot/  reset/      ask for a reset link, and spend it
    apps/                  the launcher, 1–9 opens an app — `field` is never
                           one of the 1–9: it is `mobileOnly` in lib/apps.ts,
                           MBOS's own handset, and has no route here at all
    factory/               the Factory app — the floor's PHONE app: one client
                           screen (_ui/factory-app.tsx, the design ported screen
                           for screen) and its label page; public/factory-sw.js
                           is what lets it open with no network
    api/factory/rpc/       the factory phone's one door, by op name — stable
                           across deploys, unlike a server action
    accounts/              the Accounts app — today, order approvals, payments
                           to confirm, credit notes, record a payment,
                           outstanding, bills, customer account, on account,
                           sheet import, audit, sales targets, customer targets
                           (was `orders/`; /orders still redirects here)
    people/
    admin/                 the Admin Console — one real route per screen, every
                           address built from lib/admin-routes.ts; _shell/ is
                           the frame and the gate, access/ who opens what
    crm/                   the CRM — header, sidebar, toasts
      dashboard/           telecaller day + manager team overview
      queue/               the calling queue, j/k/Enter driven
      reminders/  history/
      payments/  outstanding/  bills/  inactive/
      customers/  customers/[id]  customers/import
                           the record carries the full message history
      complaints/  targets/  eod/  whatsapp/
      help/  settings/     SOPs and the manager configuration screen
    hrms/employees/        HRMS — the employee master, one module
    docs/                  the Documentation app — every app's pages, three tabs
                           each; content is MDX in src/docs/, see "The
                           Documentation app" below
    hire/                  Hire — role blueprints, the pipeline, AI-assisted
                           interviews with evidence, decisions, onboarding,
                           provisioning. Rules in "## Hire" below; engines in
                           lib/hire/engines, every model call in lib/hire/ai
    api/search/            global search endpoint
    api/payments/          search and open bills, for the accounts capture form
    api/sheets/sync/       order, payment + taken-order sync, on demand, ?mode=
    api/hrms/sync/         employee sync, on demand — no schedule, see below
    api/dictate/           whether to draw a microphone, and the two calls
                           behind it: transcribe/ and refine/
    admin/components/      the live design system, under For builders
    admin/feedback/        where the team's reports are read and answered
    admin/settings/        every setting, one page per app that has any
    feedback/              forwards to the Feedback page inside an app the
                           person holds (`<app>/feedback`), where they read
                           the reply and answer back
  components/
    customers/customers-screen.tsx
                           the customer list, shared by the CRM and Accounts
    customers/monthly-targets-screen.tsx
                           the per-customer target screen, shared the same way
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
    crm/next-step-dialog.tsx
                           saved, and what happens next with this customer
    crm/payment-mode-fields.tsx
                           how the money came, asked once for three screens
    crm/sales-manager-dialog.tsx
                           the third seat — who the salesperson answers to,
                           set on a tick-list or on a whole filtered book
    crm/distributor-picker.tsx
                           the searchable list of accounts we bill — the only
                           thing that may be named as a distributor
    crm/third-party-dialog.tsx
                           converting a lead, which is the mark AND who bills it
    crm/distributor-panel.tsx
                           the arrangement on the record: add, edit, remove
  db/                      schema, client, seed
    catalogue-seed.ts      the product master, GENERATED from the document
  lib/
    apps.ts                the MahekOne app registry
    place-parse.ts         a reverse-geocode answer -> state/district/city/area
                           — PURE, the four rungs and the fold they match on
    services/place-service.ts
                           the three passes: ask, propose, resolve
    services/ola-reverse-geocode-service.ts
                           a coordinate -> the tree it sits in, through the
                           same key pool every other Ola call uses
    account-types.ts       direct customer / lead / third-party customer, their
                           filter and their labels — PURE, read by both lists
                           and both list pages
    config/                registry.ts (every setting + validation) and
                           store.ts (cached reads, audited writes)
    lead-labels.ts         the funnel's whole vocabulary — the three sales
                           types, every rung's two names, the four coded reason
                           lists, §8's twelve questions, §16's seven feedback
                           fields, §13's fifteen nurture rows, §14's eleven
                           buttons and §18's eight. PURE and client-safe,
                           because the forms that write these run in a browser
                           and on a handset while the services that read them
                           are `server-only`
    engines/               the derived-state engines — PURE, no I/O:
                           lead-ladder — the three ladders, which rung follows
                           which, and the four funnel bands every new rung maps
                           onto; lead-gates — §28 itself, what each rung
                           demands and which of it is missing; lead-nurture —
                           an event in, the manager's tasks out,
                           buying-cycle, queue, escalation, inactivity,
                           targets, eod, payment-followup, allocation,
                           next-step — when this customer comes back, and why,
                           performance — the six weights, the mix bands, the
                           month-end forecast and the price-rise alert,
                           owner-kpis — new leads, cohort conversion, bill
                           size, purchase frequency and retention movement,
                           receipt-match — is this money we already know about
                           + engines.test.ts, allocation.test.ts,
                           next-step.test.ts
    services/              engines wired to data — one file per module
    access-control.ts      scope resolution + capabilities (§8)
    modules.ts             what a person can open INSIDE an app — PURE, and
                           read by both the review table and the route guard
    sales-attribution.ts   whose number a customer's is — the fall-through to
                           the back office, and the ONE place it is written
    services/owner-dashboard-service.ts
                           the owner's five, read off the book, and the nightly
                           customer-health snapshot behind the movement report
    services/performance-service.ts
                           the six actuals, wired to the ledger, and the
                           rebuild of the score cache
    services/sales-target-service.ts
                           who can be given a target, and what they have
                           actually been doing, for the screen that sets one
    actions/sales-targets.ts
                           saving a target, publishing it, and revising a
                           published one with its reason
    services/access-service.ts
                           who opens what, and who there is to grant to
    actions/access.ts      setAccess — one person's whole access, in one write
    services/distributor-service.ts
                           who bills a shop, which shops an account bills for,
                           and who may be named as a distributor at all
    actions/third-party.ts converting a lead, and the arrangement's own CRUD
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
    dictation-requests.ts  the same feature as a REQUEST — readiness, the two
                           calls, and the ONE copy of the six refusals. Two
                           doors read it: the CRM's session-authenticated
                           api/dictate/*, and the handset's token-authenticated
                           api/mbos/dictate/*
    jobs.ts                scheduled work, idempotent and hand-triggerable
    result.ts              the Result type every action returns
    queries.ts             every scope-aware read
    actions/               every write
    actions/sales-manager.ts
                           assignSalesManager — the third seat, by ids or by
                           the filters the list is showing
    journeys.test.ts       the six §11 journeys, end to end
    format.ts merge.ts csv.ts scope.ts auth.ts
  lib/admin-routes.ts      every console address and its tabs — build links
                           from ADMIN, never a literal (a test greps for one)
  lib/admin-redirects.ts   where every old console address lives now
  lib/config/settings-pages.ts  settings-placement.ts
                           which settings pages exist, who may open each, and
                           which page, tab and group every setting sits on
  scripts/parse-catalogue.mjs
                           document → src/db/catalogue-seed.ts, by hand
  scripts/grant-app.ts     give somebody an app, by hand
```
