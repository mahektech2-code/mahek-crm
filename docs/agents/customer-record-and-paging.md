# Customer record, list paging, keyset cursors

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**A customer record is a FIXED-LENGTH page, however old the account is.** Every
panel on it is the same height and scrolls inside itself, and the reads behind
them are capped — the timeline at ten entries a page (`TIMELINE_PAGE`, one
constant so the first read, the Load older button and the sentence counting
them cannot disagree), the messages at fifty, the rest at two hundred. COLOUR CAMP is why: 3,504 timeline entries were serialised
into the page and rendered into the DOM, so the orders, the bills, the payments
and the arrangement sat a hundred screens below the fold. The accounts with the
most history are the ones somebody most needs to read before ringing, and they
were the ones whose record you could reach the least of.

**A LIST COSTS ITS PAGE, NEVER ITS HISTORY.** The ERP's screen contract was
`load(ctx)` — every row the screen could ever show, built into objects with
their drawers and actions, then searched, sorted and cut to twenty-five in
memory. Fine at twelve trial orders; the day the Taken Order history arrived it
was 22,154 order lines, and the sidebar badges read the whole book three times a
request on top of the screen itself. The server went past its 320 MB heap, was
killed, restarted, was killed again, and the whole suite answered 502.

So there are two kinds of list and each is read in SQL. A REGISTER — orders,
order details, purchases, inward, tests, SFG/FG/packing batches, the three
stock logs, transfers, batch codes, the bills register — declares a `window`
(the date it is cut by, and the period it opens on, usually this month) and
`load(ctx, scope)` turns `scope.window` into a WHERE (`lib/erp/window.ts`); the
period travels in the URL as `pd` and the toolbar has a picker
(`lib/erp/period.ts`, pure, financial year from April). A LIST OF WORK — pending
and ready orders, the labels list, badges, the dashboard's sales tiles, the
alerts' "still stuck" checks, the factory phone — reads by STATE
(`orderLines({ openWork: true })`), so it is as large as the backlog. Every
search, chip, sort and group keeps working inside what was read.

**The window cuts the register, never the work.** A line still awaiting
dispatch verification, an inward not yet routed, a test nobody has decided all
show whatever the period. `?open=` and a dashboard's `?f=` ids WIDEN a window
rather than narrow it, because they name records somebody asked for; "Show the
whole order" is ids for the same reason.

**And a window has a ceiling.** A register counts before it builds and, past
`ROW_CAP` (3,000), builds nothing and says so ("that period is too long to
show"). That is what makes the server's memory a function of the cap rather
than of the data: "All time" is allowed while all time is small and refused, in
words, the day it is not. Stock screens open on all time under their OWN,
higher cap (`STOCK_ROW_CAP`, 25,000): their lots are summed in SQL before the
cap is asked, so refusing them saved nothing and left Stock on hand answering
"too long to show" on a book whose dispatches were never imported, which holds
every lot ever made.

**Stock reads return lots that hold something, and rates only for those.**
`rmLots`/`sfgLots`/`fgLots`/`packLots` used to return every lot ever made and
cost every one of them from every line (`sfgRates`, `fgRates`,
`packBatchCosting` pulled ~10k raw rows each, on the factory phone's 45-second
poll). Now the default is non-zero stock, and a caller that needs a used-up lot
— a trace, a label, the lot a scan names, the costing of a lot already
allocated — names it (`LotPick`). The rate helpers take the lots they are asked
about and sum in SQL.

**A stock CHECK asks for no rate (`LotPick.rates: false`).** A lot's rate is
the whole book's costing (`ledgerDerived`), worked out again after every stock
write — so a check that only reads `stock` and asked for the rate anyway paid a
walk of the whole book for a figure it threw away. On the lorry that was once
per box scanned (`lotFree`), each scan's own write forcing the next scan's
walk. Every consuming check under a lot lock, the factory phone's lots and the
loading pack pass `rates: false`; pass it wherever a read uses `stock` alone.

**`erp-scale.test.ts` holds the line.** It seeds a book the size of the real one
and loads EVERY built module as the page would, failing if any builds more than
`ROW_CAP` rows: a new screen that reads a whole table fails in CI, not in
production. `load(ctx)` with no scope reads all time under the cap — that is for
tests and tools; every request path (the page, Logistics, Export, Select all,
the ask box) passes a scope.

**Alerts are news, so they read a lookback.** `erp.ai.alerts.lookbackDays`
(30): purchases, losses, slow dispatches and expenses from inside it, and what
is still stuck by state however old. Reading everything raised 237 "rate jumps"
out of 2024 purchases the day they were imported; an alert whose subject falls
out of the lookback resolves on the next pass.

**A capped list says what it is a slice of, and the count comes from SQL.** The
timeline's filter pills used to count what had been loaded, which is exactly
why the page loaded everything: a capped read would have printed "Bill 34"
against an account with 1,060 and nothing on the screen would have said so.
`customerTimelineCounts` is seven `count(*)`s on indexed columns; the pills read
those, "Load older" pages with a KEYSET rather than an offset, and picking a
kind asks the server for that kind's newest page rather than filtering the fifty
rows the browser happens to hold. Filtering in the browser would answer "the
bills among the newest fifty entries" and call it the bill history.

**And a stored DATE is not an instant until something names the midnight.**
The third spelling of the zone rule, and the one that only shows up under load:
`bills.bill_date` and `payment_receipts.received_at` are dates, and a bare
`::timestamptz` on either is evaluated in the SESSION's zone. The session's zone
is not a property of the row — one pooled connection left in Asia/Kolkata by an
earlier query returned a bill as 18:30Z while the rest returned it as 00:00Z, in
one process. A timeline cursor taken from one page then excluded nothing on the
next, and five rows came back twice. It is
`::timestamp at time zone ${APP_TIMEZONE}` now, and a third grep test guards the
direction: the two beside it watch timestamps becoming dates, this one watches
dates becoming timestamps. Local Postgres runs in Asia/Kolkata and agreed with
itself, so it passed here and failed in CI — which is the same trap the rule was
written for, arriving from the other end.

**A paged read needs a tiebreaker in its sort.** A thousand bills share a
handful of midnight timestamps, so `order by at desc` alone leaves their order
to the planner — invisible until it is paged, and then it is a row appearing on
two pages while another appears on none. The sort is `at desc, id desc` and the
cursor is `(at, id) < (…)`. There is a test that pages a book of 55 bills seven
to a day and asserts it sees all 55 exactly once; the seven is chosen not to
divide the page size, because at twenty a day with pages of twenty every page
ended on a date boundary and the broken cursor passed.
