# Logistics

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**THE ERP'S TRANSPORT SCREEN IS THE LOGISTICS DESK** (`/erp/transport`, key and
slug kept so grants and bookmarks hold). One tab per step: **To transporter**
(dispatched bills on their way to the transporter's godown at Bhiwandi — due
today / tomorrow / a day, box count, "Reached transporter"), **LR desk** (LRs
the dispatch team uploaded, attached to their bills), **On the road** (one card
per LR: ring, update, report a problem, deliver), **Delivered**, **Customer
messages** and **Transporters**; **Today** is the pipeline and what needs
attention. Rules are pure in `engines/logistics.ts`; reads and writes in
`lib/erp/logistics.ts`; actions in `lib/actions/erp-logistics.ts`.

**THE PHASE IS DERIVED, NEVER STORED** — the stage plus whether there is an LR
(`phaseOf`). "At transport" is the one new stage (0250 widened the check). A
bill moved past Dispatched with no LR is still waiting for its LR.

**A CONSIGNMENT IS ONE DISPATCH, NOT ONE ORDER NUMBER — and that is a reversal
(0279).** `erp_transports` was unique on `order_no` and verify inserted with
`onConflictDoNothing`, so a line verified on an order number that already had a
row opened nothing and never reached Logistics: every order copied in from the
Taken Order history whose number carried an old (usually closed, so hidden)
row, and the second half of any order sent in two goes. `openTransports` in
`screens/sales.ts` is now the one hand-over: lines of one order and bill
verified together share a row; a later line joins it only while it is still at
the gate (no LR, stage Dispatched, opened by a verify); anything else opens a
row of its own. `erp_order_details.transport_id` records which row each line
left on, and `fillPackages`, `billLines`, the book's stage and extra expenses
read it (a pre-0279 row no line names reads its whole order).
`syncDispatchedTransports` is the net: on Logistics page load and hourly
(`erp-dispatch-transports`), any line verified in the last
`erp.logistics.syncDays` on no row is given one, dated its dispatch date.
Readers that join `erp_transports` on `order_no` must expect several rows.

**COLLECTING AN LR AND ATTACHING IT ARE TWO JOBS.** The dispatch team uploads
(`erp_lrs`) through the Upload LRs MODAL on the Logistics screen and the
Dispatch desk (`parts/upload-lrs-button.tsx`; the old `/erp/transport/upload`
only redirects to a desk with it open); logistics attaches on the LR desk.
**A photo is READ as it uploads** (`lr-upload-read.ts`, OpenAI through
`erp.ai.photos` and its cap): the model is given every transporter's
`consignment_label` and its last few LR numbers, because a receipt carries half
a dozen numbers and the transporter's own style is what picks the right one;
`engines/lr-read.ts` matches the transporter to the desk's spelling, marks a
number not shaped like its earlier ones to check, and drops an impossible date.
It fills only fields nobody typed; Upload is still the save, and settles the
reading accepted or edited.
**No upload field is required** (`lrRowHasAnything`): a photo alone is an LR,
so `lr_no` is nullable (`0251`), and the number is demanded at ATTACH instead,
because the customer's message quotes it — the desk marks such an LR "Number
not typed" and Edit adds it. An upload is never
deleted — voided with a reason. One LR is one delivery party (`attachRefusal`).
Once attached, the LR is the unit on the road: every update moves every bill
under it. Every step writes `erp_transport_events`, append-only.

