# Delivery proof

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**A BILL GOES ONE OF TWO WAYS, and the order says which.** "Delivered by" on
the ERP order form is a Transporter or a **Mahek Vehicle** — our own vehicle.
Mahek Vehicle is a RESERVED TRANSPORTER NAME (`MAHEK_VEHICLE`,
`isMahekVehicle` in `engines/logistics.ts`, seeded into `erp_transporters` by
`0301`), so every place that carries a transporter as text — the order line,
the bill, loading by transporter, trips, a party's default — carries it with
no new column, and lorry loading groups those orders as one "Mahek Vehicle"
lorry. `carrierOf` in `screens/sales.ts` turns the form's `deliveredBy` into
the transporter; an older page that sends none keeps meaning its transporter
box. What differs is the PROOF and the road: a Mahek Vehicle bill is
`onRoad` the moment it is dispatch-verified (`phaseOf` reads the
transporter), which then refuses a missing vehicle number or driver; there is
no transporter's godown and no LR; the team rings the driver (`driverPhone`
reads the mobile out of the driver text); `updateConsignment` moves it with
no LR; `attachLr` refuses it; and `markDelivered` closes it ONLY with a
customer-signed copy and who signed. `setDeliveredBy` changes who delivers a
bill until it is delivered, never while it is under an LR, and moves the
order's own lines with it.

**A SIGNED COPY IS AN `erp_lrs` ROW of `kind = signed_copy`** — uploaded,
read, voided and attached by the LR machinery, with `erp_transports.signed_copy_id`
pointing at it. It carries no LR number or transporter (both are dropped on
upload, and `setLrKind` clears the number when an upload moves over), and its
own facts are `bill_hint`, `party_hint`, `received_by`, `delivered_on`.

**THE PHONE ONLY UPLOADS; THE LAPTOP TEAM CHECKS.** Factory app → More →
Upload LR or signed copy is pick LR or Signed copy, up to `LR_PICK_MAX` (10)
photos, crop/rotate/remove each (`factory-mobile/src/photo-preview.tsx`,
expo-image-manipulator), Send — nothing typed. The laptop's Upload modal is
the same, pick-only. The server ceiling stays `LR_BATCH_MAX` (20) because an
APK in the field still sends that many, and `saveLrPhotos` reads a missing
kind as an LR. Every photo is read AFTER the answer (`readStoredLrs`, in
`after()`): an LR's fields, a signed copy's bill, party, signer and date, and
what kind of paper it looks like (`read_kind`). What the AI read is KEPT in
`read_lr_no` even where it was not written into `lr_no` (unsure, or already
on another LR), because the duplicate check and the desk's "Use 1101" read it.

**THE SAME BYTES ARE STORED ONCE, SILENTLY; ANYTHING ELSE IS A QUESTION.**
`uploadLrs` compares `attachments.content_hash`: a photo already on a live copy
answers with that copy and writes nothing. Everything else is FLAGGED on the
Documents desk by `duplicateFlags` (`engines/delivery-proof.ts`, pure, run in
the browser and again by `discardDuplicate`): same transporter + number
(typed or read) is a duplicate, or "attached" where the first is already on
bills; the same number with a transporter unread, or a number one character
from another with the same date and boxes, is a CHECK; a signed copy of the
same bill (its last digits, `billKey`) is a duplicate. The EARLIER copy is
never flagged, so discarding the later one always leaves one. "Different —
keep both" stamps `dup_cleared_at` and the copy is never flagged again;
"Same — discard" voids it naming the first, the one void with no typed
confirmation, because it can only remove a second copy. Different numbers of
one transporter, and one number of two transporters, are different papers.

