# HRMS, workday clock, holidays

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**THE WORKDAY CLOCK: PUNCH IN, BREAKS, IDLE AND THE LOCK (Nov 2026).** An
office day is a list of working stretches — `hrms_attendance.sessions`,
`[{ in, out, end, reason }]` in epoch ms, the MBOS handset's own shape — and a
break is the gap between two of them. `check_in`, `check_out` and
`stoppage_min` are MIRRORS of the list (first in, last out once closed, the
gaps), written in the same update, so the register, the monthly summary and
payroll read the row they always did. A row with an empty list is one
stretch from check-in to check-out, so nothing recorded before moved. The
rules are pure in `lib/hrms/engines/workday.ts`; `services/workday.ts` settles
and mirrors; `workday-ops.ts` is break, resume, punch in again, the heartbeat
and claims; `/api/workday` is the one door the screens use. The words are the
handset's: PUNCH in and out is the day, CHECK in is a shop.

**EVERY AUTOMATIC BOUNDARY IS DATED FROM THE LAST ACTIVITY.** Idle
`hrms.workday.idleBreakMinutes` (30) is a break starting at the last activity;
idle `idleOutMinutes` (60) closes the day there; a manual break longer than
`breakOutMinutes` (120) closes the day where the break began. The server
notices whenever something reads the day (`settledToday`), and because the
boundary is backdated it does not matter how late — an idle hour is never
counted as work, and no job has to run every minute. Activity is any input in
any MahekOne tab (shared through a BroadcastChannel and localStorage) or an
open call drawer (`data-workday-busy`); the browser sends a heartbeat at most
once a minute, and only a running stretch takes one.

**NOBODY IS IDLE BEFORE THE OFFICE CLOSES (Nov 2026).** Office staff work in
the field, in Tally and on the phone, none of which MahekOne can see, so the
idle rules wait for `hrms.workday.idleFromHour` (18, 6 PM; 0 runs them all
day). Before it there is no automatic break, no punch-out and no warning on
any screen. From it the idle clock counts from the cut-off or the last
activity, whichever is later, and an automatic punch-out is never dated before
the cut-off: worked at 6:10 and nothing since is punched out at 7:10, dated
6:10; idle since 4 PM is punched out at 7:00, dated 6:00. `cfg.idleFrom` in
`engines/workday.ts` is the rule; the browser reads the same value so the
warning keeps quiet too. A manual break still closes the day after
`breakOutMinutes` whatever the hour.

**PRESENT, HALF DAY OR ABSENT IS HOURS WORKED, breaks left out.**
`hrms.attendance.presentHours` (8) and `halfDayHours` (4), overridable per
weekday on People → Working hours (`hrms_staff_timings.present_min` /
`half_min`) and stamped on the day at punch-in, like the office hours. The
same rule as the handset. `dayFigures` reads them before the old percentage,
which only a row with no hours (tests, tools) still uses; below the half-day
hours a day is "Absent". Sundays and other week-off days (a weekday the
person's working hours do not cover), holidays and approved leave are never
Absent; worked anyway, the day is `off_day` and "Extra" — counted by no
payroll figure. Half a day of leave lowers the bar to the half-day hours.

**THE LOCK IS ON** (`hrms.workday.lockEnabled`, on by default since `0333`;
it shipped off and Mahek asked for it on). Every app is covered — header and sidebar too — before punching in, on a
break and after punching out, and `requireUser` REFUSES SERVER ACTIONS for
that person — every one that signs in through it, which is every app's
context and capability check (it asks `serverLocked` when the request carries
`next-action`), and REFUSES PAGES too: a locked page request is redirected to
`/apps?next=<address>`, where the lock screen is drawn, and punching in carries
on to that address (`lib/workday-lock-paths.ts`; `x-mahek-path` from the proxy
says which page). Only the launcher, sign-in and `/api/*` are left open. That is why punching in,
resuming and punching out go through `/api/workday`, a route: the way out of
the lock is never behind it. Never locked: no HRMS grant, no employee link, a
`field` app holder (the handset holds their day), a day off, a day already on
the handset. Platform administrators are locked like everybody else since
`0341` (Mahek: "literally no one"); `exemptPlatformAdmins` is off by default,
and the lock screen always offers Punch in, so nobody is locked out for good.
`serverLocked` caches its answer ten seconds per person and guards its own
re-entry (`hrmsContext` calls `requireUser`).

**AN AUTOMATIC BREAK IS NEVER QUIETLY TURNED BACK INTO WORK.** "I was working
away from the screen" is a `hrms_workday_claims` row the person's manager (or
HR) decides on Attendance → Corrections; nobody decides their own. Approved,
its span counts as worked and comes off `stoppage_min`; declined needs a
reason and the person is told. Attendance → Team today is the live board.
The provider is mounted by `AppFrame` and the launcher; the timer rides with
`NotificationBell`; `LauncherCheckIn` is now the day card (`DayPanel`). Desktop
punch-in never uses a camera.

