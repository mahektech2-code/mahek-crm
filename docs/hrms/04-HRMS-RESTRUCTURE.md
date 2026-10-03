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
| D1 | The Sales desk leaves HRMS: customers and calling go to the CRM, sales activity to field visits, the journey planner to field journey plans. |
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
| Sales desk | *(until D1 lands)* Customers · Calling · Sales activity · Journey planner |
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
