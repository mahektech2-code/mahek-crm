# Potential, timeline, field orders, statements

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**A POTENTIAL IS A JUDGEMENT and is stored with its author and its date.**
`products.priceSource` is still `unset`, so nothing here can derive what a shop
could spend. `potential_monthly_paise` is somebody's estimate, and an estimate
with no date on it is one a reader cannot weigh. The ANNUAL figure and CURRENT
SALES are derived and never stored: the first is twelve times the month and the
second comes from orders, and a stored second copy is one that can disagree.
**The gap is never negative** — a shop buying more than somebody guessed is an
estimate that has been overtaken, and "-₹40,000 opportunity" invites the reader
to see a decline. **No estimate is not a gap of zero**, which would read as "no
opportunity here": null says the true thing, that nobody has judged it.

**EVERY TIMELINE KIND IS A CONSTANT, never a literal at the call site.**
`CRM_EVENT` and `MBOS_EVENT` in `lib/timeline.ts` are the whole vocabulary. The
natural key is (app, kind, source row), so a literal that drifts by one
character produces a stream that can never deduplicate against itself — a
retried sync writes a second copy and the record reads as the salesman having
visited twice. `timeline-coverage.test.ts` reads the source and fails on a bare
string, and on any kind DECLARED and never written, which is the other half:
that one reads on a customer record as a gap in their history rather than as an
unbuilt feature. It found two the moment it was written.

**Where one record produces several events, the STAGE goes in the source id.**
A sample is dispatched, received and reviewed, and all three name the same row —
so `sourceRecordId` is `<id>:dispatched`, `<id>:received`, `<id>:review`. Left
as the bare id the natural key would collapse them onto one row, the first
written would win, and the receipt would never appear.

**QUOTATION IS ABSENT, and that is the honest answer.** §R asks for it; there is
no quotation record in MahekOne to project FROM, and a timeline row with no
source is not a projection — it is a sentence somebody typed, in a table whose
entire discipline is that every row points back at the record that is the actual
truth. A test asserts its absence, so building the record is what deletes the
test rather than the gap being forgotten.

**An internal note's BODY never reaches the timeline.** `visibleToRoles` decides
who may read a note and the timeline has no such gate, so copying the words in
would route a restricted note straight around its own restriction. The entry
records that one was written; the note stays where the rule about reading it
lives.

**"DID WE SELL ANYTHING" IS DERIVED FROM ONE LIST, not restated in SQL.**
`orderCountsSql` used to spell the three counting statuses out as a literal
beside `PURCHASE_STATUSES`, which held the same three — two definitions waiting
to disagree. Adding §N's `in_transit` and `delivered` is precisely the change
that would have split them, and the half that drifts is the SQL: it is read by
the eight money queries and checked by nothing. It is built from the array now,
and `order-status.test.ts` pins the pair against the ENUM as well, so a status
in neither list fails the build rather than silently not counting.

Goods on a lorry are goods sold. An order that reached the customer must not
stop counting towards EOD value, the buying cycle, the product history and
outstanding merely because somebody recorded that it arrived.

**AN ORDER CARRIES THREE PARTIES' WORDS TOO.** `status` is OURS — accounts
accepted it, the godown sent it, the lorry has it. `customer_confirmed_at` is
the SHOP agreeing to what was written down; `delivery_confirmed_at` is the shop
saying the goods came. They are routinely days apart and either confirmation can
come first, so no one column could carry them. `delivery_discrepancy` null means
nobody REPORTED a mismatch, which is not the same as "it was correct" — nobody
was asked.

**A discrepancy notifies and does NOT raise a complaint.** A complaint is the
customer's, with a category and photographs, and inventing one on their behalf
from a delivery note would put words in their mouth on a record they can
dispute.

