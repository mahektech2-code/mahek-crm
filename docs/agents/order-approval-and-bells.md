# Order approval, decline notices, per-app bells

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**An order taken on a call is the customer saying yes, not the business.**
Accounts check who they are and what they already owe before it is accepted,
so a new order sits at `pending_approval` until they decide. Two different
questions get asked of the same row and they have different answers: "did the
customer order" is true from the moment it is logged, and drives the calling
queue; "did we sell anything" is true only once approved, and drives EOD value,
targets, the buying cycle, the product history and outstanding. The second
question is asked in eight places and they all read `lib/order-status.ts` —
before that existed they said `status <> 'cancelled'`, which would have counted
every pending and declined order.

**`lastOrderDate` moves on capture, not on approval.** It is the signal that
stops the queue chasing somebody who ordered this morning, and a telecaller
must not ring them because approval is slow. A declined order drops out of it,
so the customer returns to the list on their own cycle. The buying cycle uses
approved orders only, which is why `writeCycle` takes the placed date
separately — computing both from the same rows put them in conflict.

**Approving is accounts' and nobody else's.** Not a manager by seniority: the
person chasing the target must not sign off the orders that hit it. Declining
requires a reason, and it lands on the customer timeline, because the telecaller
has to ring back and say something.

**AND THE PERSON WHO TOOK IT IS TOLD, which for a long time they were not.**
The sentence above was the whole of it: the reason landed on the timeline and
stopped there, so the telecaller who had promised a customer their order found
out by opening that customer's record — which nobody does unprompted. In
practice the customer rang first. Every other write in this app that changes
somebody else's work already tells them: a reassignment tells both sides, a
feedback reply tells the reporter, a target revision tells whoever it was set
for. `lib/notify.ts` says in as many words that a decision nobody receives is
not a decision, and `lib/actions/sales.ts` says it about MBOS approvals — an
order decision was the one path in the app that never said it.

**The reason travels IN the message, not behind a link.** It is the entire
content of a decline — they have to ring the customer and say something — and a
notification that makes somebody open a screen to find out what to say is one
they read later. The decline is `kind: "warn"`, which is a kind the bell
actually colours: it reads `warn` and `danger`, and the several existing callers
writing `warning` are silently drawn as ordinary.

**And it carries NO `mbosHref`, deliberately.** The obvious guess is
`/rejections`, since that is where a field salesman reads what the office
refused — and it would be wrong. That screen renders `listRejections` from the
handset's own OUTBOX: records refused before they were ever stored. An order
declined here synced perfectly well days ago, so it is not in that queue and
never will be, and the tap would land on a screen that does not contain it. A
null falls through to `/notifications`, which carries the reason in the body —
the honest default `notify.ts` names, and better than a deep link that is
confidently pointed at nothing.

**EACH APP'S BELL IS THAT APP'S, AND THE APP IS READ OFF THE LINK.** The bell
used to be one list per person in every header, so the ERP's badge on a godown
tablet counted CRM leads. A notification belongs to the app its `href` opens —
`notificationAppOf` in `lib/notification-apps.ts`, pure, over the same
`APP_ROUTES` (`lib/app-routes.ts`) the proxy names a request's app with — and
`notificationAppSql` is the same rule as SQL for the badge, the list and "Mark
all read"; `notification-apps.db.test.ts` fails if the two disagree. It is
DERIVED, never stored: a dozen writers insert their own rows, and a column each
had to fill would be empty on the one that forgot. No link, or a link into no
app, is GENERAL and shows in every bell; a handset-only row is `field`. An
app's bell counts and pops its own and the general ones; "All apps" is one tab
away and "Unread in other apps" says what waits where. Give a new notification
the right `href` and it lands in the right bell.

**A NOTIFICATION CARRIES TWO ADDRESSES, AND BOTH ARE STORED.** `href` is the
web route and `mbos_href` the handset's. The second used to ride on the push
alone, so the phone's bell list — filled from this table on every pull — was
handed `/crm/performance` and `/field/tasks`, routes its router has never heard
of, and a tap landed on "Unmatched Route". The pull sends `mbos_href` as the
handset's `href`; null opens nothing. The Sales Dashboard's `tell()` likewise
takes the screen from its caller: it used to send every push — a task, a route,
a lead — to `/rejections`, the list of records the office REFUSED, which by
construction contains none of them.

**Whose number it is, is `orders.userId` — never whoever owns the account
today.** The person who has to ring back is the one who made the promise, and a
reassignment since does not move that. Two people are deliberately not told: an
order the SHEET wrote carries no `user_id`, because nobody in MahekOne took it,
and an approver who is also the taker does not need telling what they just did —
the same discipline as a reassignment that changes nothing notifying nobody.

**It runs after the transaction and can never fail the decision.** The order is
decided, audited and recomputed before the courtesy runs, exactly as the
next-step sentence is a courtesy on top of a completed call. A bell that could
not be written must not undo an order decision already standing in the ledger.

**ACCOUNTS EDIT AN ORDER'S LINES WHILE APPROVING IT, in place and without the
ERP grant (Option A).** Product, cans, rate, discount, a line added or taken
off, and a missing rate filled before Approve. The billing party, the delivery
party and the godown are NOT theirs: the dialog shows them read-only, the
action refuses a body that names one, and the write carries them over from
the order as it stands. A TO is changed in its review (Save changes, or with
Approve) through `saveIntakeLinesByAccounts`/`approveIntake`; a numbered order
on "Other orders waiting" through `editOrderByAccounts`, which writes with the
Production Head's own `writeOrderEdit` and then `syncBookOrders`. Both ask the
Accounts app AND `order.approve`, re-check the order is still waiting for
Accounts, and audit (`order.to.accountsEdit`, `order.accountsEdit`). Saving is
not deciding: the order stays in the queue, and a saved edit needs no approval
again. An order with no order number (a CRM or handset order the ERP never
took) has no ERP lines behind it, so its Edit order is off with a reason.

**A REASONED "NO" ASKS FOR THE REASON, THEN SHOWS WHAT IT TOUCHES.** Declining
an order, declining or sending back a TO, and the taker cancelling their own
TO are `ReasonImpactDialog` (`components/ui/reason-impact-dialog.tsx`): the
reason box, then the ImpactDialog with the reason held, and only the typed
confirmation sends both. The acts call `confirmImpact` after their own
permission check and only once there is a reason, so an empty reason keeps the
service's words (`accounts-order-decline`, `accounts-to-decline`,
`accounts-to-send-back`, `crm-to-cancel` in `impact/kinds/order-decisions.ts`).
Hold is NOT routed through it — it moves nothing a person has to be warned
about and is undone by Release. HQ's Decline calls `declineOrder` (the
service) directly, behind its own reason form and confirm, because its row
acts draw no impact modal; the Accounts action is the one that demands it.

**A HELD ORDER IS STILL WAITING, SO ORDERS ON HOLD OFFERS WHAT APPROVALS DOES
(Nov 2026).** An Accounts hold leaves `orders.status = 'pending_approval'`, so
`held-orders.tsx` gives each row Edit order (`EditOrderDialog`, the order stays
held) and Decline (`ReasonImpactDialog`, `accounts-order-decline`; the decision
resolves the hold through `afterBookDecision`), the customer's ledger, and —
for whoever holds the ERP app — the order in Billing & dispatch
(`/erp/orders?view=orderDetails&q=<no>`, the nearest thing to an order record;
there is no order page of its own). Bill rows on Accounts › Bills and Sales ›
Invoices link the same way (`components/bills/bill-links.tsx`, numbers from
`erpOrderNosFor`), each link only for a reader the destination admits.