**A TRANSPORTER'S GODOWNS ARE ROWS, AN AREA AND A GST NUMBER EACH, WITH THEIR
OWN PEOPLE — and that is a reversal.** `erp_transporter_godowns` is a godown: a
name, ONE AREA of the reviewed place tree picked State → District → City → Area,
every rung required, each list narrowed by the one above; its own GST number
(`gstin`, `0262`), OPTIONAL — GST is mandatory nowhere on a transporter; its PIN (`lat`/`lng`, both or neither); and its people. It
was picked at a district only, and `0259` had moved every city and area up to
it — Mahek asked for all four. The tree is built from where CUSTOMERS are, so
it is missing places a godown can be in (211 of its 581 cities carry no area):
a district, city or area that is not listed is TYPED under the rung above and
created on save by `placeFor` in `logistics.ts`, matched first on `placeKey`
under the same parent so it is never made twice — a typed name that is already
listed IS the listed one (`resolvePick`). A state is never typed: the picker
offers the country's (`INDIA_STATES`). GST is registered per state, so a
godown's number, where one is given, must check out AND its first two digits
must name the godown's state (`godownGstProblem`); the transporter's own `gstin` is now the
optional head-office number. The transporter form lists the godowns and each
opens in its own modal (`GodownDialog`), whose Done runs the same
`cleanGodowns` as the save. A godown saved before this reads at its district
and is refused on the next save until its city and area are picked —
editing a transporter is when the gap is filled, never silently. The places a
godown adds are ordinary `places` rows with `shops = 0`, so the customer place
filters may list them. `lib/erp/transporter-godowns.ts` is the rule, pure. The pin is
picked on the map, typed, or read off the device standing in it; the ERP's pin
fields fetch the tile key from `/api/erp/map-key` (anybody holding the ERP; the
live key in the pool), and "Find in map" writes a click or a drag into the
field at once. There is no address on the form; a godown that carried one
keeps it unseen. `erp_transporter_contacts` is a person there, with up to three
numbers (a check constraint holds the three); the form shows a name and one
number, and more numbers saved earlier are kept. `0255` carried each earlier
picked place in as a godown and the old contact columns in as its first person.
The godowns are saved WHOLE, ids
kept only where they were this transporter's own. `erp_transporters.phone`,
`alt_phone` and `contact_person` are MIRRORS of the first person with a
number (`mirrorsFrom`), written on save, because the call buttons on bills and
LRs read the row.

**THE CUSTOMER IS TOLD AT EVERY STEP THAT MOVES, from facts only.** LR attached,
stage or expected day moved, a problem, delivered — `customerMessage` leaves out
anything nobody entered. A call that moved nothing tells nobody. Messages live
in `erp_transport_messages`, NOT `wa_messages`: a confirmed message there is
contact and quiets the Call Log, and a lorry update must not. They go through
Wati only with the founder's switch on and `erp.logistics.watiTemplate` naming
an approved template that asks for nothing logistics cannot fill; otherwise
they wait as "to send" with the reason, sent by hand from WhatsApp and marked.
DND, do-not-contact, no mobile and a staff member's number are recorded as
skipped with why. Wati's ticks reach them through `applyWatiEvent` (`etmsg_`).

**THE CUSTOMER'S LINK NEEDS NO SIGN-IN AND SHOWS NOTHING INTERNAL.**
`/track/<token>` (20 random characters per bill) shows the bill, the LR and
the shared steps — never call notes, problem notes, prices or staff names,
because a WhatsApp link gets forwarded.

**TRANSPORT EXPENSES REPLACED TRIPS & FREIGHT AND PAID FREIGHT (Nov 2026).**
Logistics → Transport expenses (`?view=freight`; `trips` and `paidFreight`
redirect there) is the Transportation Expense PRD: a transporter's bill
(`erp_freight_bills`, `TB-<n>`, 0331) names the vehicle and the day it left,
and every order line dispatch-verified onto it that day is offered
(`erp_order_details.transport_id` → `erp_transports.vehicle_no`). Only PAID
freight is counted (`coalesce(payment_type, customers.freight_term)`); To Pay
and TBB are shown and greyed. The bill is split over the ticked ORDER LINES by
litres with `allocateByLitres`, written to `erp_freight_bill_lines` on save —
one live share per order line (a partial unique index) — and `detailRows`
reads it (`freightSharesFor`), so it reaches the line's costing, margin and
the Founder's Margins desk with nobody typing it; a sheet-costed line shows it
and does not add it again. The screen is three stages — Bill to enter, To pay,
Paid — each grouped by transporter, and work is done on a SELECTION: ticked
trips are entered together (`saveFreightBills`, each row its own save, so one
refused row never stops the others) and ticked bills are paid together, one
payment per transporter (`markFreightBillsPaid`, one transaction — a selection
is paid whole or not at all). Entering never pays: Mahek asked for the two to
stay apart, so there is no "save and pay". `ListScreen`'s `onBulk` hands the
selection to the screen's own dialogs. Only an ERP manager undoes a payment,
with a reason, and the split stays. A corrected dispatch makes a pending split
stale (`staleShares`); the row cannot be ticked to pay, and the bill shows the
old and the new split side by side until the new one is saved. Nothing here posts to Petty Cash/Bank.
Rules: `engines/freight-bill.ts`; reads and writes: `lib/erp/freight-bills.ts`;
screen: `app/erp/transport/parts/freight.tsx`. `erp_trips` still groups bills
by vehicle at dispatch; its payment tables are read by no screen.