**A FIELD ORDER IS EDITED BY ITS AUTHOR UNTIL ACCOUNTS DECIDE IT, AND ASKED
ABOUT AFTER.** Before approval nothing has been promised against it, so the
salesman who took it rewrites it from the handset — an `order` update carrying
`lines`, which `handleOrder` routes to `handleOrderEdit`, re-checked against
the same bar as a new order (`checkOrderLines`) and the credit limit, and
refused if accounts decided it meanwhile. After approval the order is the
office's commitment, so a change is a row in `order_change_requests`: what it
should become, what it was, and why. Accounts accept it on Accounts → Order
changes, which rewrites the order, or decline it with a reason the salesman
has to ring the shop with. Past `confirmed` neither — a request cannot
un-dispatch a lorry. One pending request per order, held by a partial unique
index.

**AND THE HANDSET HEARS IT, which it never did.** An accounts decision reached
the phone only through `mbos_approvals`, which accounts do not write, so every
field order read "Sent" or "With the office" for ever and a declined one
carried no reason. `myOrders` sends his own orders' status, reason and lines;
`orderChanges` sends his requests and their answers. Both are applied after
`approvals` on the pull so the order's own row wins.

**A DECLINED ORDER CANNOT BE DELIVERED, whatever a stale handset believes.** The
phone may still be showing an order accounts turned down ten minutes ago —
rejections reach it on the next pull — and marking that delivered would
resurrect a refused sale into every figure `PURCHASE_STATUSES` feeds.

**THE SAME ORDER FROM THE SAME SALESMAN IS A RESEND, NOT A DUPLICATE.** The id
is minted on his handset, so a row carrying it that he took is his first
attempt — written, with the answer lost on the way back, which is the ordinary
shape of a batch slower than the handset's patience. `handleOrder` and
`handlePayment` answer it `accepted` with the stored number; refusing it put an
order sitting in accounts' queue on his Not accepted list, with a bell and a
ring-back task to match. Only somebody ELSE's row under that id is a duplicate.
An order the handset could not value says so (`valueUnavailable`) and does not
overwrite `last_order_value` with its zero.

**THE REORDER DUE IS DERIVED ON THE PHONE, from the customer's own cycle.**
There is no reorder channel on the pull and no connection in a market lane, so
`reorderState` reads `lastOrderDate` and `cycleDays`, which every customer row
already carries. It deliberately does NOT restate the Call Log's ranking: that
engine weighs a reorder against a promise, a debt and a stock check to decide
who to ring first out of four hundred, and this answers one question about one
shop the salesman is already outside. The nightly `raiseReorderFollowUps` raises
a task ONCE — the standing open task is the guard — because thirty rows for one
quiet shop is a list people stop reading. Measured cycles only: a default is a
guess, and chasing on a guess rings a quarterly buyer every month.

**THE STATEMENT IS ON THE PHONE, because the question is asked at a counter.**
A shopkeeper with his own file open asks what was billed in July and what he
has paid against it in one breath, and the answer cannot be an endpoint: there
is no signal in a paint market. So `customer_bills` and `customer_payments`
carry a WINDOW — `mbos.sync.statementMonths`, thirteen — and the record's
Account tab builds the running balance from them locally.

**IT USED TO BE OPEN BILLS ONLY, capped at ten, and that is a reversal.** That
was the collections question: a bill with nothing owed on it is nothing to
collect. It is also 10,405 of the 10,815 bills on this book, so the statement it
would have made was a year with almost every row missing. Dropping `openOnly`
is ALSO what lets the channel be a delta, which is what pays for the extra
rows: the old one could not be `since`-gated, because a bill leaving the open
set by being settled has no row left to carry a cursor. Inside a window there
is no such case — a row is either on the phone already or has a moved
`updated_at`, and a bill leaves only by ageing past a date the handset can read
for itself.

**So the PICKER filters where the wire used to.** `openCustomerBills` asks for
a balance above zero, and `pay.tsx` reads that rather than `customerBills`. A
settled bill offered there is one the salesman names, `handlePayment` refuses
with `bill_settled`, and the refusal reads as the app being wrong rather than
the phone being stale. (Since Nov 2026 `handlePayment` accepts it and spreads
it instead — see payments-and-collections.md — but the picker still offers only
open, stated bills.)