**LOCATION IS RECORDED, NEVER A GATE (Nov 2026).** A desktop has no GPS; the
browser guesses from the network and lands 2–3 km out, so the office geofence
refused people sitting at their desks and the lock kept them out of every app.
`decideCheckIn` now refuses only "already in" and "late", `decideCheckOut`
never refuses, and a blocked location still punches in. The fix and its
distance from the office are stored on the day when the browser gives one, so
HR can still read where somebody punched from. QR check-in is unchanged.

**THE HRMS IS SIMPLIFIED TO THREE ROLES, AND CHECKING IN LEFT IT (Nov 2026).**
The role is the level on the HRMS grant, given on the Access screen: an
ASSOCIATE sees their own days, leave, pay and score; a MANAGER sees their team
— the org chart's — and decides its leave; the HR TEAM (the admin level) sees
everybody and runs pay, offices and settings. `HrmsGate` in
`lib/hrms/registry.ts` puts a `min` level, and the powers that open it anyway,
on a screen or a tab; `hrmsContext` opens only the lists a gate lets through,
and `holdsScreen` asks for a screen by its lists, because a screen key is a
grant and not always a list (`kpi` — Performance — lost the daily sales entries
it opened on and kept its key). `scopeOf` reads manager as TEAM now, where it
read everybody. A manager decides their team's leave (`decidesLeaveFor`),
approves their team's help requests (`resolvesHelpFor`) and verifies their
team's expense claims (`verifiesExpenseFor`) — never their own — all through
`managesFor`, checked in every handler against the one row; it adds nothing to
`granted`, so it widens no list, and grievances stay private. Tasks, My tasks,
the Sales desk and the daily sales entries were taken out at the client's
request and their server code DELETED; their tables and rows are kept, every
handler is `retired` in the feature ledger's `MOVED`, and `0328` deleted the
module rows naming them. The Performance score counts only what is still
recorded: hours and punctuality for everybody, and a salesman's field-work and
sales points only for a period with daily sales entries — a part with nothing
behind it is left out, never scored 0 or 100. Checking in and out is the
launcher's: `LauncherCheckIn` (`components/checkin/`) draws a strip and a
dialog that opens once a day, the same `hrmsCheckIn`/`hrmsCheckOut` actions
behind it — and HRMS Home draws the SAME strip, because somebody whose only app
is HRMS goes straight into it and never sees the launcher (one remembered key,
so nobody is asked twice). `npm run report:hrms-managers` lists every
manager-level grant with the team it now sees. The shell wears the v4 frame
(`data-v4-app="hrms"`).

