# Salary, expense policy, expenses, travel legs

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**Salary is read, never written.** HR maintains the employee workbook, HRMS
mirrors it hash-for-hash, and the salary columns are already in it — so the
Sales Dashboard reads what payroll publishes and a correction is made in the
workbook. Days worked and reimbursements sit BESIDE the pay without being added
to it: a reimbursement is money owed back rather than earnings, and a single
figure combining them is neither. There is no incentive column, because
MahekOne sets no monthly target for a field salesman and a figure with nothing
to be computed from would be an invention on the one screen where a wrong number
is least forgivable.

**THE EXPENSE POLICY IS HARD-CODED, and that is a REVERSAL (Oct 2026).**
It shipped as versioned rules typed into the Admin Console — thirteen rule
kinds, grades, city classes, drafts, a simulator and a publish step over five
tabs — and it was too much to use: nothing was published, so every day reached
a manager unpriced. `lib/expense-policy-standard.ts` is now THE policy, one
for everybody, every city and every date, and `policyForDate` returns it. The
engine is untouched and still pure — it is handed this `Policy` exactly as it
was handed a published version, on the server and on the handset. The Admin
Console and the Sales Dashboard both draw `policyInWords()`, built from the
same rules, so the page and the arithmetic cannot disagree. Changing a figure is
a code change, on purpose, until making it editable again is decided. Days are
stamped `xpol_standard`, an ARCHIVED anchor row (`0228`, and `ensurePolicyRow`
on the write path) so `mbos_expense_days.policy_id` keeps its foreign key; the
old tables, actions and simulator are left in place and read by no screen. The
manager's Expenses screen reads "Asked for / Policy allows / Status", one
Review button a day.

**AND IT IS EDITABLE AGAIN, AS NAMED POLICIES — a second reversal (Oct 2026).**
The paragraph above is history: the figures in `lib/expense-policy-standard.ts`
are now only the standard policy's SHIPPED DEFAULTS. `expense_policy_sets`
(0241) holds named policies — the standard one (`xpol_standard`, seeded from
the code by `ensureStandardSet` the first time it is read, then the row is the
policy) plus any number of others — each a whole `PolicyRule[]` in one jsonb
column, saved whole with the revision it was edited from (a stale save is
refused, never merged) and snapshotted in `expense_policy_set_revisions`, so
History can restore any version as a new one. **No row in
`expense_policy_assignments` means standard**, so adding a policy moves nobody;
a switched-off policy hands its people back to standard without forgetting
them; one that has priced a day cannot be deleted, only switched off; the
standard one can be neither. `policyForDate(day, userId)` is the one lookup —
the claim path, the handset's pull and the simulator all pass the person — and
named policies carry no dates, so an edit applies from the next day worked out
and the next handset sync (today's and yesterday's allowances are re-worked at
once for whoever it moves). The editor (Admin Console → Expense policy → a
policy) is drawn from the same `RULE_KINDS` specs, a dropdown wherever the
answer is a list; `checkRules` in `lib/expense-policy-sets.ts` is run by the
screen on every keystroke and by `savePolicySet` before it writes, and refuses
two rules answering one question for the same grade and city class. Preview
and "Try a day" run over the UNSAVED rules with the real engine. Every write is
`expense.policy.write`. A named policy's id doubles as an archived anchor row in
`expense_policies`, written when it is created, so a day stamped with it keeps
its foreign key.

**THE STANDARD POLICY IS THE ISSUED DOCUMENT, and that dropped two things the
code used to pay (Oct 2026).** Mahek's written Expense Policy is the standard
policy's shipped figures, rule for rule (`STANDARD_DEFAULTS_VERSION` 2): a meal
needs him to have LEFT between 11 PM and 8 AM (breakfast ₹100, lunch ₹150), and
dinner (₹200) also needs him back after 10:30 PM — leaving after 8 AM earns
nothing; a hotel is a FIXED ₹450 a night, paid whatever the bill (`flatPerNight`,
and `decideExpense` approves that figure even above what he logged); a day room
nothing; the ₹250 dormitory is paid beside the day's meals; local travel at
actuals with no limit; a bill or a recorded trip with every claim
(`travelLogCounts`). Own vehicles are NOT in the document, so they are
`zero_rated` — the ₹3.50/km bike allowance is gone from the standard policy —
and a food bill pays nothing, because meals are the allowance. Each of these is
a field on a rule (`leftFrom/leftTo`, `returnedAfter/returnedBy`,
`awayFromHometownOnly`, `flatPerNight`, `travelLogCounts`), so any of it can be
undone or varied per policy from the editor. An untouched standard row
(`updated_by_id` null) moves onto a newer edition on its next read, with a
revision saying so; an edited one does not.

