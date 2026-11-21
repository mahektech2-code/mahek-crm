# Owner KPIs, customer health, reports, margins

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**THE OWNER IS ASKING FIVE QUESTIONS, and they are one funnel rather than five
reports.** New leads, what became of them, what an order is worth, how often
one comes, and whether the customers it produced are still buying. That is why
they live in one engine, share one definition of a period, and each opens the
thing behind it — a headline figure nobody can get behind is a number they have
to take on trust. Margin is absent on two counts: the brief excludes it, and
`products.priceSource` is still `unset`, so a cost here would be an invention on
the one screen where a wrong number does the most damage.

**A LEAD LIVES IN TWO TABLES and both count.** `customers.kind = 'lead'` is a
party the book knows has never ordered — an owner, a source, a created date,
and no ladder at all. `mbos_leads` is somebody a salesman actually met, with the
full rung list: new → contacted → qualified → negotiation → won/lost. The
owner's question is whether the company is generating opportunities, not which
table one landed in, so `leadsCreatedIn` reads both. They are DEDUPLICATED
across the join: a converted field lead writes a customer row, and counting that
row as well would inflate the very KPI that measures lead generation.

**Conversion is measured by COHORT, never by dividing this month by this
month.** Orders this month over leads this month asks a lead created on the 29th
to have ordered by the 31st, and mixes orders from leads generated in March into
a rate labelled with August's lead count. A cohort follows one window's leads
forward for `owner.conversionWindowDays` and reports what became of them.

**A cohort read before its window closes is UNFINISHED, not failing.** A lead
eleven days old with a ninety-day window has not failed to convert. `stillOpen`
carries how many are still inside it and every screen says so in words — the
difference between a low rate and an incomplete one is the single most misread
figure in the module.

**The denominator is EVERY lead in the cohort, and the qualified rate sits
beside it.** Only a field lead can be `qualified`, because only a field lead has
a ladder. A denominator restricted to qualified leads would silently drop every
CRM lead — most of this book — and report a flattering number with nothing on
the screen saying why. Both are shown; the headline is the one somebody can
verify by counting.

**A rate moves in POINTS and a count moves in percent.** 12.5% to 14.8% is up
2.3 percentage points, not up 18.4%, and printing the second is the commonest
way a dashboard flatters itself. `changeInCount` and `changeInRate` are separate
functions returning a `kind`, and the pill prints "pp" so the reader can see
which they are looking at. Growth from nothing is `null` rather than a
percentage: one lead last month and forty this month is not up 3,900%.

**A month is compared CALENDAR-ALIGNED and equal-length at once.**
`comparableRange` is not `previousRange` and must not be confused with it: the
latter gives the equal span immediately before, which is right for a calling day
and wrong for a month — twenty-two days of August against 10–31 July is an equal
window nobody recognises. Aligned so the comparison is the one somebody meant,
equal-length so a month-to-date is never held against a whole month. The 31st
shifted into a thirty-day month lands on the 30th rather than rolling forward,
which a naive `setMonth` gets wrong by a whole month.

**Average bill size is net of credit notes, and the COUNT is untouched.** A
credit note is not a sale that un-happened, it is money given back on one that
did — removing the transaction would raise the average every time somebody
allowed a claim. It is datable at all only because `issueCreditNote` writes a
confirmed receipt keyed `creditnote:<complaint>`; there is no issue date column.
That same key is why a credit note no longer counts towards a salesman's
COLLECTION figure, which it did until this landed: AGENTS.md already said
`Adjustment` is not money arriving, and the collection component was counting it
as though it were.

**Frequency divides by customers who ORDERED, not by the book.** Dividing by
every customer would make the figure fall every time somebody added a prospect.
"A thousand transactions" says nothing without the number of customers behind
it — a thousand from 250 is a different business to a thousand from 900.