**THE HRMS IS FOURTEEN SCREENS, AND ITS OLD SCREENS ARE TABS.** The first
build copied Mahek EMP 2.0 one AppSheet view at a time — 41 screens, the same
list drawn three ways under three grants. A tab (`views` in
`lib/hrms/registry.ts`) keeps its key, its server module, its actions and its
forms, and is opened by holding its screen, exactly as the ERP's are; every
stored link naming `approvals` or `pendingOut` resolves through `hrmsPlace`.
Org chart stays a screen of its own because moving a reporting line moves CRM
sales-manager seats, which is a different grant from the directory.

**NOTHING THE FIRST BUILD DID MAY GO MISSING, AND A TEST SAYS SO.**
`lib/hrms/feature-ledger.ts` froze the 169 handlers the first build had and
pins every non-handler feature to the file and line that does it. A handler
that disappears without a recorded destination, or a new one nobody wrote
down, fails `feature-ledger.test.ts`. Change the ledger in the same commit as
the thing it records.

**A STORED HRMS WORD IS SPELLED ONCE, in `lib/hrms/values.ts`.** "Solve",
"Requesting", "24*7" and the AppSheet help types were renamed in the data
(`0202`); compare against the constants, and read anything arriving from an old
file through `fromOld`.

**A POWER HELD BY POSITION DOES NOT WIDEN A LIST.** A department head marks and
checks out staff because of their job title; `HrmsContext.granted` is the
powers somebody actually granted, and only those make `scopeOf` answer "all".
What a head may act on is `staffInReach` — their team and their office — and
it is checked in the handler, not by which rows are drawn.

**"MY TEAM" IS THE ORG CHART.** `HrmsContext.team` is the people the chart
names this person as manager of, plus — for anybody the chart has not placed
at all — those whose sheet Report To is this person's job title. It used to be
the job title alone while the CRM read the chart, so one reorganisation moved
accounts and not attendance.

**HRMS USES THE SHARED RECORD WHERE ONE EXISTS.** HR's documents are rows of
the company library (`mbos_documents.audience` says who in HRMS one is for; a
link or an office-only document is kept off the handsets), withdrawn and
tombstoned rather than deleted. Announcements — HRMS's and the Sales
Dashboard's "Send a notification" alike — go through
`services/announcement-service.ts`, which remembers the bell rows it wrote:
seen is the bell's read mark, an edit rewrites the bell, a delete leaves it.
The Sales desk stays in HRMS (see `docs/hrms/04-HRMS-RESTRUCTURE.md` for why),
but its calls and its activities reach the customer's shared timeline.

**ONE RECORD OF WHO WAS AT WORK, AND WHO WAS AWAY.** A field salesman checks in
and asks for leave on the handset; HRMS read neither, so payroll counted his
working days as missing. `attendanceRows` now reads his handset days as
register rows (method `field`, ids `mbos:…`, `isFieldDay`) for anybody whose
account is linked to their employee record, and `approvedLeave`/`fieldLeave`
read his handset leave in HRMS's shape. Both are READ-ONLY in HRMS: they are
corrected and decided where they were made. A web check-in is refused when the
handset holds the day. The other way, the field attendance verdict reads leave
approved in HRMS. Holidays are one calendar (`services/holiday-calendar.ts`):
HRMS's is the master, a holiday for everybody is also a row of
`mbos_holidays` under the same id, and the Sales Dashboard's Holidays screen
writes through the same service.

**A HOLIDAY HAS A LEVEL, AND WHO IT REACHES IS RESOLVED PER PERSON.** Company,
state, district, city, area or named people (`HOLIDAY_LEVELS` in
`lib/engines/holiday-audience.ts`, pure and the one statement of the rule).
The places are PICKED from the reviewed `places` tree, never typed — a typed
"where" could not be matched to anybody, which is why the server used to read
every holiday as everybody's and the handset read only the ones with no place.
A state reaches everybody allocated that state or a city or beat inside it; a
district its cities; a city itself and its beats; an area its beat. A manager's
`region` oversight patch is not "working there" and reaches nothing. On top of
the level, `mbos_holiday_assignments` gives a day to ONE person (`include`) or
takes it from him (`exclude`, which needs a reason and wins over everything).

