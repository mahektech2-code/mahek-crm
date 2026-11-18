# Salesman performance and targets

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**A SALESMAN IS NOT MEASURED IN RUPEES ALONE, and the reason is arithmetic
rather than philosophy.** A price revision moves every rupee figure in the
business without one extra can leaving the godown, so a book measured on
revenue alone reports the month prices went up 30% as the month everybody
improved 30% — and the salesman who actually sold less outranks the one who
sold more. `sales_targets` therefore asks for five figures and a mix, and
`lib/engines/performance.ts` scores six components out of a hundred: revenue
35, volume 20, product mix 20, new customers 10, collection 10, activity 5.
Every weight is configuration and `checkConsistency` refuses a set that does
not total 100 — a score presented out of 100 computed out of 95 is a different
number wearing the same label, and nothing on any screen would say so.

**Volume is the half a price list cannot move, so the divergence between the
two is the alert.** Revenue at or above target with volume more than
`performance.volumeDivergencePoints` below it means the money came from the
price list, and it is exactly the month somebody would otherwise be
congratulated for. It is drawn on the team dashboard, on the person's own
screen and on the handset, because the person being congratulated is the one
who most needs to know.

**A TARGET IS SET NET OF GST, SO REVENUE IS SCORED NET OF GST — and those are
two columns rather than one corrected one.** The order sheet states the same
sale twice: `Final Amount = Amount × (1 − discount) × (1 + GST)`. Mahek writes a
revenue target on the second figure and `orders.total_amount` is the first, so
the score read ₹29.5 cr against targets written for ₹25.1 cr — everybody about
ten points ahead of where they were, on the screen an appraisal is read off.
Neither number was wrong; they were never the same question.

`total_amount` stays what the customer owes, because the credit-limit check,
the approvals queue, the bill it becomes and the sentence on the timeline are
all that figure and all right. `orders.net_amount_paise` is the sale under it,
and `netOfTaxPaise` in `lib/sheet-parse.ts` is the one definition of it —
shared with the arithmetic check that already computed the same expression, so
the two cannot drift.

**It is Amount AFTER the discount, and that is not a detail.** 5,577 of 24,560
lines carry one, worth ₹33 lakh: scoring on the list figure marks a salesman
down for every discount he was authorised to give. It is not `Final Amount ÷
1.18` either — 820 lines carry no GST at all, and a flat divisor leaves every
one of them 18% short with nothing on any screen able to say which.

**NULL MEANS NOBODY STATED ONE, and every reader coalesces back.** Only the
sheet projection fills it, because only the sheet carries a rate and a discount
per line; a CRM order is one total somebody typed with no tax stated near it,
and deriving a net from it would be guessing at the convention they used. So
`performance-service` and `baselineFor` both read `coalesce(net_amount_paise,
total_amount)` — a typed order counts at its own value rather than falling out
of somebody's month. The mix does the same one level down, on
`OrderLine.netAmount`: a share is a division of revenue, so a numerator in one
unit over a denominator in another is a share of nothing.

**And the screens say which unit they are in.** What let this survive is that
two numbers in different units were drawn identically, so "excl. GST" is on the
target field, on both target tables and on every screen that scores the figure.

**AND A CUSTOMER'S MONTHLY TARGET IS THE SAME QUESTION AT A DIFFERENT GRAIN,
asked in five places that had each answered it slightly differently.** The
Targets tab, its totals row, the paged list, the shortfall report, the Call
Log's `targetGap`, the customer record's own month figure and the trailing
average behind the DEFAULT target are all "what has this shop bought this
month". Every one of them was written out by hand, and each carried the same
three faults:

- it read `total_amount`, GST in, against a target typed without it;
- it spelled out three of `PURCHASE_STATUSES`' five, so **an order stopped
  counting the moment somebody recorded that it was in transit or delivered** —
  achievement going DOWN as an order progressed, and a gap reopening on a shop
  that had already bought;
- it asked `extract(month from o.ordered_at)`, which reads the session's zone.