**A POLICY CARRIES ITS OWN GUIDELINES.** `expense_policy_sets.guidelines` is the
lines no rule can say — bills with every claim, advances by GPay, no calls after
hours — edited on the Rules tab, shown in Preview, on the Sales page and, first,
in the handset's policy sentences (no APK needed). **"Away from his hometown" is
decided by the office**: the handset always sends true, so `refreshDayMoney`
derives `departed_from_hometown` from `expense_hometowns` (set per salesman on
"Who is on which") against the towns of the shops he checked in at, the city he
named, and an overnight (`lib/expense-hometown.ts`, pure). With no hometown set
the recorded answer stands. The tour advance the document describes (GPay 1–2
days before a tour) is NOT built — there is no advance ledger yet.

**A HOMETOWN IS PICKED FROM THE REVIEWED TREE, AND IT LIVES BESIDE "WORKS".**
Typed, a hometown was a string the pay rule compared against shop towns read
through `placeNameSql`, so "Nagpur " or "nagpur city" matched nothing and made
every day an away day. It is now a city node of `places` (state › district ›
city), stored as `expense_hometowns.place_id` with the name and state beside it
(`0246`; a typed row that names exactly one city was adopted, the rest show as
"Typed"). It is set on the Sales Dashboard's Salesmen screen (`/sales/people`,
a Hometowns column, a "Hometown not set" filter and a banner counting the
backlog) and on each salesman's page, through `setSalesmanHometowns`
(`sales.people`, his manager's team), and on the Admin Console's "Who is on
which" through `setExpenseHometowns` (`expense.policy.write`). Both doors are
`HometownPicker` and both write through `writeHometowns` in
`services/hometown-service.ts`, which refuses anything that is not a city.

**A SALESMAN MAY HAVE SEVERAL HOMETOWNS, and a day in any of them is a day at
home.** He lives in one town and his family in another, or two towns run into
each other, and one hometown made every day in the second an away day.
`expense_hometowns` is one row per town, keyed on (user, town) since `0252`;
`awayFromHometown` takes the list and calls a day away only where it reached a
town that is none of them. The picker ticks towns across states and saves the
WHOLE set, so unticking a town takes it off and an empty set clears them. A
town typed before the picker stays only while the picker is told to keep it
(`keepTyped`), and that is never a way to type a new one in. Two picked towns
of one name are one hometown, because the rule compares names.

**A LOGGED BILL IS WORTH ITS OWN FIGURE.** `DayComputation.lineEligiblePaise`
is per line, and `writeLineFigures` reads it; it used to share the day's
eligible total in proportion to what was claimed, which with a ₹0 food bill
beside a bus fare paid the food bill part of the fare.
**THERE IS NO CLOSING A DAY, and that is a REVERSAL (Oct 2026).** A day used to
reach a manager only when the salesman pressed Close the day → Send day on his
phone, which priced it, LOCKED it and raised one approval for the whole day. In
ten days on prod one day was sent; a fortnight of travel and claims sat on the
server under "Not sent yet" and the field reported that expenses were broken.
Mahek's answer splits the money in two, and `lib/expense-money-sql.ts` is the
one statement of it:

- **An ALLOWANCE is automatic.** The meal allowance from his punch-in and
  punch-out, and the kilometre allowance on a trip by his own bike or car, are
  lines the office writes (`source_type` `expense_day` / `travel_leg`). They
  need nobody's approval and count as paid the moment they exist.
  `refreshDayMoney` writes them, and runs after every sync batch that touches a
  punch, a trip, a day or a logged expense, hourly over the last two days (the
  trail arrives late) and nightly back as far as a claim may still be logged.
  A trip that earns nothing — a walk, a company vehicle, no distance yet — gets
  NO line: a ₹0 allowance reads as money withheld, so one is never written and
  one written earlier is deleted when the trip stops earning.
- **An EXPENSE is what he logs** — a hotel, a food bill, a bus, train or auto
  fare. Each is its own `expense_claim` approval from the moment it lands,
  decided one at a time on `/sales/expenses` through `decideExpense`, which
  wraps `decideApproval` and adds only what is about money: a part approval
  must be above ₹0 and below what he logged, and an expense whose approval has
  not arrived yet gets one. A fare is NOT an allowance — the trip only earns
  kilometres on his own vehicle, so a fare nobody logs is a fare nobody pays,
  and "Bus or train" is a claim kind for exactly that.

Nothing locks. `handleTravelLeg` and `handleExpenseDay` no longer refuse a
"submitted" day, and an older phone's `expense_day_submit` is ACCEPTED as a
refresh so its outbox drains; delete that case once no build older than the
release carrying this is reporting. The handset learns all of it from
`expenseBook`, sent WHOLE every pull (`expenseBookFor`), because a decision on
an approval and an allowance re-worked from the trail move no row a cursor
could follow; `applyExpenseBook` upserts and drops only ALLOWANCES the office no
longer names — an expense he logged is never deleted on his phone. Every reader
that adds money up — the salary screen's reimbursement, the expense ROI report,
the salesman's profile — reads `paidPaiseSql` / `expenseStateSql`, never a day
approval. The per-day approvals already decided stay as the record they are;
`0240` deleted only the pending ones and the ₹0 lines the old close-the-day
wrote.

**THE EXPENSE LEDGER IS DERIVED, AND A REIMBURSEMENT IS PAID AGAINST THE
BALANCE.** Expenses → Ledger (`/sales/expenses/ledger`, and one salesman's
statement under `/[userId]`) answers what he claimed, what the policy allows
and why (`mbos_expense_exceptions` per line), what was approved, cut or
refused with the remark, what is waiting, what his work log earned, what has
been paid and what is owed now. `mbos_expense_payouts` (0245) is the only new
record: money handed over, never pinned to an expense — one transfer covers a
week — so `lib/engines/expense-ledger.ts` (pure) allocates it to approved lines
OLDEST FIRST on every read for the per-line Paid / Part paid / Not paid. "Owed
now" is all-time (a payment in October settles a September fare); a month only
narrows the rows drawn. A wrong payment is VOIDED with a reason, never deleted.
Recording one is a sales manager's (`sales.expenses`), audited, and the
salesman is told on his phone. Nothing here touches the policy.

**THE OFFICE CAN ADD AN EXPENSE FOR A SALESMAN, AND IT IS HIS EXPENSE.**
"+ Add expense" on every Expenses screen (`add-expense.tsx`, `addExpenseFor`)
writes exactly what the handset's claim sheet writes — an `mbos_expenses` line
of `source_type = 'manual'` under his day, priced by `refreshDayMoney`, with an
`expense_claim` approval raised in HIS name — so it is decided, paid and
reported like one he logged, and `expenseBookFor` carries it to his phone on
the next pull. `created_by_id` is who entered it, and the screens say
"Entered by". Bills go up through `/api/sales/expense-file` (a route, past the
action body cap) and are filed under it. "Add and approve" goes through
`decideExpense` and is offered only to whoever may decide expenses. It is
gated like a payout (`sales.expenses`, manager, own team) and audited.

**TRAVEL IS ASKED TWICE A DAY, AND NEVER AT A SHOP — a reversal (Sep 2026).**
The paragraphs below describe how a visit used to ask how he was travelling,
open a meter camera, and ask for the bus fare on the way out. The field would
not answer it: eleven shops is eleven questions. Now the vehicle is asked at
the PUNCH-IN, the meter is read at the PUNCH-OUT where the day started on one,
and nothing about travel is asked on the way to a shop, at the check-in or at
the check-out. `TravelGate` asks nothing: `visitLegPlan` (pure, in
`mbos-app/src/lib/travel-leg.ts`) records the visit's journey silently under
the day's own mode, so the arrival geofence and the dwell clock still work, or
records none where he never punched in — never a vehicle nobody named. A visit
leg never carries a claim: a meter day is priced by its two readings, and every
other day's fares are claimed in Expenses. The fare sheet at check-out is gone.

**After a punch-out that the meter did not measure, he is asked to raise the
day's costs.** `promptsForExpenses` decides it; the pop-up's button opens
Expenses with the claim sheet already up, and "Later" is always an answer — the
punch-out is done either way. A claim carries up to
`mbos.expenses.maxAttachments` files — photographs, several from the gallery at
once, or PDFs checked against `attachments.maxSizeMb` as they are picked — and
`handleExpense` files EVERY one under the claim, including a file the media
queue uploaded before the claim existed, parented to the handset's literal
`pending`. Only the claimant's own uploads are moved. Expense files had no read
rule and answered 404 to everybody; `canReadExpenseAttachment` reads them as
his mileage evidence is read — him, or a Sales Dashboard holder with him in
scope. The Decide dialog on `/sales/expenses` now shows each claim with its
files; before, a manager decided a day's money from two totals.

**TODAY'S TRAVEL READS; IT NO LONGER ASKS.** `/travel` (More → Today's travel)
outlived that reversal with an "Add a leg" sheet of its own — mode, from and
to, both meter readings, a photograph, a ticket fare and its PNR — which made
it a third door for exactly the two questions the punch and Expenses were
built to be the only ones asking, and a fare typed there was a second claim
for a ticket Expenses could not see. It lists the legs the day recorded on its
own, with what each is worth and why a visit's leg pays nothing inside a meter
day, and sends every cost to Expenses with the claim sheet up. Removing a leg
went with it: the legs are the app's record now, and a wrong one is a
manager's to correct. Nothing writes `origin = 'day_log'` any more; the column
value stays because legs already on the server carry it.

