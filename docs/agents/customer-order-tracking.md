# Customer order tracking

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**ONE LINK PER ORDER, FROM CONFIRMATION TO DELIVERY** (the Customer Order
Tracking PRD). `/t/<token>` is the customer's page — no sign-in, sections in the
PRD's order: header, hold notice, current status, products, journey, documents.
It replaced the consignment link (`/track/<token>`), which now redirects to its
order's page. Rules are pure in `lib/erp/engines/order-tracking.ts`; the wiring
is `lib/erp/order-tracking.ts`; the staff side is the order record's
**Customer tracking** tab (`_ui/panels/order-tracking.tsx`).

**A STEP IS A FACT SOMEBODY ALREADY RECORDED, never typed.** `deriveSteps`
reads the order and its consignments: confirmed = every live line verified by
the back office and no party waiting on Accounts; preparing = the same moment
(verification is what hands it to production — the floor has no per-order
"started" mark); ready = every live line Ready; invoice = billed and the check
approved (never while rejected); dispatched; then Logistics' own steps. The two
optional transport steps (destination office, out for delivery) are ticked only
when reported, and named in a line when they were not. `lr` is a document, not a
stage. Only `source = 'erp'` lines are tracked.

**EACH STEP IS WRITTEN ONCE, AND WITHDRAWN RATHER THAN DELETED.**
`erp_order_milestones` keeps one LIVE row per order per step (partial unique
index). `syncOrderTracking` writes what became true and withdraws what stopped
being true (verification undone, billing undone, a delivery reopened). It rides
on `syncBookOrders` — which every Orders and Logistics write already calls,
before the live switch — plus verify, invoice approval, party approval and
`afterDispatchFor`, and hourly as `order-tracking-sync`. It never throws: tracking
must not fail the write behind it.

**MESSAGES GO ONCE, AND ONLY FOR FRESH STEPS.** Confirmed, invoice and dispatched
(and holds) write a WhatsApp into `erp_transport_messages` with `order_no` set —
not `wa_messages`, because a lorry update is not contact. A second message of the
same kind for the order is never written. A step first seen more than six hours
after it happened is recorded quietly, and a link made for an order already under
way is `backfilled` and sends nothing automatically (`order-tracking-backfill`
for deploy day). Wati is used where the founder's switch, a key and
`erp.tracking.watiTemplate` all hold; otherwise the message waits to be sent by
hand, on the order's tab and on Logistics → Customer messages. `erp.tracking.notify`
says which kinds go. Logistics' LR, stage, problem and delivered messages are its
own and now carry the order's link.

**A DELIVERY PARTY THAT IS NOT THE BILLING PARTY GETS ITS OWN LINK** —
`delivery_token`, a view without the invoice. A third-party shop must never see
its distributor's prices. Old consignment links, which went to both parties,
open the delivery view where the two differ. Regenerating a link (an ERP
manager) revokes the row and retires every older consignment link with it.

**A HOLD IS THE ORDER'S, AND IT SAYS WHY IN TWO VOICES.** `erp_order_holds`:
a reason code from `HOLD_REASONS`, the sentence the customer reads (filled from
the reason, `erp.tracking.holdMessages` rewords it, staff may shorten it, "Other"
is written by hand), and an internal note no customer surface ever reads. "Put
order on hold" replaced the bare Hold From Office action: every live undispatched
line goes on hold and its status is remembered; resolving puts them back (Ready
only where the stock still is). Moving the last held line off hold by hand closes
the hold; dispatch closes a forgotten one. A delay after dispatch comes from
Logistics' "Report a problem" with a customer reason (Delayed and Held at
transport default to Transporter delay; empty keeps it internal), and clears with
the problem or the delivery. One open hold per order, both ends kept.