`orderValueSql` joins `orderCountsSql` in `lib/order-status.ts`, because "did we
sell anything" and "what was it worth" are asked together every single time, and
`monthWindowSql` in `lib/business-date.ts` is the month as a half-open range of
instants in `APP_TIMEZONE`. Every call site reads all three now.

**THE MONTH SPELLING IS THE FOURTH FORM OF THE ZONE RULE, and the three grep
guards could not see it.** They watch for `::date`; `extract` is the same
mistake in different syntax. A fourth guard in §11 watches for it, naming the
timestamp columns rather than matching `extract` outright — `extract(year from
h.on_date)` is a DATE and has no instant to lose. The half-open range is also
the faster answer: a comparison on the column can use its index, which two
`extract`s per row never could.

**TWO OF THE SIX COMPONENTS ARE A SHARE, AND EVERY SCREEN DREW THE NUMERATOR
ALONE.** Revenue, volume and new customers are absolute, and the mix is already
a percentage of itself. Collection is a share of WHAT WAS ALREADY OVERDUE when
the month opened, and activity is a share of THE TASKS THAT FELL DUE in it —
and seven surfaces printed "₹2.4L · 73%" and "18 · 45%", which tell a manager
nothing: 73% of what, and eighteen out of how many. `PersonActuals` had both
bases all along and said so in its own comment — "the count of completed tasks
says nothing on its own: twelve tasks and a hundred tasks were both held to
'ten done'" — which is exactly what the cell printed.

`lib/performance-labels.ts` is the one vocabulary, and it **imports nothing at
all**: money is rendered by a function the caller passes in. That is what lets
it be MIRRORED to `mbos-app/src/engines/performance-labels.ts` byte for byte,
compared as text by `mbos-wire.test.ts` like the three funnel engines beside it
— the office passes `money`, the phone passes `inrFromPaise`, and a manager and
the salesman he manages cannot read two different sentences about one month.

**A ZERO BASE AND A NULL BASE ARE DIFFERENT ANSWERS.** Zero is "nothing was
overdue" — a statement about the month, which the scoring already treats as
"not asked" and drops rather than failing. Null is "nobody recorded one", which
is every cached row written before the columns existed. Printing 0% for either
invents a failure nobody recorded, against the person least able to argue with
it, so all three cases are words rather than a figure.

**The handset needed the base on the WIRE, because it reads the cache and
nothing else.** `sales_performance` stored the implied rupee target and the
numerator; `collection_base_paise` and `activity_assigned` are the missing
denominators, filled by the recompute and nullable for the rows that predate
them. The web needed no such thing — it reads live actuals — which is why this
landed as one PR for six screens and two columns for the seventh.

**Litres are derived from the SKU's packing, and revenue is not derived from
anything.** Quantity is cans, `products.millilitres_per_can` turns it into
millilitres, and the value of a line is what was actually billed — the product
master still holds no prices and `canValueOrders()` still answers no. Nothing
here reaches for a packing cost to make a total look complete.

**Whose number it is falls through, and it is ONE person.**
`lib/sales-attribution.ts` is the only place that rule is written: the
salesperson on the account, and where there is none, the back office person who
works it. Not both — `scopedToUsers` deliberately answers with both seats,
because two people may need to SEE an account, and exactly one may be CREDITED
with it or the team's revenue adds up to more than the company's and every
comparison between two salesmen is drawn from a total that does not exist.
`owner_id` is deliberately absent from the chain although `ASSIGNED_TO_SQL`
ends with it: on an imported book it is whoever ran the import, one person on
more than a thousand rows, and ending there would hand them the revenue of the
whole company on the day somebody set them a target. A customer with neither
seat is UNATTRIBUTED, counted, and printed on the dashboard — a figure nobody
can account for is worse than one that says why it is there.

**Which is why a telecaller has a performance screen.** Back office people
carry a large part of this book under that fall-through, and they are
redirected out of `/sales` by its own layout — so `crm.performance` exists, it
shows one person and only ever the signed-in one, and it takes no id. A manager
comparing people has the Sales Dashboard; an id on this route would make it a
way for anybody to read anybody's appraisal.

