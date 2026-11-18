# Lead capture fields, visit links, media binding, lead seats

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**A LEAD'S CONSUMPTION IS IN LITRES, and it is the one place cans do not win.**
Every other quantity in MahekOne is cans, because cans are what the customer
says when ordering and litres are derived from the SKU's own packing. There is
no SKU at capture: a prospect says "about two hundred litres a month" long
before anybody knows what pack they will buy it in, so cans would be a unit
nobody has agreed the size of. `lead_monthly_volume_litres` is that number, and
`lead_requirement` is what they want in their own words — free text rather than
a product id, because resolving "thinner for a spray booth" to a SKU at capture
is the salesman guessing on the customer's behalf.

**GST IS ASKED AT THE QUALIFY TRANSITION, and never on the column.** Making a
prospect real means we could invoice them, and that is what the number is for —
so `handleLead` refuses `stage = 'qualified'` without one, reading what is
already stored as well as what arrived so a lead given its number last week
qualifies today without retyping. NOT NULL on `customers.gstin` would refuse the
entire imported book: 5,292 shops came from the EMP 2.0 master with no GSTIN
between them. The constraint belongs on the moment somebody asserts this is a
business we can bill, not on the record.

**A VISIT IS LINKED TO ITS ORDER AND RECEIPT WHICHEVER ARRIVES FIRST.** The
handset mints the visit id at the shop door and stamps it on what is taken
inside, and those records usually reach the office before the visit, which is
saved on the way out. `orders.visit_id` and `payment_receipts.visit_id` keep
it — plain text, not a key, or the order would be refused for arriving first —
and `handleVisit` back-fills `linked_order_id`/`linked_payment_id` from them.
Both sides only fill an EMPTY link, so the earliest wins and a retry cannot
move it. It is matched on the salesman, not the customer: an order at a
third-party shop is billed to its distributor.

**A PHOTOGRAPH IS BOUND WHEN ITS PARENT IS WRITTEN, by `bindMbosMedia`.** Media
syncs AFTER its parent — that is the whole point of a separate queue — so the
handset uploads naming `parentId: 'pending'`, because at the moment the camera
closed the record did not exist. Something has to go back and say what it was,
and nothing did: the attachment kept the literal string `pending` for ever, so
`canRead` looked for a record with that id and refused the file to everybody.
It is called after the record is safe and cannot fail the write — a lead is
never lost to a photograph.

**EVERY HANDLER THAT NAMES A FILE BINDS IT, not just the lead's.** For a long
time only leads and expenses did, so a visit's shop photo and voice note, a
cheque, a sample's delivery proof, a task's completion photo, an odometer
reading and every attendance selfie that went up before its record existed sat
under `pending` for ever — readable by nobody, the salesman included. Each
handler now binds what its payload names, and `storeMbosMedia` re-parents a
`pending` row when the same file is sent again naming its real record.

**A LEAD HAS TWO SEATS, and only one of them is the book.** The office asks that
the sales manager over a salesman picks up a lead once it is qualified, while
the salesman goes on making the visits — two people on one record, so two
columns. `customers.lead_manager_id` is the coordinating seat. It is read by
`scopedToUsers` and by `assertCustomerInScope`, which answer who may SEE and
WORK a record; it is deliberately NOT read by `ASSIGNED_TO_SQL`, which answers
whose book it is. Moving the owner instead would have been the obvious
implementation and it takes the lead off the handset of the person who was just
told to keep visiting the shop — a lead's owner IS its MBOS scope. It is the
same split `back_office_am_id` already lives under, with the same consequence:
one record legitimately appears on two lists. `lead_manager_decided_at` is the
usual mark that a person chose, so an override survives the next org-chart pass.
