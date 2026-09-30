# HRMS build plan (working notes for the build)

Sources, in order of authority:

1. `02-HRMS-FUNCTIONAL-SPEC.md` — the business RULES (formulas, validations,
   messages, who may do what). Where the design prototype computes something
   differently (payroll, performance points), the spec wins.
2. `Mahek HRMS.dc.html` — the SCREENS: which screens exist, their columns,
   groups, chips, forms, actions, bulk actions, labels and wording, the home
   check-in card, calendar/chart views, overlays. Where the spec is silent, the
   design wins. Script is at the bottom of the file (`S`, `FORMS`, `ACTS`,
   `BULK`, `MODS`, `ROLES`).
3. `01-HRMS-PRD.md` — scope, integration and the open questions.

## Architecture

HRMS is built on the ERP's generic screen engine, not a copy of it.

- `src/lib/erp/ui.ts` — the client/server contract (ListSpec, ListRow, FormSpec,
  ActionSpec, BulkSpec, PromptSpec, FieldSpec, When). HRMS uses these types.
- `src/app/erp/_ui/*` — the generic list screen, record drawer, form drawer,
  prompt, confirm, field. They take a **ScreenKit** (`kit.tsx`): the four
  server actions, the upload URL and the flag/status vocabulary. ERP passes its
  own; HRMS passes `HRMS_KIT` (`src/app/hrms/_ui/kit.ts`).
- `src/lib/hrms/` — the HRMS server side:
  - `registry.ts` — groups, screens, slugs, views (tabs). One list for the
    sidebar, the module guard (`lib/modules.ts`) and the Access screen.
    Module key = `hrms.<screenKey>`.
  - `powers.ts` — the special powers (pure). `access.ts` — `hrmsContext()`:
    user, linked employee, level, powers, screens held, scope.
  - `server.ts` — `HrmsScreenModule`, `hrmsAudit`, id/series helpers, parsers
    (re-exported from `lib/erp/server.ts` where identical).
  - `vocab.ts` — HRMS flags and status tones (pure, client-safe).
  - `engines/*.ts` — PURE rules (no I/O): attendance, leave, payroll,
    performance, tasks, calling. Tested in `engines/*.test.ts`.
  - `services/*.ts` — data reads shared by several screens (employees,
    timings, attendance day, balances…).
  - `screens/<group>.ts` — one `HrmsScreenModule` per screen key:
    `load(ctx) → { spec, rows }`, `actions`, `bulk`, `forms`, `formLoaders`.
  - `screens/index.ts` — the map key → module.
  - `jobs.ts` — scheduled work (monthly leave credit).
- `src/lib/actions/hrms-screens.ts` — the doors (`hrmsRunAction`, `hrmsRunBulk`, `hrmsRunTool`,
  `hrmsSubmitForm`, `hrmsLoadForm`) plus check-in/out, settings, EOD.
- `src/app/hrms/` — `layout.tsx` (HrmsShell), `page.tsx` (home: check-in),
  `[slug]/page.tsx` (every list screen), special views (calendar, chart),
  overlays (payslip, EOD, QR, import, document viewer), `settings`.

## Rules every screen module follows

- The server decides every rule: rows, scope (mine / team / all), which columns
  a power reveals (`pw` on a column), which actions a record offers and **why**
  one is unavailable (`why`). The client only draws.
- Every write re-checks the screen (`requireHrmsWrite(screen, power?)`) and any
  power the act needs. A hidden button is not a permission.
- Every write goes through a transaction where it touches more than one row,
  and lands in the audit log (`hrmsAudit`).
- Money is paise (integer). Dates `YYYY-MM-DD` strings. Times `HH:MM`
  strings. Durations minutes (integer).
- Business date/time is Asia/Kolkata: use `today()`/`nowHM()` from
  `lib/hrms/server.ts`, never `new Date().toISOString().slice(0,10)`,
  never `getHours()` (grep guards in the test suite fail the build).
- Never put a backtick inside an sql`` template.
- Validation messages are the source's words (spec §§4–17), returned as
  `fieldErr` so they land under the field.
- Scope: `own` rows are the signed-in employee's; *team* = employees whose
  Report To equals my position (heads); *all* = managers/admin and the
  matching power.

## Tables (migration `0187_hrms.sql`)

`employees` gains: source, hrms_decided_at, position_type, photo/ID-card
attachment ids, full account number and Aadhaar (read with a power only),
five sales targets, monthly paid leave (numeric), yearly max leave, legacy
permissions, office_id.

New: hrms_offices, hrms_staff_timings, hrms_attendance, hrms_leave_requests,
hrms_leave_credits, hrms_holidays, hrms_overtime, hrms_monthly_remarks,
hrms_salaries, hrms_advances, hrms_expenses, hrms_task_templates,
hrms_checklist, hrms_todos, hrms_buddy_tasks, hrms_kpi, hrms_reviews,
hrms_calling, hrms_activities, hrms_journeys, hrms_asset_stock,
hrms_asset_assignments, hrms_help, hrms_grievances, hrms_documents,
hrms_notifications, hrms_ref_lists, hrms_user_powers, hrms_series.

Customers stay MahekOne's `customers` (Sales desk reads and writes them).

## Screen modules and who builds them

| Group file | Screen keys |
|---|---|
| attendance.ts | attendance, pendingOut, absentees, attChart |
| leave.ts | leave, approvals, leaveCal, leaveSetup, holidays, overtime, monthly |
| pay.ts | payroll, advances, expenses |
| tasks.ts | templates, checklist, todos, buddy |
| perf.ts | kpi, salesPerf, staffPerf, eom, points |
| sales.ts | customers, calling, activity, journey |
| people.ts | employees, idCards, offices, timings, assetStock, assignments |
| misc.ts | help, grievances, documents, notifications, refLists |