**HOW HE GOT TO THE SHOP IS ASKED WHEN HE SETS OFF, and "Start visit" now
means "I am setting off".** Pressing it opens `TravelGate` — the modes from
`mbos_travel_modes`, an admin's rows rather than a list in a screen — and the
visit stays LOCKED behind an "I have arrived" step until he says he is there.
That reversal is the point: starting the dwell clock at the tap would count the
ride as time in the shop, which is the one number the dwell check exists to be
honest about. Nothing new is priced by this. A leg it opens is the same
`mbos_travel_legs` row `/travel` writes, on the same `mbos_expense_days`, and
the policy engine decides what it is worth exactly as before — so a day's
reimbursement is one figure however its legs got there.

**A LEG NOW HAS A REAL GAP BETWEEN ITS TWO ENDS, which is a state `/travel`
could never express.** The day log writes `started_at` and `ended_at` in the
same breath, because it is typed up once the journey is over; a leg opened from
a visit sits with `ended_at` null while he is on the road. It is a ROW and not a
screen state — Android reaps this app on the road constantly, and a "travelling"
flag in memory would be gone by the time he arrived with the departure
photograph already taken and nothing left to attach it to. A partial unique
index keeps one open leg per person, at both ends: he cannot be travelling to
two shops at once, and two open legs would mean the arrival photograph had a
choice of which departure to close.