**WHAT WAS ON A BILL RIDES ON THE BILL, as JSON text.** A bill IS the order, so
the lines are the order's — and an order records them in one of two ways: the
sheet and the handset write `orders.line_items` naming the product as TEXT, the
CRM writes `interaction_product_lines` keyed on the CALL. 10,867 of 10,957
orders are the first and 90 are the second, which is exactly the ratio that
makes the second easy to forget and impossible to notice. A column rather than
a table because a bill's lines never change after it is raised: no second
cursor, and no moment where a bill has arrived and its contents have not.

**The running balance is the handset's arithmetic and not a second opinion.**
`engines/statement.ts` is pure and orders rows the office sent; every figure in
it was written by the office. Outstanding stays `customers.outstandingPaise`,
the office's own, and the screen says which figure is which — a total computed
on a phone from thirteen months of rows is how a salesman and an accounts clerk
quote one shopkeeper two different debts with him listening. Only `confirmed`
money moves the balance, which is the one rule it shares with `customerLedger`.

**CUSTOMER ACCOUNTS IS THE ACCOUNTS APP'S CUSTOMER ACCOUNT, on the handset, and
it is ASKED rather than pulled.** More → Customer accounts lists his book the
way accounts read it — who owes, who is over the limit, whose supply is
stopped, with a search over name, owner, city, phone and GST — from the
office's own `outstandingPaise` already on the phone, so the list needs no
signal. Opening one asks `/api/mbos/customer-account` for the account in
full: the statement is `ledgerForCustomer`, the body `customerLedger` was split
into so a device token could reach it after `scopedCustomer` has answered the
scope question the session cannot; bills are `listBills`; the aging strip is
`bucketise`; receipt wording is `receiptStatusSentence`. Nothing is recomputed
on the phone except cutting a window out of balances the office already ran
(`engines/account-view.ts`). The full history of every account on every phone
is not a thing to sync, so the last answer per shop is kept in `kv`, and an
account never opened online falls back on the thirteen-month window above via
`fromPhone` — with every part the pull does not carry (aging, credit notes,
which bill a payment cleared) set to NULL and said as "needs signal", never
drawn as zero. The banner at the top says which of the three answers is on the
screen. It is read-only: deciding about money stays accounts'.

**A STATEMENT IS FOR AN ACCOUNT WE INVOICE, and the other two say so.** A lead
has never ordered and a third-party shop is billed to its distributor, so both
would draw a correct empty list — and an empty list with nothing saying why
reads as a sync that has not finished. It is the sentence the Accounts app
already puts above its own ledger for the same account.

**And the tab says how far back THIS PHONE goes**, read off the rows rather
than off the window the office sent. A shop billed for three months reaches
back three months, not thirteen, and a screen claiming otherwise over a list
that starts in June is one nobody trusts twice.

**THE PHONE SAYS WHAT THE OFFICE WILL REFUSE, BEFORE HE PROMISES IT (Nov
2026).** `handleOrder` has three refusals the handset never asked about, so
"Send for approval" saved an order that came back Not accepted hours later:
the limit with `mbos.credit.blockOnLimitExceeded` on (outstanding + this order
over the limit, no tolerance, no other open orders; an edit only where it
RAISES the value), `mbos.credit.overdueDaysBlockOrders` (now real on BOTH
sides — a new order is refused `overdue_blocked` where the billing party has a
bill that many days past due; 0 is off; `unstated` and disputed bills never
block; `engines/field-order-gates.ts` on the server, `engines/order-gates.ts`
on the phone) and `mbos.orders.minimumQuantityCans`. `assessCart` returns
`officeRefusal`; the dock says it in the office's terms, holds the button, and
— like the credit-block card — offers Call accounts (`mbos.credit.accountsPhone`,
empty hides it) and Collect payment against the BILLER. The handset's fallback
for the overdue key was 90 while the registry's is 0; it is 0. A change request
after approval is held to the minimum only, as `handleOrderChangeRequest` is.

