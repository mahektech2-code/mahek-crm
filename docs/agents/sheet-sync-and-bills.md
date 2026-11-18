# Sheet sync, schedules, bill projection, money rules

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**The sheet wins every column except a decision somebody made.** The team
works in the spreadsheet and the CRM projects what they type, so for almost
everything the sheet is simply right and should overwrite. `orders.status` is
the exception: accounts approve and decline in the app, and the projection
used to reset that to `dispatched` on every pass. The approval columns are not
part of that overwrite, so the row was left reading "declined by Deepa, over
credit limit" beside a status of `dispatched` — and approved status drives EOD
value, targets, the buying cycle, the product history and outstanding, so the
reset moved figures on five screens with nobody's name against it. `approvedAt`
is the mark of a decision, written by decline as well as approve and never by
the projection, so the upsert keeps the app's status wherever it is set.

**A kept decision is written down, not just kept.** Silence would trade one
invisible loss for another: the sheet still says something different and
somebody has to reconcile the two. `sync_conflicts` records what the sheet
wanted, what the app holds and who decided, with a partial unique index on the
unresolved ones — an uncorrected sheet is re-read every thirty minutes, and a
list that grows by forty-eight rows a day is one nobody reads.

**One sync per source at a time.** Nothing checked this, which was fine on a
laptop and is not on a schedule: a run that hangs on a slow Google response is
still `running` when the next fires, and two passes race through the same
upserts. A `running` row older than ten minutes is treated as dead rather than
blocking forever, because the route is capped at five — waiting on a killed
process would let one timeout stop every future sync. Refusing returns **409
and not 500**: two overlapping calls are the ordinary result of a slow run and
a fixed interval, and a scheduler must not page somebody about a sync that was
working perfectly.

**The schedule lives outside the deployment, because Vercel Cron is paid.**
Two cycles: every thirty minutes for the read modes and the projection, and
one a day for `reconcile` — the only pass that sees an edit to an old row or a
deletion — followed by `nightly`, which is the only thing that rebuilds the
derived caches. Steps run in sequence on purpose: no single call may exceed
the route's five-minute ceiling, but a caller may take twenty minutes, so the
cycle is chunked into calls rather than made into one long one, and the order
matters — the read modes land rows in the staging tables and `project`
publishes what has landed, so projecting first ships the previous cycle's data
as though it were fresh. Reading is cheap when nothing changed, since every
row carries a content hash — an untouched tab costs a read and no writes,
which is what makes the cadence affordable.

**THERE IS A THIRD CYCLE, AND FOR A LONG TIME NOTHING CALLED IT.** `runHourly`
shipped with the MBOS module and no caller was ever written: `sheet-sync.sh`
knew `cycle` and `nightly`, the crontab knew the same two, and `?mode=hourly`
was not in the route's own map of modes. So everything this file describes as
hourly ran nightly at best — the attendance selfie sweep that makes
`mbos.attendance.selfieRetentionHours` mean 72 rather than "up to a day and a
half more", the MBOS escalations, the unconfirmed-WhatsApp sweep, the complaint
SLA, and the salesman score. NOTHING LOOKED BROKEN, which is why it lasted:
each of those either has a nightly path or fails by simply being late, and a
late figure is indistinguishable from a correct one unless you know what it
should say. The handset was where it showed, because that screen reads the
cache rather than deriving anything — a target published at ten in the morning
reached the salesman the following day.

**A cache a phone reads is a cache with a deadline.** The score was the half
missing from `runHourly` itself: the nightly rebuilt both this month and the
last, and nothing rebuilt anything in between. It is this month ONLY on the
hour — the previous month's correction can wait for the nightly, and doing it
twenty-four times over is a pass of the whole order book to move a figure
nobody is being judged on any more. It needs nothing recomputed before it,
unlike in the nightly, because every figure it reads comes off the ledger
rather than off a derived cache.

**A `schedule:` in GitHub Actions is a hope, not a cadence.** It is
best-effort, and on a private repo belonging to a free account it is the
lowest priority tier there is: a tick that cannot be served is DROPPED, never
queued, so the interval you wrote is an upper bound on frequency and nothing
more. `*/30` delivered three runs in eleven hours here — gaps of 2h01, 4h48
and 4h07, about one tick in ten — with every run green and finishing in two
minutes, which is what makes it so hard to notice: nothing fails, the log
looks healthy, and the CRM is just quietly hours stale. The half-hourly cycle
is an Apps Script time-driven trigger on the workbook instead
(`scripts/sheet-sync-trigger.gs`), which is not best-effort and lives beside
the sheet it reads. Cron minutes are `:07`/`:37` and `:13` rather than `:00`,
because the top of the hour is exactly when ticks get dropped.