**A mix category is a row, not four strings in a screen.** The brief names
Universal, PU and Nano and the catalogue carries nineteen formulations, so the
classification hangs on `product_formulations.category_id` — the level at which
it is actually true, since one liquid sells as Nano, Astar Nano and M5x4
Thinner and all three are the same strategic product. Exactly one category is
the RESIDUAL, enforced by a partial unique index, and it catches both the
formulations nobody has classified and every order line whose product name
matched nothing. Without a residual the shares would not total 100% and every
percentage on every screen would be wrong by an amount nothing named.

**AND A MIX IS NOW SET ON THE FORMULATION, NOT ON THE CATEGORY ABOVE IT.**
Universal / PU / Nano is three rows, which is too broad to aim a salesman at —
the liquid is the thing he actually sells, and nineteen is a list somebody can
pick three from. So `mixCategories` offers formulations, the picker adds and
removes them one at a time, and a target carries as many or as few as that
person's book warrants. `product_formulations.is_residual` is "Other", the same
partial unique index one level down, because value whose product names no
formulation still has to be in the denominator. ACTIVE ones only: a formulation
somebody retired is one nobody should be aimed at next month, while a band
already set on one goes on scoring, because a target somebody typed is a
decision and deactivating a liquid mid-month must not silently drop a share out
of their score.

**NOTHING ALREADY SET IS REINTERPRETED.** `sales_target_categories` and
`sales_performance_categories` each carry BOTH keys with a check constraint
demanding exactly one, and a band typed against a category goes on scoring as a
category — reading "Universal 40%" as a formulation would be inventing which of
the six liquids under it somebody meant. That is the treatment `activity_target`
and `collection_target_paise` already get: retired in place, never reread.
`isFormulation` is taken off the target's own bands and decides which BUCKET of
actuals is scored, because `scoreMix` totals whatever it is handed and one map
holding both would halve every share.

**Every reader of that pair has to read both, and the one that did not was the
WIRE.** The handset's mix rode on an inner join onto `product_categories`, so a
row keyed on a formulation matched nothing and the phone was sent an empty mix
for a target that plainly had one — which reads on the phone as nothing having
been asked of him, not as a payload with a hole in it. Nothing failed: the
query was valid, the JSON was well formed, and the office screen was right.
`performance.test.ts` sends a formulation target through `buildBootstrap` and
asserts the names come back, because a missing row in a correct payload is
invisible to every other kind of check.

**Unmatched money counts as revenue, contributes no litres, and is REPORTED.**
Order lines carry a product NAME and several of the sheet's names match
nothing. That money is real; what it cannot do is claim to be litres of a known
product. `sales_performance.unmatched_revenue_paise` carries the figure so a
screen can say the mix was computed over 94% of the value rather than present a
share that is quietly wrong.

**Each mix category is weighted by what was ASKED, never by what arrived.**
Weighting by the actual share would let somebody who sold nothing but the easy
line score a perfect mix — that category would be the only one with any weight
and it would be far above its target. Three numbers rather than one, because a
book selling into furniture and one selling into automotive cannot be held to
the same 30%, and a band that does not increase is refused by a check
constraint: it would score a larger share lower than a smaller one, invisible
until somebody is marked down for selling more of exactly what they were asked
to sell.

**A component nobody set a target for is DROPPED, and its weight is shared
out.** Null and zero are different answers here. Scoring an unset component 0%
marks somebody down for a question never put to them and scoring it 100% pays
them for it, so it leaves the score and the remaining weights are restated out
of a hundred — which keeps the sentence "this is out of 100, against what was
actually asked of you" true. The names of the dropped components are stored and
the screens print them.

**A target is DRAFT until it is published, and a published one changes only
with a reason.** A manager builds thirty of these in an afternoon and a
salesman watching his number change four times before lunch stops believing any
of them, so nothing reaches a handset until it is published.
`sales_target_revisions` is a table rather than a line in `audit_log` because
the question somebody asks in March is "which targets moved for the price
revision", and an audit log can only answer that by grep — the reason is a code
from `performance.revisionReasons` so it can be counted, one row per figure
that moved, and the person is notified. A draft is EDITED rather than revised:
nothing has been promised to anybody, and logging every keystroke of
target-setting buries the four changes that matter.