**THE DOCUMENTS DESK IS THE ONE PLACE A COPY IS CHECKED** (Logistics →
Documents desk, the `pendingLr` tab, `parts/documents-desk.tsx`). LRs and
Signed copies tabs; a mark per copy (ready, something to add, possible
duplicate, being read); the photo with crop and rotate (`parts/photo-editor.tsx`
→ `replaceLrFile`, which moves only the file); the fields; and the bills
ranked by `rankForLr` / `rankForSignedCopy`. An LR's `party_hint` and
`bill_hint` are its CONSIGNEE and our invoice number printed on it (the same
columns a signed copy's party and bill use), read by the AI and edited on the
desk; `rankForLr` scores the bill number and the party first, and
`sameParty` compares names on their distinctive words only. An LR's date is
read from the PRINTED text, day first (`lrDateOf` in `engines/lr-read.ts`),
not from the model's conversion. A third tab, **Pending**, lists the bills
still waiting for their paper (`pendingOf` in `engines/logistics.ts`: no LR
past `erp.ai.alerts.stuckLrDays`, at the transporter
`AT_TRANSPORT_STUCK_DAYS`+ with no LR, or a Mahek Vehicle bill with no signed
copy), one reason per bill, oldest first, in the same fixed-height list so a
hundred of them never push the page; a bill opens beside the copies that may
be it, and "Check and attach" opens that copy with the bill pre-ticked, so the
attach is the ordinary one. "Attach N ready" is
`attachReady`: only copies with no flag, nothing missing (`missingFor`) and
one CLEAR winner (`confidentPick` at `READY_SCORE`), each through the
ordinary `attachLr` / `markDelivered`. A copy the AI thinks is the other kind
says so (`wrongKind`) and moves with one press. A Mahek Vehicle bill out past
`erp.ai.alerts.stuckLrDays` with no signed copy raises **Signed copy missing**.
The customer's page skips the transporter's steps for our own vehicle
(`OWN_VEHICLE_SKIPS`) and offers the signed copy as its document once
delivered.

## The Order Hub — a TO number before the order number

**EVERY ORDER STARTS AS A TO, AND ACCOUNTS' APPROVAL MAKES ITS ORDER NUMBER
(Option A, Nov 2026).** While `erp.orders.live` is on, the ERP's New order
form, a TeleCRM call and the Salesman App all write an `erp_order_intakes` row
(`TO-<n>`, series `tempOrder`) through `createIntake` — never an `erp_orders`
row. It first shipped with two checks on the TO (the "back office" and the
Production Head) and two more after the number (Accounts and the MRP check);
the back office WAS Accounts, so each desk looked at every order twice. Now
Accounts decide the TO on Accounts › Order approvals (`order.approve`, the
Accounts manager's; `services/to-approval-service.ts` over `approveIntake`,
`sendBackIntake`, `holdIntake`, `releaseIntake`, `declineIntake` in
`lib/erp/order-hub.ts`): Approve calls `makeOrder` with `accounts_check`
already Approved (a Pending customer's lines with it — no separate "Approved
By Admin"), Send back goes to the taker with the reason, Hold uses the
Accounts reasons and Release brings it back, Decline needs a reason, tells the
taker, declines a TeleCRM/handset `orders` row with it and writes the
customer's timeline. The Production Head's ONE check is the MRP check. The
ERP Order Hub keeps the list, Edit TO and Cancel TO; its Verify buttons and
`verifyOrders` are no longer part of the flow. A new TO tells the Accounts
managers who hold Order approvals; approving tells the taker and the
Production Head. The Accounts deadline covers TOs (`kind = 'to'`, `0350`).

**ACCOUNTS CHANGE THE LINES, NEVER THE PARTIES.** In the review Accounts may
change a line's product, cans, rate and discount, add or take off a line, for
THIS order only (`approvalLinesRefusal`; a rate Accounts set is stamped
`rate_set_by_id`). Every line needs a rate to approve — Accounts fill a missing
one. The billing party, delivery party and godown are shown, not edited: a
wrong one is sent back.

**A DUPLICATE IS THE SAME ORDER PUNCHED TWICE (orders shared on WhatsApp groups
are punched by more than one person).** The rule is `sameOrder` in
`engines/order-hub.ts`, pure: the same day, the same billing party AND the same
delivery party, exactly the same items (product and cans). A different delivery
party is a different order. `createIntake` asks it under an advisory lock per
billing party, so two people saving at once cannot both slip through: in `ask`
mode (the ERP form) an unanswered match throws `DuplicateFoundError` and the
form shows the popup; in `flag` mode (inside TeleCRM's call transaction, and the
Salesman App, which may have had no signal) the TO is made and marked
`duplicate_state = 'possible'` for Accounts — an order is never lost to the
check. The popup's buttons are "Same order - don't create" (nothing is made; on
TeleCRM the call still saves as Order received; `tellSameOrder` tells whoever
punched the first) and "Different order - create it" (a reason, stored with who
said it, `duplicate_state = 'different'`). The one line under the comparison is
written by a model (`erp.orders.duplicateAiModel`) where a key exists and by the
rules otherwise; the match itself is never the model's. `erp.orders.duplicateCheck`
switches it off.

**AN ORDER IS EDITED UNTIL BILL IT — by the Production Head in the ERP.** The
lock at the order number is gone. Orders › Edit order (`productionCheck` power,
or an ERP administrator) changes goods, cans, rates, discounts, the parties,
the transporter and the dispatch day, adds or takes off a line, and nothing is
approved again (`saveEditOrder` in `screens/sales.ts`). A line whose product
changes, is taken off or whose cans drop gives its allocated lots and scanned
boxes back to the shelf (`releaseLine`), and a Ready line the shelf no longer
covers goes back to Under Process. Billed (or dispatched) is locked; Undo
billing unlocks it. The taker edits a TO from TeleCRM › My orders or the
Salesman App only until Accounts approve it. Cancel, Delete, holds, Undo billing
and Ready keep the rules they had.

**TWO GATES AFTER THE ORDER NUMBER, AND THE DEFAULTS ARE WHY NOTHING STOPPED.**
`accounts_check` (Accounts approve, hold or decline — `afterBookDecision`
writes it) and `production_check` (the Production Head clears it at Sales ›
MRP check, `engines/mrp.ts` reading stock as it stands; capacity is his tick,
because MahekOne does not know it). `lineCleared` is both; Under Process, the
day's plan, Ready and billing all ask it (`gateRefusal`). Both columns DEFAULT to
the cleared value, so every line from before `0347` carried on. Customer
tracking's "confirmed" now needs Accounts' approval.

**COUNTED ONCE.** A TeleCRM or handset order already has its `orders` row; the
TO points at it (`origin_order_id`), and `makeOrder` sets its `external_ref` to
`ERP-<order no>` so `syncBookOrders` adopts it rather than writing a second.
Until then it stays `pending_approval` — never `captured`, which counts as a
sale — and `pendingOrders` leaves it out of the Accounts queue. An open TO
still holds its customer off the Call Log (`recomputeErpOrderHolds`).

**ONE TO HOLD, AND RELEASE SENDS IT BACK TO WHOEVER HELD IT — EXCEPT AT THE MRP
CHECK, WHERE RELEASE CLEARS IT.** A TO's hold is on the TO; an order's is an
`erp_order_holds` row with a `department` (office, accounts, production). A held
TO is listed under Accounts › Order approvals (and Sales › To Hold) and
releasing it brings it back to Order approvals; an Accounts hold on a numbered
order goes back to Order approvals; an office hold goes back where its lines
were. The MRP check is one screen with two tabs, Pending checks and On hold, and
releasing a production hold CLEARS the order straight to Under Process with no
second check. A hold can be kept internal (`erp_order_holds.customer_visible`,
`0350`): the MRP Hold dialog's "Tell the customer" is off by default, and an
internal hold never reaches the customer's tracking page or messages.

**"WAITING ON ACCOUNTS" IS ONE FRAGMENT.** `awaitingAccountsSql` in
`lib/order-status.ts` leaves out TOs and Accounts-held orders, and the approval
queue, the Accounts home and queue badges, the accounts deadline, the automatic
approval task and the Command Centre all read it — so no TO raises a deadline
or a task the queue does not show. The hub's sidebar badges and dashboard
tiles are `orderHubCounts`, each the count its own list draws.

**ONE READING OF WHERE AN ORDER IS, ON EVERY SCREEN THAT SHOWS ONE.**
`journeyOf` in `lib/order-journey.ts` (pure) turns the facts — the TO's checks,
sent-back note, hold and cancellation, the order number, Accounts' and the MRP
check on the lines, a desk's hold, the tracking milestones — into one status
word, the events in order, and the handset's ladder; `services/order-journey-service.ts`
reads them for a page of `orders` rows. TeleCRM's **My orders** (`crm.my-orders`)
lists the caller's own; the customer record's Orders tab draws the newest as a
thread (`components/orders/order-journey.tsx`); `myOrders` on the sync carries
the same words to the Salesman App (`toNo`, `erpOrderNo`, `journey*`), and its
delta also sends an order whose TO, lines, hold or milestone moved. Change and
Cancel TO are the TAKER's, only while it is a TO (`actions/my-orders.ts`).

**THE HUB'S SCREENS ARE DRAWN AS THEIR MOCKUPS, ON THE SAME ACTIONS.**
`/erp/order-hub`, `/erp/mrp-check` and `/erp/to-hold` are pages of their own
(static routes beside `[slug]`), not the generic list: figure cards, underlined
tabs, a table with the row's main button beside it and the rest behind ⋯
(`app/erp/_ui/board.tsx`). Their rows come from `hubBoard`, `mrpBoard` and
`holdBoard` in `screens/order-hub.ts`, and every button runs the list module's
OWN action (`hubActions`, `mrpActions`, `holdActions`) through the ERP kit, so
who may clear, hold or release is decided where it always was. Under Option A
the Order Hub verifies nothing (Edit TO and Cancel TO only); the MRP board has
Pending checks and On hold tabs, and its Release is the `mrpHold` module's,
which clears the order. The ERP's header and sidebar are unchanged. The New
order form's review page is `FormSpec.review` (the order's few facts, its lines
with amounts, the TO notice); a duplicate is the server's popup, not the review.
Accounts' Order approvals is the TO queue (`to-approvals.tsx`); `approval-board.tsx`
over `approvalBoard()` is drawn below it only for orders that reached Accounts
without a TO, and Orders on hold has its own page. A call that takes an order
shows "Order taken: TO-n" (`order-taken-dialog.tsx`, from `takenTo` on the
save). The handset has `/order-sent` (the receipt after an order outside a
visit) and `/order-detail`.

**An edited TO rewrites its call's order.** `editIntake` calls
`syncOriginOrderFromIntake` (`book.ts`), so the TeleCRM or handset `orders` row
says what the TO now says; the handset's own edit, which has already rewritten
that row in its transaction, passes `syncOrigin: false`. And a TO keeps where
it was TAKEN — "TeleCRM" and "Salesman App" (`TAKEN_SOURCES`) are carried onto
its order lines, which `0347` widened `erp_orders_order_source_check` to allow;
before that the second check of every such TO was refused at the insert.

The handset's screens arrive with an APK release; an older build shows the TO
number as the order's number.