**The nightly stayed in Actions, because `curl` waits and `UrlFetchApp` does
not** — until both cycles moved to the droplet's crontab (`deploy/sheet-sync.sh`,
which keeps the `curl` reasoning below); the two manual sheet-sync workflows
were deleted when the ERP took the orders. The daily pass is the one place ORDER is load-bearing across a
five-minute boundary — `nightly` rebuilds the caches from what `reconcile`
landed, so starting it early rebuilds them from half a compare.
`--max-time 310` blocks until the server answers; Apps Script gives up at
about sixty seconds with no way to raise it, and a full compare takes longer
than that, so the script would start the second step over an unfinished first
and have no way to know it had. One tick a day also has far better odds of
being delivered than forty-eight. Where a fetch DOES time out in the
half-hourly script it is logged and the cycle carries on: the request reached
the deployment and the job runs to completion server-side, so only the answer
is lost, and the next tick's 409 guard stops a second pass climbing on top.

**A backfill becomes a cadence the day the source stops being defunct.** The
field salesman activity history — the Activity tab of "Mahek EMP 2.0", a
prior system — shipped as a one-time CSV import because the live sheet was
not reachable from the app's service account at the time. Once
`mahekone@mahekone.iam.gserviceaccount.com` was confirmed to hold Viewer on
it, the same staging/hash/reconcile code the CSV backfill used became a live
sync, on the order sheet's OWN append/reconcile split rather than one full
compare per tick — the tab is tens of thousands of rows, so `?mode=
field-activity` (watermark-only) runs every few minutes and `?mode=
field-activity-reconcile` (full hash-compare, catches an edited or withdrawn
row) runs once a day. It is a SEPARATE spreadsheet from the order workbook,
so it cannot share `sheet-sync-trigger.gs` — an Apps Script trigger belongs
to the document it is bound to — and has its own,
`scripts/field-activity-sync-trigger.gs`, installed the same way in that
workbook. `?mode=field-activity-project` writes matched rows onto
`timeline_events`, which is how this reaches a customer's shared history and
a salesman's phone.

**AND MBOS IS NOW THE RECORD; THE SHEET IS ITS PAST.** `fieldActivity.cutoverDate`
(10 Oct 2026) is the first day only MBOS counts. The sync still runs, so an
edit to an old row lands, but a row dated on or after the cutover is read,
counted in the run's detail and NOT stored (it is still marked seen, so a
reconcile never takes "not stored" for "gone"), and the timeline projection
never projects one already stored. Activity history (`activityHistory` in
`sales-service.ts`) is one list of every MBOS visit plus the sheet's rows
before the cutover, each marked MBOS or Old app; a past day can carry both
because some men typed a visit into each app, and nothing merges them. Its
salesman filter is `u:<user id>` (his MBOS visits and the sheet rows matched
to him) or `n:<name>` (a name only the sheet carries). `visitSelect()` is the
one select of a `VisitRow`, shared with the Visit log.

**AN OLD-APP SHOP NAME IS LINKED ONLY WHERE NOTHING COULD BE WRONG.** The
importer used to auto-link any name scoring 0.6 trigram similarity, which put
"Shree Ganesh Paints" visits on "Shree Ganesh Paint House" and an Ajmer shop's
on its Mumbai namesake — read on those timelines as fact. `decideCustomerMatch`
now links a name only when exactly ONE account carries it once folded
(`foldShopName`: case, spacing and punctuation only), or when a person decided
it; several exact namesakes and every close name are "Needs review" with the
shortlist. A person decides once per NAME on the row's detail
(`lib/actions/field-activity.ts`, a Sales manager holding Activity history),
stored in `field_activity_customer_decisions`, and every row typed under that
name moves with it; "not on MahekOne" is an answer too. The nightly
`field-activity-shops` pass (and `npm run jobs -- field-activity-rematch`)
re-judges every stored row and takes back the timeline entries wrong links
wrote. The pin import (`customer-location-import-service.ts`) uses the same
matcher, `shop-name-match-service.ts`.

