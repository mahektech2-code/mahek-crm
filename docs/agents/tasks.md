# Tasks

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**A TASK BELONGS TO ONE PERSON AND NAMES ONE APP.** `tasks.assignee_id` is
who owes it and `tasks.app` is where its work happens (`crm`, `accounts`…, or
`tasks` for a personal one), so one row is on the Tasks app (`/tasks`) and on
that app's own My tasks screen — TeleCRM's at `/crm/tasks` (module
`crm.tasks`), Accounts', Sales', the ERP's and HQ's at
`/<app>/my-tasks`. Rules are pure in `lib/tasks/rules.ts`, reads in
`lib/tasks/service.ts`, every write in `lib/actions/tasks.ts`; each action asks
`taskDetail` — the answer the screen drew its buttons from — before it writes.

**CLOSING IS A STATEMENT WITH EVIDENCE.** Mark done is two steps: tick "it is
done" (always), then a remark and a screenshot, each REQUIRED OR OPTIONAL as
the creator chose (`remark_required`, default required, and `proof_required`),
both editable by the creator or a manager above the assignee. An optional
remark left empty is stored as `''`, so the check constraint still holds. `closeProblems` is asked on the screen and again in
`closeTask`, and a check constraint holds `closed_at`, `closed_by_id` and
`close_remark` to the status. A screenshot counts only if THIS person uploaded
it (`/api/tasks/proof`, a route because an action's body stops at 1 MB) and it
is not bound to anything else; `closeTask` binds it under parent `task`, and
`canRead` lets whoever can see the task open it.

**A TRANSFER IS A REQUEST UNTIL SOMEBODY ACCEPTS IT.** The assignee asks, with
a reason; the task stays theirs while a `task_transfers` row is pending (one per
task, a partial unique index); the other person reviews it and accepts, or
rejects with a reason. A manager ABOVE BOTH PEOPLE moves it at once
(`managesBoth`) — written as a row already decided, `moved`. Closing a task
withdraws any request still open on it.

**THE TEAM IS THE ORG CHART, not a capability.** `teamOf` is everybody below a
person: `users.reports_to_id`, then the HRMS line through `users.employee_id`,
then the HRMS line by name. That set decides who a manager can give tasks to,
whose tasks they see, and what they move without asking. Giving a task to
somebody who holds neither Tasks nor its app is refused, because they would
never see it.

**A TASK LIST IS READ ONE PAGE AT A TIME, AND THE PAGE IS IN THE URL.**
Every screen used to fetch everything a person could see — capped at 500 to
2,000 rows, silently — and count, search, group and page in the browser, so
past the cap the counts were wrong and nothing said so. Now a list is a scope,
the URL's reading (tab, app, source, search, grouping, page, per page —
`lib/tasks/list-query.ts`, pure) and the date, and `taskListPage`
(`lib/tasks/list-service.ts`) counts every tab, counts each group on the page
across EVERY page, and returns one page; `TaskListView` (`_ui/task-list.tsx`)
draws it and writes the next URL. `groupKeyOf` is `groupKeySql` in the
browser, and a test holds the two together. My day, the Board and the
Calendar draw a capped preview (`PREVIEW_ROWS`, 50 a column, 20 a day) with
the real count beside it and a link to the list; Team workload is figures per
person from one grouped read, a page of people at a time; Assigned by me pages
its groups and shows two dozen faces per group. "Select every match" asks the
server (`taskIdsMatching`, `BULK_CAP`), and Export streams the whole filtered
list from `/api/tasks/export` (`EXPORT_CAP`). A team is asked through
`teamInSql` — one array parameter, or `users` itself for somebody whose
permission reaches everybody — never an `in (…)` of every id. `0323` adds the
indexes these reads lean on. A new list reads through `taskListPage`; never
fetch a person's tasks whole.

