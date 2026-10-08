# HRMS restructure

The first HRMS build (PR #495, #503) copied Mahek EMP 2.0 one AppSheet view at
a time: 41 screens, AppSheet's own wording, and several things MahekOne or the
field handset already had, rebuilt beside them with separate data. This is the
restructure, done the way the ERP's was (#482–#486): one job per screen, the
same list never drawn twice, plain words, and the shared record used wherever
one exists — **without losing a feature, a function or a rule.**

## How "nothing lost" is enforced

`src/lib/hrms/feature-ledger.ts` froze every server handler of every screen as
the first build had them — 169 actions, bulk actions, forms, form loaders and
header tools — and lists every non-handler feature (check-in rules, payroll
formula, PDFs, jobs, views, badges) with the file and line that does it.
`feature-ledger.test.ts` fails the build if a handler is neither where it was
nor accounted for (moved, handed to a shared feature, or retired as dead code
with a reason), if a destination does not exist, if a feature's marker leaves
its file, or if a new handler appears without being recorded.

## Decisions

| | Decision |
|---|---|
| D1 | ~~The Sales desk leaves HRMS.~~ **Deviation, deliberate:** it stays as one screen with four tabs, and uses the shared records instead — see below. |
| D2 | One attendance, leave and holiday record across HRMS and the field handset. |
| D3 | One document library: the field app's, with HRMS's audiences added. |
| D4 | One sender for announcements, shared with the Sales Dashboard's; the bell's read mark is the only read state. |
| D5 | "My team" reads the org chart, falling back to the Reports-to job title only for people the chart has not placed. |
| D6 | The three performance formulas stay, each named for what it measures; one financial-year start date. |

## The screens

| Screen | Tabs |
|---|---|
| Check in | — |
| Attendance | Register · Not checked out · Absent · Monthly summary · Chart · Overtime (when on) |
| Leave & holidays | Requests · To decide · Calendar · Holidays · Monthly credits |
| Tasks | Checklist · To-dos · Buddy tasks · Templates |
| Pay | Salaries · Advances · Expenses |
| Performance | Daily sales entries · Sales score · Staff month · Employee of the month · Period review |
| Sales desk | Customers · Calling · Sales activity · Journey planner |
| People | Directory · ID cards · Working hours |
| Org chart | — (its own grant: it moves CRM sales-manager seats) |
| Offices | — |
| Assets | Stock · With people |
| Help & grievances | Help requests · Grievances |
| Documents | — |
| Announcements | — |
| Settings | Rules · Pick lists |

A tab keeps the key, the server module, the actions and the forms of the
screen it used to be, and is opened by holding its screen
(`lib/hrms/registry.ts`). Migration `0201_hrms_screens_merged` moves any
screen-level grant onto the screen the tab now belongs to; `next.config.ts`
redirects every old URL to its tab.

## The pull requests

1. Tabs, the ledger and its test, the new sidebar, redirects and the grant migration.
2. Plain words for every AppSheet message, label and status.
3. The bugs the audit found.
4. HRMS copies handed to the shared MahekOne features (D1, D3, D4, D5, D6).
5. One attendance, leave and holiday record across HRMS and the handset (D2).

## Why the Sales desk stayed (D1)

Moving it out was the recommendation, and building PR 4 showed it would lose
features, which the restructure may not do:

- **Calling** is an area-wise list a back-office person takes from their own
  customers, with a second status when nobody picks up, a miss count and a
  follow-up date. The CRM's Call Log is a ranked queue built from buying
  cycles; it has no way to take an area into a list, and its outcomes do not
  map one to one.
- **Sales activity** is a meeting logged from a desk, with time given, mood,
  issue and purpose. A field visit is a GPS check-in made at the shop; a visit
  written from the office would be a visit with no evidence behind it, which
  the field app's own rules refuse.
- **Journey planner** plans a date range with a customer list and a photo; the
  field app's journey plans are one day each, agreed between office and
  salesman.

So it stays, and is joined to the shared records where they are the same thing:
the customers are MahekOne's own `customers` (a deactivation asked for here is
the same request the CRM's status queue shows), and a call or an activity
logged here lands on the customer's shared timeline. Its tables are empty on
production, so moving any of it later costs no data.

## What else differs from the plan

- **Employee of the month** stayed a tab rather than becoming a filter on Staff
  month: it is the same calculation, one tab is drawn at a time, and a tab is
  the plainer way to ask "who won".
- **D2 reads one record rather than writing one table.** The handset cannot be
  recalled — an APK in somebody's pocket keeps writing `mbos_attendance_days`
  and `mbos_leave_requests` — and the two leave policies differ (HRMS credits
  paid leave monthly and splits it at approval; the field app has casual, sick,
  earned and loss-of-pay with an annual entitlement). So HRMS READS the
  handset's days and leave wherever it counts attendance or absence — the
  register, the monthly summary, the absentee list, payroll — and the field
  verdict reads HRMS's approved leave; each is still decided where it was
  asked for. Holidays are genuinely one calendar, written in one place.