**THE METER IS PHOTOGRAPHED AT BOTH ENDS, because one photograph cannot show
two readings.** `odometer_photo_id` keeps exactly the meaning it had — a
day-log leg types both readings at once and photographs the meter as it stands
— and `odometer_end_photo_id` is its counterpart. The one that would otherwise
be missing is the DEPARTURE: the reading nobody can go back and check, because
by then the meter has moved. Both the reading and the picture are required and
neither is redundant — two photographs cannot be subtracted, and a figure with
no picture behind it cannot be checked by anybody who was not standing there.

**`origin` is what lets the server be strict about one and not the other.** A
`day_log` leg is typed from memory once the journey is over: the photograph is
optional and always will be, because refusing it for want of a picture nobody
can now take would mean refusing to record a journey that happened. A `visit`
leg was opened as he set off and closed as he arrived, so the app was present
at both ends and CAN insist. Without the column the strictness would silently
have broken the screen that shipped first, which is the whole reason it is a
column rather than a guess from which fields happen to be filled in.

**It is our own camera, unlike every other rear-facing photograph.**
`selfie-camera.tsx` argues that only the selfie should be ours and every word of
that still holds — it just does not decide this one, because `OdometerCamera` is
not asking for a photograph. It is asking for a NUMBER with the photograph as
its proof, and the two have to be one act. Handed to the system camera they
become two: MBOS goes to the background where a battery manager reaps it, and
the digits get typed against an image nobody is looking at any more. The only
ways out are both together, or abandoning the journey.