**AND FOUR PERMISSIONS WIDEN IT, one reach each.** The org chart cannot say
"the office coordinator chases everybody", and the only way to say it was
platform administrator, which grants every app in the building. So
`lib/tasks/permissions.ts` names four, ticked per person under Tasks on Admin
Console → Access and stored in `task_user_powers`: see everyone's tasks, give
tasks to anyone, manage anyone's tasks, run the automatic tasks. `teamOf` takes
the QUESTION — `see`, `give` or `manage` — because reading somebody's list,
putting work on it and changing what is there are three different kinds of
trust; it defaults to `manage`, the narrowest, so a caller that forgets to say
which it means grants the least. Manage implies see and nothing else implies
anything. A Tasks ADMINISTRATOR (the admin level on the grant) and a platform
administrator hold all four without a row — the rule HRMS and the ERP follow
for their powers — and taking Tasks away takes the rows with it.

**WHO GETS IT IS AN AUDIENCE: INCLUDE AND EXCLUDE RULES.** A rule names a
person, a team (everybody under a manager), an HRMS designation or department,
a level in the task's app, an ERP designation, or everybody.
`lib/tasks/audience.ts` is the rule, pure, run by the builder's live preview and
again on the server (`resolveFor`, never the screen's list): a person EXCLUDED
by name never gets it, a person INCLUDED by name always does — even where their
team or designation is excluded — and everybody else gets it when a group
includes them and no group excludes them. The candidates
(`audience-service.ts`) are the giver and their team who HOLD THE TASK'S APP
(Tasks itself for a personal task), so the builder offers only those people and
only the designations, departments, teams and levels found among them. A
one-off task resolves once and stores the rules on its `task_batches` row.

**A ROUTINE IS A TASK THAT COMES BACK, and it writes ordinary tasks.**
`task_routines` holds the schedule — daily or weekly on named weekdays, or
monthly on a day with an optional done-by day — and on each day it falls due
`writeRoutineTasks` adds one `tasks` row per person naming the routine and the
day. A routine is for ONE PERSON (`assignee_id`) or for an AUDIENCE
(`audience`, re-resolved on every day it runs against whoever its creator can
reach that day — a new joiner with the designation picks it up, a creator who
left reaches nobody). A partial unique index on (`routine_id`, `assignee_id`,
`routine_day`) is the whole of the idempotency, which is what lets the hourly job, the nightly one and the Tasks
layout (for whoever opens it) all ask for today safely. The day rule is pure
in `lib/tasks/routines.ts` (`occurrenceOn`); a routine for the 31st lands on a
short month's last day. Whoever set it, or anybody above its person, manages
it (`canManageFor`) — a routine given by rules belongs to whoever set it and
anybody above them; its person reads it. A change reaches the days to come
and never rewrites a task already written. Nobody is notified per day — a
bell for fifteen daily tasks is a bell nobody reads.

**A ROUTINE'S TASK BELONGS TO ITS OWN DAY, AND IS MISSED IF IT IS NOT DONE ON
TIME.** Past its due time — the end of its due day where no time is set — it
is closed as `missed` (`tasks.status`, `0334`): closed at the deadline, by
nobody, with "Not done by 6 PM on 14 Nov." as its remark. It cannot be closed,
reopened or edited afterwards, and a routine task's due day and time cannot be
moved, because moving them is the way round it. Yesterday's is not done today;
today's is today's own task. `routineMissed` in `rules.ts` is the rule, pure;
`markMissedRoutineTasks` closes them hourly, nightly and whenever somebody
opens the Tasks app or an app's My tasks; `closeTask` asks the rule again and
marks the task missed itself, so the hour between two sweeps is never a way
in. A done routine task can be reopened only while its time is still running.
Saving a routine does not write today's task if its time has already gone.
`isClosed` is "done or missed": open is `status <> 'done' and status <>
'missed'`, written as two inequalities so the open-task partial indexes still
apply. A task given by hand, or an automatic one, is never missed — it goes
late. Missed shows as its own tab and on Team workload. The rule starts at
`MISSED_FROM` (10 Nov 2026): a routine task due before it stays open and late
and may still be closed, so turning it on did not sweep the old backlog.

**AUTOMATIC TASKS ARE RAISED BY EACH APP AND CLOSED BY IT.** `lib/tasks/automations.ts`
(pure) lists the rules — a callback promised, a lead's next action, a complaint
past its SLA, a payment reported, an order or a PO waiting for approval, a
leave request — and `automation-service.ts` has one read per rule turning the
records that need somebody into the tasks that should exist; `planAutoSync`
says what to insert, bring in step (a reassignment, a new day) and close. A
task names its rule and record in `auto_rule`/`auto_key` (unique together), so
the hourly and nightly runs, a switch and "Run now" are all idempotent; a task
somebody closed by hand is never raised again for the same record. The rule
closes its own task with `closed_by_id` null and a remark, which the check
constraint allows only for an automatic task. A dated record raises a task
only within a month either side of today. Switching a rule on or off
(`task_automations`, no row = the rule's default) is a Tasks administrator's or
a platform administrator's (`setup-access.ts`); off closes what it raised. An
automatic task cannot be transferred or deleted — the app decides who holds it.

**THE SIDEBAR IS THE DESIGN'S.** My day, All my tasks, Board, Calendar (a week,
late work on today), Done (everything finished, by day), Transfers; My team
(Team workload with Nudge, Assigned by me); Set up (Routines, Automatic tasks —
module `tasks.setup`, at `/tasks/setup/…`; `/tasks/routines` redirects); By app
(`/tasks/app/<app>`, one per app the person has open work in). Each task says
where it came from (`TaskRow.kind`: auto, routine, assigned, self). The ✓ tasks
tray beside the bell (`components/shell/tasks-tray.tsx`, drawn by
`NotificationBell`) puts the next six open tasks in every app's header.

**The old AppSheet "Task EMP 2.0" workbook came in through
`npm run tasks:import-task-emp`** — the To Do List as tasks
(`tsk_taskemp_<id>`), the Task List as routines (`source = task-emp:<Sr. No>`),
people matched by name to LOGINS. Re-runnable; it never overwrites a row.

**Not built yet, and said so in the docs:** reminders and the CRM's automatic
follow-ups are not tasks (callbacks now arrive as automatic tasks; the rest
of the follow-up engine does not); a My tasks on the Factory phone app.

**EVERY APP HAS ITS OWN MY TASKS, AND IT IS ALWAYS OPEN.** `APP_TASKS_PATH` in
`lib/tasks/rules.ts` is where each lives — `/crm/tasks`, and `/<app>/my-tasks`
for Accounts, Sales, ERP and HQ, and for now no other app (`my-tasks`
because Sales already had a `tasks` meaning something else). A NEW task or
routine may be filed only under Personal or one of those apps (`canFileUnder`,
`TASK_FILE_APPS`), on the pickers and in the actions; a task or routine filed
under Hire, Enquiries, Website or Factory earlier keeps its app and is seen in
the Tasks app. Each is
`AppTasksPage` for its app: the viewer's own tasks of that app plus personal
ones (`shownInApp`), with what waits in other apps counted. Except TeleCRM's,
every one is in `ALWAYS_OPEN_MODULES` — `<app>.my-tasks`, and `erp.myTasks`
from its registry — and
`moduleAllowed` now answers yes to an always-open module whatever was ticked,
because a narrowed grant must never hide work somebody owes. Each is placed
last in its app's order so the "first screen they hold" landing never lands
there. A task's notification opens its app's My tasks (and so lands in that
app's bell); the header tray links to the current app's.

**"PAST ITS DUE TIME" READS ONE CLOCK, AND A TEST PINS IT.** `lib/tasks/clock.ts`
holds `tasksNow()`: `appClock()` (the JS check behind Mark done and the task
card) and `markMissedRoutineTasks` (which binds it in place of SQL `now()`)
both read it. `pinTasksClock(at)` holds it — refused outside NODE_ENV=test. The
routine "not done on time" tests pin noon IST on the business day: unpinned,
they failed for the grace time (≤15 min) after every midnight in India, when
yesterday's task was still in its grace and today's 00:00 task not yet past it.
A new Tasks check of "now" goes through `tasksNow()`, never `new Date()` or
`now()`. (`inGraceSql`, a display read, still uses `now()`.)