**A salesman cannot reach any of it.** `target.set` is checked in the action on
every path — a server action is a URL and a hidden button is not a permission.
It is deliberately not the same capability as `customer.reassign`, which moves
which accounts feed a target and stays accounts' and admin's, so no one person
both chooses the number and chooses the book that fills it.

**`target.set` is held by managers AND by accounts, and the second is where it
actually gets used.** The module shipped manager-only, on the assumption that
whoever runs the team's calling book is who sets its numbers — the same
assumption behind keeping `order.approve` off managers, read the other way
round. That assumption was not Mahek's own practice: the accounts desk is who
assigns and manages targets here, so the capability sits in
`ACCOUNTS_OR_MANAGER` beside `sheet.import` now, for the same reason —
widening rather than moving, so a manager coaching a shortfall can still act on
it without asking accounts to do it for them. The Accounts app's own Sales
targets screen, at `/accounts/targets`, is not a second target system: it
reads `targetableCandidates`, `mixCategories` and `baselineFor`, writes through
`saveSalesTarget`/`publishSalesTarget`, and shows the same "Add someone" picker
and "Carried forward" badge `/sales/targets` does — because accounts hold
`apps: ["accounts"]` and are redirected out of the Sales Dashboard before they
would ever reach the original screen, and a second door onto the same feature
that quietly drew a different picture would be worse than no second door. It
adds one thing that screen never had: a **revision history** drawer reading
`revisionsFor`, which had sat in the service since the module shipped with
nothing ever calling it. Holding `order.approve` and `target.set` together is a
new hat combination worth naming on its own terms: an accounts user who is
ALSO a telecaller could now set their own target, which is why
`lib/role-conflicts.ts` names the CRM + Accounts manager pair for it,
beside the one about reporting a payment and then confirming it.

**A person's target and a customer's are two different grains, and they stay
two different screens.** `/accounts/customer-targets` reaches the CRM's own
Monthly Targets — `listTargets`, `setTarget` and `setTargetsBulk` in
`lib/services/worklist-services.ts` — the same way
`/accounts/targets` reaches the Sales Dashboard's: one door added for
accounts, nothing rebuilt. `MonthlyTargetsScreen` moved to
`src/components/customers/`, the same shared home `CustomersScreen` already
has, and takes `app`/`basePath`/`customerHrefTemplate` so the two doors differ only in
where their links lead — Accounts has no customer detail page, so a customer's
name leads to their ledger statement instead, and "See their bills" folds into
that same link rather than pointing at a screen accounts cannot reach. Folding
this into the Sales targets screen as a third tab was the obvious shortcut and
the wrong one: a target set on a PERSON and a target set on a CUSTOMER are
different questions, and one screen answering both from tabs would say which
tab was answering which question and nothing else. The screen's own gating
moved with it — it read `isManager(user)` to decide who may set a target,
which was correct while `target.set` was manager-only and silently wrong the
moment it widened; both doors now check `can(user.role, "target.set")`
instead, the capability itself rather than a role that used to imply it.

**AND THE SALESMAN SEES BOTH GRAINS, on one screen, never added together.**
The handset's Performance screen drew his own target and stopped, so he could
read how far he was from his month and not where the rest of it would come
from. `customerTargetsCreditedTo` is the Targets screen's own population and
its own `targetAchievedSql`, narrowed to the shops CREDITED to him
(`creditedToSql`, not `ASSIGNED_TO_SQL`) — so a manager and the salesman quote
one shop one figure, and `monthly-targets.test.ts` reads both and asserts it.
It rides the sync as `customerTargets`, this month and last, REPLACED wholesale
on the phone like the price list: achievement moves when accounts approve an
order, which gives no row an `updated_at` a delta could carry. The card says
in words that the two targets are not meant to add up. Money taken and not yet
approved — the office's `pending_approval` plus whatever is still in this
phone's outbox — is drawn BESIDE achievement and never inside it, because the
revenue above it counts accepted orders only and a busy morning otherwise
reads as a slow one.