**The reading is refused while he is still at the meter, which is the only
moment it can be.** An arrival below the departure is a digit dropped from the
front, not a meter running backwards; a distance above
`mbos.travel.maxLegKilometres` is a typo, not a long day. Checked in
`lib/travel-leg.ts` on the handset and AGAIN in `handleTravelLeg`, because a
mileage claim is money and a check that lives only in an interface is not a
check.

**But the server's check UNPAYS a leg; it never refuses one.** A leg arriving
without its readings, or with an arrival below its departure, is accepted with
`claim_excluded` set and the reason written into `claim_excluded_reason`. It
used to be rejected, and a rejected leg blocks everything queued behind it on
the handset — so on 26 Sep 2026 salesmen on 1.9.0 and 1.10.0 checked in at
shops and could never check out, because the rule had moved twice in a
fortnight and an APK cannot be recalled to follow it. The money is protected
exactly as well by paying nothing on the leg; refusing it also threw away the
visit, which is work that happened. **Every build in the field is some version
behind, and the server must go on accepting what each of them sends.**

**And a stored rejection is judged again, not replayed.** `ingestSyncBatch`
replays an accepted receipt verbatim — that is what makes a retry safe — but a
receipt that says `rejected` is re-run against today's rules and overwritten
if the answer changed. Replayed, a refusal was permanent under whatever rule
stood the day it was given, and the handset's own Retry button, which resends
the identical payload, could never succeed.

A journey called off is CLOSED AT ITS OWN READING so it measures nothing
and carries the reason — deleting it would leave the next departure following on
from a gap, which is the pattern an audit stops at.

**A bus or train ticket is offered on the way out and never demanded.** It is a
scrap of paper that gets lost between the seat and the shop door, and refusing
the visit over one would mean refusing to record a visit that happened. Skipping
says in words that the fare can still be added on `/travel`, so nobody skips it
believing the money is gone; the PNR is optional beside it, because a local bus
ticket has no number and that is what a duplicate would be caught on.

**EVERY ODOMETER PHOTOGRAPH WAS BEING DELETED NIGHTLY, and none of them could be
opened.** Both halves of the bug AGENTS.md already records for the whole MBOS
media subsystem, arriving again with the module written after the fix.
`MBOS_PARENTS` did not name `travel_leg`, so `storeMbosMedia` resolved no parent
and every file landed with `parent_id` null — which is exactly what
`sweepOrphans` removes past `attachments.orphanCleanupHours`. A meter
photographed on Monday was gone on Tuesday, and until then only its uploader
could open it, because `canRead` named no rule for `mbos_travel_leg` either and
`customerBehind` fell through to `calls`. Who may open one is
`canReadTravelLegPhoto`: the man who took it, and whoever holds the `sales`
grant with him inside `managerScope`. The grant is asked FIRST and is not
optional — `managerScope` answers "national, sees everybody" for anybody with no
row in `mbos_manager_territories`, which is every plain salesman, so falling
straight through would let one salesman open another's mileage evidence by id.
It is not read through the customer's scope either, though a leg names a shop:
this is evidence about a person's expense claim, not about the customer.

**"Reset to shipped defaults" is the editor's, not a server action.** It fills
the standard policy's editor with `STANDARD_POLICY`'s rules and guidelines and
is saved through `savePolicySet` like any edit, with its note. The unused
`resetStandardToDefaults` action, which saved without showing anything first,
was removed (Nov 2026).