**THE INVOICE PDF IS THE TALLY PDF, UPLOADED.** MahekOne does not make its own
copy of a tax invoice. It is attached on Bill it or later (Invoice PDF), parent
`erp_invoice` with the order number as id; the customer opens it only once the
invoice step is recorded, only on the billing party's link, and only while
`erp.tracking.showInvoice` is on. Replacing it on an approved invoice sends the
invoice back to the checker. Documents are served by `/t/<token>/doc/<kind>`,
never `/api/attachments`.

**AND THE TEAM SEES AND PRINTS IT, AND THE CHECKER CANNOT APPROVE WITHOUT IT.**
Before this nothing showed an uploaded invoice to staff — `erp_invoice` was not
an ERP attachment parent, so `/api/attachments` refused it to everybody.
It is read under the Orders screen now: everybody who holds Orders. Every
billed order's heading on Invoice check, All lines and Billing & dispatch
carries a view and a print button, or a red Add PDF where none is attached
(`ListSpec.groupInvoice`, `y:`/`n:<order>` on the row, drawn by
`_ui/invoice-buttons.tsx`). The record has an Invoice tab (`orderInvoice`
panel, `ListRow.panels` for a second panel tab): the PDF beside the order's
lines and its transporter, Print, Download, Open and Replace, and every upload.
On Invoice check it is the first tab. `approveInvoice` is refused — and drawn
locked — until a PDF is attached (`invoiceFileFor`); tests attach one with
`invoice-fixture.ts`. `/api/erp/invoices?orders=` joins the orders' files
into ONE PDF (pdf-lib; a photographed invoice becomes an A4 page; an invoice
shared by several orders prints once), each read through `canRead`.

**THE INVOICE IS SHOWN AND PRINTED BY OUR OWN VIEWER, IN A POP-UP — never
Chrome's, never a new tab.** `_ui/pdf-render.ts` reads the PDF with the pdf.js
copy unpdf ships and paints each page on a canvas we own; `_ui/pdf-viewer.tsx`
is the viewer (thumbnails, page, zoom, fit). The order heading's view and print
buttons open `InvoiceModal` (print prints once the pages are read); "Print
invoices" on a selection is a `BulkSpec` with `client: "printInvoices"`, which
the list opens as `PrintInvoicesModal` instead of calling the server; the
Invoice tab embeds the same viewer. Printing renders every page to an image
and prints those from a hidden frame, `copies` times (1 unless changed, up to
`INVOICE_COPIES_MAX`). There is no download or open-in-tab control anywhere;
the browser's own print dialog still offers "Save as PDF", which no page can
remove. The PDF's own addresses (`/api/erp/invoices`, and `/api/attachments`
for an `erp_invoice`) answer a fetch from our pages and refuse one typed into
the address bar or loaded as a frame (`isOpenedDirectly` in
`lib/fetch-only.ts`, read off the browser's Fetch Metadata headers; a request
with none is let through). `/erp/print-invoices` only redirects to Billing & dispatch now.
The transporter is a column of Invoice check.

**"OUT FOR DELIVERY" IS A LOGISTICS STAGE** (0292 widened the stage check). The
order flow reads it as Delivery Pending Confirmation, like the destination office.
No expected delivery is shown before dispatch, and nothing implies live GPS.

**AN LR HAS A ROUTE, TOLD AS IT IS REPORTED** (0296). The Update LR dialog takes
the godown the transporter dispatched it from, every city it has reached since
the last call — each its own `checkpoint` event with `city`, dated the day it got
there, so a week caught up in one call still reads as a week — the destination
city (empty falls back to the LR's own), and the last mile, which goes one of two
ways: Out for Delivery, or **Ready for Pickup** with where the party collects it
and whom to ask. `current_city` is the newest place any event named, never typed
twice. A new city is news and is told like a stage that moved. Pickup and
delivery are alternatives, not steps: the strip draws them as one rung, the
customer's journey never waits on pickup or names it unreported, and once pickup
happens out-for-delivery is not waited on either. "Dispatched from godown" is not
a stage — it saves In Transit plus the godown, and a corrected godown replaces
the old start on the route rather than adding a second.