**ORDERED, NOT YET INVOICED IS THE OFFICE'S FIGURE.** The phone kept
`submittedNotInvoicedPaise` itself — up on every save, down only on an edit or
cancel — so a billed, declined or refused order counted for ever.
`openOrderedFor` (mbos-service) defines it once: `mbos`/`crm` orders BILLED TO
the party, `pending_approval` or approved, with no bill against them, ordered
inside `mbos.credit.openOrderWindowDays`, at `orderValueSql`. It rides its own
channel, `openOrdered`, sent WHOLE every pull (the handset zeroes a shop not
listed) — the customers channel is `updated_at`-gated and an order or a bill
moves no customer row. The phone adds only orders whose CREATE is still in its
outbox (`UNSENT_ORDERS_PAISE_SQL`); once the create has gone the order is in the
office's figure. The migration zeroes the old local figure.

**A RATE PER SHOP, NOT PER TAG.** Shops sharing a tag but resolving to
different office price lists got one phone rate and the office refused one of
them `price_changed`. `phonePriceTables` splits such a tag by list under keys
`tag::list` (and an untagged shop a list resolves for under `::list`), sends
`priceKeys` (shop → key) and `priceUnoffered` (what a list prints a dash for);
both replaced whole, `priceList` keeps its old rows under the real tags so an
older build prices as before. The order screen prices off the BILLER's key
(`priceKeyFor`) and marks a dashed product "Not sold to this account", refusing
to add it — the office would refuse it `not_offered`.

**TAKING A REFUSED ORDER AGAIN KEEPS IT UNTIL THE NEW ONE IS SAVED.** "Take the
order again" let the refused entry go first and opened an empty form on the
BILLER (the distributor). It now opens `/order?retake=<queue id>`:
`refusedOrder` reads the payload, the form opens on the DELIVERY shop with the
biller chosen and the lines in the cart, and `finishRetake` lets the refused
entry go only after `saveOrder` returns. Collect it again works the same way
(`refusedPayment`).

**AN EDIT NEVER DROPS A LINE QUIETLY, AND NEVER LEAVES ITS LINES BEHIND.** A
line whose product is retired, or which has no product id, cannot come across;
it is listed on the form and saving asks first. Opening an edit, a change or a
retake sets the shop's own draft aside and puts it back on leaving unsaved.

**AN ORDER STILL IN THE OUTBOX IS REMOVED, NOT CANCELLED.** The office has no
TO to cancel, so `cancelTo` blamed Accounts for a decision nobody made.
`discardUnsentOrder` removes it — its queue rows, anything queued behind it,
its lines and row — while the create is `queued`, `failed` or `blocked`, never
while `syncing`. Your orders offers Edit and "Remove — not sent".

**THE ORDERS TAB HAS WHAT WAS DELIVERED THERE, AND WHAT HE JUST TOOK.**
`recentOrders` also sends each order DELIVERED to a shop in the book, under
`<order id>@<shop id>` (the handset table is one row per id; the journey strips
the suffix when it de-duplicates). The tab merges his own orders not yet
accepted (`LOCAL_ORDERS_FOR_SHOP_SQL`), marked "Not sent yet".

**A LEAD WITH BILLS SHOWS THEM.** The Account tab's "nothing billed to a lead"
is drawn only when there are no bills and no receipts.

**THE ORDER NUMBER'S YEAR IS THE ORDER'S.** `handleOrder` took the financial
year from the sync day; an order taken on 31 March and synced on 1 April was
numbered into the next year. It is `financialYearOf(orderDay)`.

**EVERY OPEN BILL IS ON THE PHONE, WHATEVER ITS AGE.** The statement window
(`mbos.sync.statementMonths`) took a fourteen-month-old unpaid bill — the oldest
debt, the one being chased — off the collection picker. `customerBills` sends
"in the window OR open" on a first send and any bill that MOVED on a delta; the
handset prunes only settled bills past the window and keeps the window in `kv`
so the statement's running balance still starts where its receipts do.