**The score is a CACHE, and not the same kind of column as
`calls.next_step_*`.** `sales_performance` is rebuilt by
`recomputeSalesPerformance()` — nightly for this month and the last, hourly for
this month, because the handset reads the cache and a salesman who took three
orders this morning must not see yesterday's figures all day. Those next-step
columns record what somebody was TOLD on a day and must never be rebuilt; this
is a reading of the present, so a rebuild is a correction rather than a
destruction. The handset is sent the cache with its `computed_at` and prints
it, because a screen that implied it was live would be believed.

**THE HANDSET READS ANY PERIOD, and a month read as a range IS the cached
month.** The sync carries two months, which is what opens with no signal;
this month, last month, either financial-year quarter, either financial year
or two picked days are asked of `/api/mbos/performance`, which takes no user —
the device token decides whose figures, as on `crm.performance`.
`handsetReadingForRange` runs the same `actualsForWindow` and the same
`scoreActuals` the cache is built from, so September picked as a range and
September off the sync cannot disagree; a test asserts it. Over several months
the targets are ADDED, a month only partly inside the range asks for its share
of days, the collection and activity SHARES are averaged over the days rather
than summed (40% then 60% is about 50%, not 100%), and the mix is held to the
latest target's bands. The screen says how many months carried a target. A
year is April to March, because that is the year the bills carry.

**AND A RANGE IS NEVER CLAMPED TO TODAY, which is what made the phone and the
dashboard disagree.** `/api/mbos/performance` cut the end of every range to
today, so "this month" asked on the 7th was 1–7 October, its target was cut to
7/31 of itself, the tasks due later dropped out of the activity base, and the
handset scored a salesman several times what the Performance screen did. The
future has no orders or receipts, so reading it changes no actual; what it
keeps is the whole month's target, which is what the dashboard scores against.
`lib/performance-range.ts` is the one check both endpoints use (a range that
has not started is still refused), and a test asserts "this month" on the phone
equals `readingsForPeriod` on any day of it. Both screens print the score to
one decimal.

**A NAME ON THE PERFORMANCE TABLE OPENS THE PERSON IN DETAIL**, over any range
(`person-performance.tsx`, `/api/sales/performance`, gated on
`sales.performance`). It is `personPerformance`, built on `scoreRange` — the
same computation as the handset's range — so the modal, the phone and, for a
whole month, the table are one figure; the breakdown's points add up to the
score, and a test says so. The table itself fits beside the sidebar at 1280:
each figure carries its achievement under it rather than beside it, and
collection is the share of the old debt collected, never the rupees.

**Collection is drawn as the SHARE it is asked as.** The office sets "collect
half of what was overdue"; the handset showed the rupees, which made the
target read as an amount somebody had picked. The share leads, the money it is
a share of sits under it, and no overdue book is a dash and a sentence, never
0%.

**Working days, never dates.** A month with four Sundays left is not two thirds
gone because twenty of thirty dates have passed, and a forecast built on dates
tells a salesman on the 20th that he is further behind than he is. Holidays
come from `mbos_holidays` and the working week from configuration. The current
day is not counted as elapsed — dividing by a day still being worked makes
everybody look behind every morning — and with no completed day there is no
forecast at all, because one day's selling multiplied by thirty is a
multiplication rather than a projection.

**A visit's ACTIVITY is counted on the server's clock.** `client_created_at` is
what the phone said and its owner can set it, so anything anybody is paid on
reads `server_created_at`. Believing the handset would let somebody backdate a
fortnight of visits into a month they had missed.

**Collection counts confirmed receipts only.** A `reported` or `held` payment
moves no money anywhere else in this product and moves none here either — a
collection target met on a telecaller's word is a target met on money nobody
has found in the bank.

**A new customer is one whose FIRST counting order lands in the period.**
Creating a lead never counts, which is the only definition that cannot be
worked from a desk, and a customer is won exactly once.