**THE BAND OWNS THE PHRASE "AT RISK", AND THE SCORE MAY NOT BORROW IT.**
There are two health models and both are worth having — the BAND asks whether
somebody has stopped buying, from one fact, their own cycles elapsed; the SCORE
asks how the relationship is doing, from five. They were being rendered in five
places with four different sets of thresholds, and two of those five used the
same two words for different questions: `/sales/leads` called a customer "At
risk" below a SCORE of 40, and the owner's report called one "At risk" at 1.25
CYCLES overdue. A manager and an owner could read that phrase about one shop on
one afternoon and mean different things, which is what B3-16 was raised about.
The handset's `customerStage` was the worst of the five — `< 40 ? 'Overdue' :
< 60 ? 'At risk'`, a third pair of thresholds, neither of them configuration,
and an unscored customer falling through to "Active", which is a verdict about
somebody nothing had measured.

**AND THE FIX LEFT ITS OWN WRECKAGE, which took a year to notice.** The
replacement kept a branch reading `status === 'Overdue' || 'At risk' ||
'Active'`, while `customer_status` is an enum of exactly `active`, `inactive`
and `deactivated` — lower case, and two of those three literals name nothing
that exists anywhere in MahekOne. So the branch could never once fire, every
account fell through to the band, and a shop somebody had deliberately
DEACTIVATED read as whatever its buying cycle happened to say. `deactivated` is
the one that has to win, because `recomputeInactivity` derives every other value
and pointedly never writes that one. `inactive` gets no word of its own: it is
the same fact the `dormant` band states, from the same threshold.

**A null verdict now draws NO DOT, which is the half that was on the screen.**
The function has always answered null for an account nothing has been measured
on, and its contract says the caller invents nothing — but the card drew the dot
unconditionally and made only the WORD conditional. So a shop nobody has ever
sold to got a bare GREEN dot with nothing beside it: the most reassuring mark on
the card, on the row that has earned it least. On a fresh book that is most of
the screen.

`lib/customer-health.ts` is the one place either becomes words, pure and
client-safe like `account-types` and `seat-labels` beside it. The band gets the
retention word; a low score says `watch` and NAMES the components dragging it,
because "paying late, two complaints open" is both truer than "at risk" and
tells somebody what to do. There is a test asserting a score can never produce
the phrase.

**And its two thresholds are configuration now.** They were a literal 70 and 50
inside the handset's health pill — two business numbers invisible to the one
screen a manager would change them on. `mbos.health.strongAtOrAbove` joins
`mbos.health.atRiskBelow`, and `checkConsistency` refuses a strong threshold at
or below the watch one, because a score between them would be both at once.
The old key keeps its name so no stored setting has to be migrated; what
changed is its label, which is what a manager actually reads.

**The band reaches the handset on the wire, computed once.** Like the score
beside it: a phone deriving its own would derive it from a book hours old, and
two salesmen standing in one shop would read different words about it. It is
filled in JS by `bandFor` — never as a CASE in the query — because a second
copy of that rule drifts the day somebody changes a multiplier.

**CUSTOMER HEALTH IS FOUR BANDS OF ONE EXISTING RULE, not a second one.** Active,
at risk, dormant and lost, measured in multiples of the customer's OWN buying
cycle — a fortnightly buyer and a twice-a-year buyer are both a quarter late at
1.25 of their own rhythm, and a flat 30/60/90 would call the first lost and the
second fine. `dormant` is deliberately NOT its own setting: it IS
`inactive.cycleMultiplier`, the threshold the source document states precisely
and the point at which `customers.status` becomes `inactive`. One number, so the
Call Log cannot chase somebody the owner's screen has written off. The bands
live in `engines/inactivity.ts` and `evaluateInactivity` reads them, so nothing
moved on the day they shipped — there is a test asserting the flag still fires
exactly where it did.

**A customer who never ordered is in NO band, and a lead is not in the book at
all.** They have not stopped buying, they have not started; folding them into
Active is how a retention figure flatters itself and calling them Lost is worse.
A DEACTIVATED account is out entirely — somebody closed it deliberately, and
counting a business decision as a retention failure is a different lie. Both are
counted and printed rather than hidden.

**Movement is the figure the counts cannot give you.** 145 at risk in both
months looks stable and may be 145 different customers, half recovered and half
newly slipping. `customer_health_snapshots` holds where each customer stood at
the end of a month and is the only place that survives — a band is a statement
about a day, unrecoverable once the customer has ordered. It is a SNAPSHOT, not
a cache: nothing rewrites a past month and nothing may learn to, because a
rebuild would destroy the thing it exists for. The nightly pass writes over the
CURRENT month's row, which is what makes a closed month correct for free — it
stops being overwritten on the last night of the month, so no job has to fire on
exactly the right day. **It cannot be backfilled**, and the screen says "we
cannot say yet" rather than drawing a movement of zero.

**The Reports app is RETIRED, and its engine and service are not.** It was
the owner's five on screens of their own, and the HQ (the command centre) now
reads the same `owner-dashboard-service` functions — so the screens went and
the numbers stayed. `reports` stays an `APP_IDS` value with `retiredInto:
"founder"`, the same treatment `people` got: a grant made before the
retirement still resolves, nothing draws it, and `/reports` redirects to the
launcher rather than to `/hq`, which is granted separately. The nightly
health snapshot still runs, because the founder's retention movement reads it.

**THE FOUNDER'S MARGINS ARE ONE DESK, AND EVERY FIGURE IS THE ERP'S OWN.**
`/hq/margins` (module `founder.margins`, section key `margins`, one
sidebar entry under Sell) reads the ERP's billed, dispatch-verified lines for
the period and the equal span before it through `detailRows` — the same
reading the Order details register's Margin column makes — in
`services/margin-service.ts`. Margin = amount − discount − lot cost (with the
line's extra expenses, split back out for display) − credit notes, before GST,
and margin % is over sales after discount. `lib/engines/margins.ts` is pure
and only adds lines up: totals, bands, roll-ups, the why-it-moved bridge (its
Mix is the remainder by construction, so the steps always add up) and the
alerts, which are read off the lines and stored nowhere. **A line with no lot
cost has no margin** — it counts in sales and litres, is held out of margin and
margin %, and is counted on its own; never 0% or 100%. The bands, floor,
target and alert thresholds are `margins.*` settings (Reports → Margins). The
desk is six sub-tabs, each with a View switch where one subject is read several
ways, so it stays one entry in the Command Centre's sidebar; filters narrow the
LINES before anything is added up. Columns, saved views, the focus list and the
Overview panels are remembered per browser and move no figure. A period of more
than `MARGIN_LINE_CAP` lines is refused in words.

**An HQ note is an audit row, so editing or deleting one APPENDS.** "Add a note"
writes `founder.note` into `audit_log`, and the log is append-only. The author —
and only the author — may correct a note (`founder.note_edit`, naming it by
`noteId`) or delete it (`founder.note_delete`); `notesFor` folds them, showing
the newest text with "edited" and dropping deleted ones, while the original row
and every change stay in the log. `lib/command-centre/notes.ts` holds the guard
(own note, and `requireNoteIn` for where it sits); the record drawer offers Edit
and Delete only on notes `notesFor` marks `mine`. `auditFor` leaves all three
codes out of "Who changed what" — notes are the timeline, not the history.