**A flag that is silently discarded is worse than one that is rejected.**
`npm run jobs -- project-sheet --bills` used to run the projection with no
options whatsoever: the argument was read into argv, dropped before `runJob`,
and the run then reported "bills skipped" — which reads as a fact about the
data rather than an option that never arrived. Sales Bills was empty and the
command said so in words that sounded like an explanation. Parsing lives in
`lib/job-args.ts` so it has tests; an unknown option, a `--owner` with nothing
after it, and a switch given a value are all refused rather than guessed at.

**The import has to be runnable from the screen.** On a deploy nobody has
shell access to, a terminal is not a fallback — it is the only door and it is
locked. The sheet jobs were reachable from a CLI and from a cron endpoint
guarded by a secret, which on this deployment meant neither, so the import ran
on somebody's laptop against the production database or it did not run at all,
and Sales Bills stayed empty through three releases that each claimed to fix
it. Admin Console → Sheets → Sync runs both steps, and `triggerJob` takes
the owner because the sheet cannot supply one. A merge has to be enough.

**A bill number is unique across the TABLE, so uniqueness cannot be worked
out from one run.** `bills_no_key` is a unique index over every row, and the
import used to decide numbering by counting Tally numbers within its own batch
— blind to a bill somebody typed in, one the Payment Status path wrote, or one
a half-finished run left behind. The insert threw, and it threw after thousands
of rows had already landed. Existing numbers are read first and a contested one
falls back to `<tally>/<order number>`, then `ORD-<order number>`; an order
that still cannot get a unique number is counted and skipped, never renamed
into something nobody can reconcile and never thrown, because one unusable
number must not cost the other ten thousand rows.

**A sales bill IS the order.** Bills are projected from the Order Details tab,
one per order, valued as the SUM of its lines — Final Amount is line-level and
half these orders are multi-line. The number is the Tally number, gaining the
order number where that repeats. `--bills` swaps the source to the Payment
Status tab — never both, since they key on the same `SHEETPAY-<order number>`
and would give one bill two authors.

**The sheet never writes money. Not in any column, not by any path.** No
receipt, no `paid_amount`, no `status`, no `outstanding`. Whether money arrived
is the app's to record and nobody else's, and a sync that touches a payment
figure is a bug however reasonable its reading of the tab was.

It was not always so, and the reasoning that got it wrong was good. The Order
Details tab records what was billed and never what was received, so the only
two readings were assume-everything-owed — which invents the whole order book,
nine crore of it, as debt and puts every customer on the collections list — or
assume-everything-settled, which understates rather than fabricates and was
called the safer of two lies. It was still a lie, and it was the one that hides
money: every customer's every bill read as paid on a spreadsheet's authority
with no person behind any of it.

**So there is a third position, and it is stated rather than guessed.**
`bills.paymentPosition` is `stated` or `unstated`, and `unstated` counts as
NEITHER paid nor owed. The bill exists and shows on the customer record; it is
held out of outstanding, the aging strip, the collections worklist, the
slow-payer flag and the WhatsApp reminders until somebody speaks. Nothing
chases a debt nobody has vouched for, and nothing is written off either. The
column defaults to `stated`, deliberately: every row that existed when it
arrived kept exactly the behaviour it had, so adding it moved no figure on any
screen. Only the projection writes `unstated`, and only on INSERT — a bill
somebody has since spoken for must not be returned to silence because a
scheduled pass re-read the row it came from.

**AND MAHEK OVERRULED IT: a bill nobody has spoken for is OWED.** October
2026, and a reversal of the paragraph above. Holding unsaid bills out of
outstanding kept a month of real credit sales — every bill since the last
receivables report — off Outstanding, aging and the collections list, so a
customer weeks past a credit-term due date read as owing nothing. The
projection and the CSV import now insert `stated`, and `0205` flipped every
`unstated` bill already in the book. The sheet STILL writes no money: the bill
is open in full because nothing has been recorded against it, which is what
open means. The one bill still written `unstated` is one the Payment Status tab
says was Received — `positionFor` in `sheet-projection-service.ts` — because
that is a record of the money arriving rather than silence, and chasing it
would be chasing money the office has written down as paid. Everything below
about `unstated` still holds for those bills; there are simply far fewer of
them. The consequence to know about: the founder's automated WhatsApp rules
read stated overdue money, so this widened who they can reach.