**`mbos_holiday_members` is a CACHE**, rebuilt by `rebuildHolidayMembers` after
every holiday save, every allocation, every `setWorkingTerritories`, and
hourly and nightly as the net under them. It lists non-company holidays only;
`holidayAppliesSql` (`lib/holiday-sql.ts`) is the one SQL reading — company and
not excluded, or listed — and the attendance verdict, leave on the handset's
sync, the salesman's journey calendar and the pull all ask it. The team-level
readers (the performance forecast, the command centre, the qualification
call's next working day) read `level = 'company'` only, because one state's
festival is not a day the company is shut.

**THE HANDSET HEARS IT WITH NO UPDATE.** The wire is unchanged — the same five
columns — and `universal` now means "this one is HIS", which is exactly what
the phone's attendance engine and leave form already read it as. A rebuild that
moves who a holiday reaches also moves its `updated_at`, and an allocation
always does, so the delta carries the change. `scope` on the wire is
`audience_label` ("Odisha", "2 named people", null for company-wide). Rows typed
before levels existed were migrated as `company` (how the server already read
them) and keep their text in `scope`, which the Holidays screen flags.

**The employee master began as a mirror of the sheet; HRMS now owns what it
touches.** (This paragraph used to say nothing on HRMS's screens could be
changed. That stopped being true when HRMS learned to sign people up and edit
them.) The People screen (`lib/hrms/screens/people.ts`) has **Sign up an
employee** (`source = 'hrms'`), **Edit** (the HR power), **Edit my details**
(the person: their own contact details and family dates), Deactivate, and
**Delete** (the HRMS administration power, through the `hrms-employee` impact
modal). An edit stamps `hrms_decided_at`, and from then on the sync never
overwrites, withdraws or reparses that row — the same discipline
`customers.am_decided_at` keeps for the sales seats — so HR's change is not
undone by a sheet that still says the old thing. A name edited here is carried
to the account and the customers' seat copies (`renameEmployee`). Delete is
refused while the person has ANY history (`employeeDeleteRefusal`: deactivate
instead, because every HRMS table cascades from the employee) and while a
sheet-sourced row is still present on the sheet (the next pull would bring it
back). A row nobody has touched in HRMS is still the sheet's. The sync is
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

**REMOVING A PICK-LIST VALUE SAYS WHO STILL CARRIES IT.** Pick lists → Remove a
value goes prompt → impact (`hrms-pick-list-value`, id `impactPart(list,
value)`, HRMS administration power). `STORED` in
`lib/impact/kinds/hrms-ref-lists.ts` maps each list to the text columns that
copy it (Position types → `employees.department`, Positions → `position` and
`reports_to`, Bank names, Areas, holiday category/name, expense
category/particular/location, asset names); a list not mapped there is said as
"stored nowhere by name". Records keep the value; add a mapping when a new form
starts saving a list.

**The person a record belongs to changes it from its own row (Nov 2026).** HR
edits an asset assignment (quantity never below what came back, date,
responsibility) and deletes one made in error — the `hr` power, not only the
HRMS administrator, since HR is who assigns. Whoever asked edits a pending help
request's times and details (the type stays). Whoever raised a grievance
WITHDRAWS it while it is Pending: status `Withdrawn` (`GRIEVANCE_WITHDRAWN`),
kept, and the addressee and resolvers are told. The claimant edits or
withdraws a pending workday claim — their row offers that and never the
decision; `withdrawn` is a real status (`0368_hrms_workday_claim_withdrawn`,
whose check constraint is now declared in the schema too) and the time stays a
break. Documents: whoever manages them edits title, description and audience;
an audience that takes a document off the handsets writes the same
`mbos_deletions` tombstone a withdrawal does. Every new handler is in
`feature-ledger.ts` ADDED.