**What states a bill is a person.** Recording or confirming a receipt against
it — every route to confirmed money passes through `applyToLedger`, which is
where the mark is set, because a decision recorded in three places is a
decision missed in one — or Tally's receivables report naming it through
`leaveOwing`. `payment_decided_at` says WHEN and is set once; `paymentPosition`
says THAT, and is set unconditionally, because a bill can carry a decided
timestamp from before the column existed while still reading `unstated`.
`source <> 'sheet_import'` is what keeps the two apart: a receipt the
spreadsheet wrote is not somebody deciding.

**A screen showing a balance has to say which kind of number it is.** On an
`unstated` bill the balance is the full amount purely because nothing has been
recorded against it, so the bill screen says "no payment recorded either way"
rather than "₹0 received" and explains why. Rendering it beside real balances
presents an unknown as a debt, which is the original mistake wearing different
clothes.

**The Payment Status tab is evidence, not an author.** It has the best claim of
anything in the workbook — real received/not-received on 8,277 rows — and it
still does not write money. A receipt is the assertion that funds reached the
bank; a spreadsheet cell cannot make that assertion, because no person is
behind it and there is nobody to ask when it turns out to be wrong. What it
says is COUNTED and reported — `paidWithoutDate`, `blankStatus` — so accounts
can go and confirm it. A BLANK status is no longer read as settled, nor as
unpaid as it was before that; it is read as silence — which since October 2026
means owed from the due date, like every row the tab does not mark Received.

**What the old assumption did is still in the database, and the revert is kept
for it.** Production carries thousands of `source = 'sheet_import'` receipts
and they are why the book reads as paid; they were deliberately left in place
when the writing stopped, so that no figure moved on the day of the change.
`revertSheetSettledBills` deletes only those whose order the Payment Status tab
affirmatively calls unpaid — silence is not evidence in either direction — and
`unpaidPerPaymentTab()` is the single definition both it and the old importer
shared, because two copies of that rule would clean up a different set to the
one the importer stopped writing, and the difference is money. The projection
can no longer produce that damage, so the tests build it by hand.

**The projection no longer rebuilds paid amounts.** `recomputeAllBillPaid` and
`recomputeBillStatuses` derive from confirmed receipts, and the sheet writes
none, so there is nothing new for them to read and running them would make a
pass that touches no money look like one that rewrites the ledger every thirty
minutes. Outstanding IS still rebuilt, because a corrected bill AMOUNT changes
what a stated bill is worth, and the follow-up stage and slow-payer flag follow
it in that order.

**The mark goes on before the receipt comes off.** `leaveOwing` writes
`paymentDecidedAt` first and unconditionally — including for a bill it finds no
assumed receipt to cut. The report naming a bill IS the decision, and a bill it
names must not be settled by assumption later just because there was nothing to
delete at the time. Marking it after the delete would leave a window, and the
window is exactly where the cron lives.

**A part payment is locked too.** Where some money did arrive `leaveOwing`
REDUCES the assumed receipt rather than deleting it, so the key stays taken and
the old bug could not bite — but the lock applies anyway, because "the customer
paid ₹1,000 of ₹2,360" is as much a decision as "they paid nothing", and a
later pass must not decide the remainder arrived too. There is a test for each
of the three: fully owed, part owed, and five consecutive syncs.

**The fix went in the projection, not in the two callers that spell the URL
out.** Adding `bills=1` to the workflow and the Apps Script would have worked
until the third caller, and a rule about money that lives in a query string is
one deployment away from being forgotten. The staging tables are what make the
damage reversible at all: `sheet_payment_rows` holds the tab's own verdict,
the projection reads it and never writes to it, so the receipts that SHOULD
exist stay derivable however badly the published side is mangled. `npm run
jobs -- revert-sheet-paid --dry-run` reports the count, the money and the
customers affected; without the flag it deletes and rebuilds the caches. It
touches `source = 'sheet_import'` receipts only — a telecaller's reported
payment and an accounts confirmation are somebody's word, and no cleanup of an
import's mistake may reach them.

**A recompute that filters is a recompute that freezes.**
`recomputeAllFollowUpStates` is the only thing that REMOVES a follow-up row
when the debt behind it goes, so restricting it to active customers did not
skip work — it stranded eight customers at stage 3 claiming crores overdue
while owing nothing, beyond the reach of any later run. It visits every
customer; nothing is created for one who owes nothing.
