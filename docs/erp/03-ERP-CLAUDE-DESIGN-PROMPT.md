# Prompt for Claude Design — MahekOne ERP (web)

> Copy everything below the line into Claude Design. It describes **what** must
> be on each screen and **how the product behaves**. It deliberately says
> nothing about visual style, layout, colour, typography, components or
> branding. Those decisions belong to Claude Design.

---

## Brief

Design the complete web application **"ERP"** for Mahek Marketing India, a
paint-thinner and solvent manufacturer. It runs their purchasing, quality
testing, raw-material stock, batch production, filling, packing, stock
transfers, re-ordering, sales-order fulfilment, dispatch, transport tracking,
customer complaints and credit notes, repeat-order follow-up and petty-cash
expenses, across several godowns (e.g. Bhiwandi, Ambernath).

The ERP is one app inside a suite called **MahekOne**. People sign in once to
MahekOne and open the ERP from its app launcher. A mobile version will follow
later, so every screen must also make sense at tablet and phone width. Godown
and dispatch staff often work on a tablet at the godown.

Please produce designs for **every screen listed below**, including list,
record, create/edit form, bulk-action, confirmation, prompt, empty, loading,
error and permission-restricted states. The field-level rules are in the
companion documents `01-ERP-PRD.md` and `02-ERP-FUNCTIONAL-SPEC.md`. This brief
is self-sufficient for designing, but those documents are the reference for
exact field lists.

### Who uses it

| Person | Main jobs |
|---|---|
| Owner / CEO | Verifies quality tests, verifies purchases, writes off lost stock, decides customer requests, reads the dashboard |
| Admin | Sees all costs and margins, approves orders from pending customers, activates customers, manages access |
| Office / accounts | Enters Tally bill numbers and rates, verifies dispatches, enters freight expenses, sees amounts |
| Purchase / store staff | Requisitions, goods inward, purchase register, drum label export |
| Quality tester | Records tests with photos, a video and readings |
| Production staff | SFG batches, FG filling, FG packing |
| Godown / dispatch staff | Scans lot codes onto orders, marks orders ready, prints labels, transfers stock |
| Order desk | Enters and manages sales orders |
| Logistics | LR numbers, consignment stage, reminder calls |
| Sales person | Raises complaints and credit-note requests, maintains their own customers |
| Every employee | Petty-cash expenses, help videos |

### Access rules the design must express

- A person sees only the **modules and screens granted** to them. The
  navigation, the dashboard tiles and the links must never lead somewhere they
  cannot open.
- Some **fields are hidden** unless the person holds a power: purchase money,
  cost/margin, sales rate, sales amounts. The same screen must read correctly
  with those fields present and with them absent.
- Some **actions appear only** for certain people or record states (e.g. only
  the CEO sees "Verify" on a quality test). When an action is not available,
  decide whether to hide it or show it disabled with the reason. Where the spec
  gives a reason (e.g. "allocation not complete"), that reason must be
  readable.
- Every user has a **working location** (godown). It pre-fills forms and scopes
  some lists. It must always be visible and changeable.

### Global behaviours to design for

- **Search, filter, sort, group** on every list. Many lists are grouped (by
  godown, date, status, PR number, order number, transporter) with a group
  total or count. Show the groups and their aggregate.
- **Bulk selection and bulk actions** on lists (e.g. mark many orders Ready;
  "Select all lines of this PR / order / batch").
- **"Add more" / copy-as-new-line:** many documents are multi-line (a PR, an
  SFG batch, a packing batch, a sales order). The user fills the first line
  and then adds lines that inherit the header (number, date, godown, product).
  Make it clear which lines belong to one document and how to add another.
- **Derived fields** (calculated, read-only) appear next to input fields
  everywhere. Their read-only nature must be clear.
- **Conditional fields** appear only when relevant (e.g. drum fields only for
  chemicals, test evidence fields only for the tests the item requires).
- **Validation messages** from the source are specific and must be shown at
  the field they concern: "Low Stock!", "Low SFG Stock", "Minus Quantity Not
  Allowed", "Low Packing Quantity", "Select Correct Quantity!", "You Selected
  The Same Location, Change To Location", "Duplicate Entry!", "INVALID",
  "Invalid Quantity Or Wait For Synchronization", "You Cant Select More Than
  {n} Can", "! Please Change 4 Digit PR Num Manually or Generate New PR Num!".
- **Confirmations** with the source's wording, e.g. "Transfer {item} {qty}",
  "Are You Sure! This Party Is Verified By Admin".
- **Prompts** that ask for one or more values before an action (dispatch
  date; extra expenses; credit-note amount, date, number, remark and file;
  remark and responsible employee; purchase status).
- **Flags / states** on rows and fields. Each is a named condition that must be
  distinguishable at a glance: empty purchase rate, incomplete packing batch,
  deleted-source inventory entry, inactive employee, order under process,
  order ready but short of allocated stock, order ready and fully allocated,
  missing Tally bill no or rate, rate present, not dispatch-verified, sales
  target reached, transferred today, lost-stock godown or transfer,
  requisition "Order Placed" and "Booked", request Accepted / Rejected /
  Requested.
- **Barcode scanning** into lot-code fields (scanner or camera).
- **Media:** capture or upload photos and video, view them in the record, play
  help videos (YouTube or uploaded) inside the app, open PDF credit notes.
- **Contact actions** on phone and email fields (call, message, email) and map
  links on addresses and coordinates.
- **Export** of the list as shown (CSV) where marked.
- **Record headers** show the fields the spec names (e.g. an order shows the
  delivery party and standing instructions; an inward line shows drums, item
  and quantity).
- Every record shows who created it and when.

---

## Screens to design

### 0. App frame
- Navigation between modules and the screens inside each, showing only granted
  items. Module groups: Dashboard, Masters, Purchase, Raw-Material Inventory,
  Semi-Finished, Finished Goods, FG Packing, Item Transfer, Re-Order, Sales
  Orders, Order Details, Logistics, Customer Requests & Credit Notes, Order
  Follow-up, Expenses, My Customers, Help Videos, Settings.
- The current user and their working location, with a way to change location.
- Global search across ERP records.
- The way back to the MahekOne launcher and other apps.

### 1. ERP Dashboard (home)
One page summarising the business. Every figure opens its filtered list. A
godown filter (default = working location, or All) applies to stock and
godown-scoped figures. Tiles a person cannot access are absent. Money figures
appear only for holders of the matching power. Sections and figures:
- **Purchase:** requisitions by status; urgent open requisitions; inward lines
  awaiting routing; tests awaiting verification; purchases with missing rate;
  bills not received; purchases by status; purchase value this month.
- **Stock:** for each stage (raw material in litres/pcs, SFG in litres, FG in
  cans, packing in boxes): number of lots in stock and total quantity; stock
  value per stage; orphaned inventory entries; incomplete packing batches.
- **Re-order:** raw items to re-order; finished goods below minimum (counts
  plus the top items).
- **Production:** today and this month: SFG batches and litres, FG fills and
  cans, packing batches and boxes.
- **Transfers:** transfers today; quantity written off to "Item Lost Record"
  this month.
- **Sales orders:** orders by status (Under Process, Ready, Today, Tomorrow,
  Delay, Hold From Office, Cancel); ready but short of allocation; ready and
  awaiting "Done"; missing bill no or rate; orders from pending customers
  awaiting admin approval; labels to print.
- **Dispatch & billing:** awaiting dispatch verification; dispatched today and
  this month; sales value this month; margin this month; paid-freight lines
  without extra expense.
- **Logistics:** pending LR; consignments by material stage; reminder calls due
  today or overdue.
- **Customer requests:** by status; credit notes to issue; credit notes pending
  sync to order lines; average response time this month.
- **Order follow-up:** calls due today, overdue, and in the next 7 days.
- **Expenses:** petty-cash balance per godown × mode; expenses pending
  verification.
- **Customers:** customers pending activation; for a sales person, their
  customers' monthly sale against monthly target.
Design the empty state (a new installation with no data) and a state where the
viewer can see only one or two sections.

### 2. Masters
For each: list, record and form.
- **Raw Materials:** serial no, item, code, unit, material type, density and
  testing list (only for Chemical; required then), price, remark, total stock.
- **Purchase Parties (suppliers):** name, own party code, area, location,
  state, credit days, mobile, WhatsApp, broker, grade, email, and the
  supplier's purchases. The list is grouped by state; call is the quick action.
- **Products:** product id, SFG (liquid) name, FG product name, packing item
  (can/drum), litres per can, description of goods (SKU), cans per box, empty
  boxes required, box type, rate, weight. "Add more item" copies a row.
- **Sales Parties (customers):** all fields in the spec, including status
  Active / Deactive / Pending with confirmed status actions, tagged sales person,
  tagged price list, credit days, and the customer's orders and requests.
- **Godowns:** city, godown name, address with map, phone, GSTIN, email,
  assigned employees, status (quick toggle), remark, map pin. The reserved
  "Item Lost Record" godown is flagged.
- **Price Lists:** grouped by price-list name. Product, rate incl. GST, rate
  excl. GST (derived), discount, zone. "Add more" copies a row.
- **Employees** (admin only): directory grouped by status, with an
  inactive flag, the personal/bank/statutory/target/leave fields, the legacy
  Permissions and Ux Permission values (read-only), and "Manage ERP access".
- **Reference lists:** a screen to maintain the editable value lists (material
  types, areas, states, transporters, segments, counter types, complaint types,
  expense categories and particulars, price-list names, zones, testing list,
  search tags, short label names).

### 3. Purchase
- **Purchase Requisitions:** list grouped by status (flags for Order Placed
  and Booked). Form: date, godown (pre-filled), material type (Chemical, Can,
  Box, Stationary, Finish Good), item (list depends on type), present quantity
  at the godown (derived, or "no level set"), unit (depends on type), required
  quantity, priority (Urgent / Medium / For Stock), status, remarks. Status is
  changeable directly on the record.
- **Purchase Inward:** list grouped by PR number. Form: PR number (auto),
  date, supplier, material type (Chemical / Can / Box), item, drums and weight
  with drum (chemicals only), quantity, unit, godown, remark, "Testing
  required" (derived). Row actions: **Send to Testing** or **Send to Purchase**
  (only the one that applies, once), Add more (same PR), Select PR.
- **Purchase Testing:** list grouped by verification status then date. The
  record/form shows the tests the item requires, and **only** the evidence
  inputs for those tests: pH photo, smell (Good / Moderate / Bad), colour photo,
  oil-paint, fast-paint, NC-paint and primer photos, density value and photo,
  thermocol-pass photo, test video, tester, testing date, remark, godown.
  Verification status is prominent. **Do Verify** (CEO only; also creates the
  purchase register row) and **Do Not Verified**, including the warning when a
  register row already exists. "Add more lot."
- **Purchase Register:** list grouped by date and PR number with the average
  bill total. The record shows: lot number (derived; collision error), party
  and party code, item and code, quantity and unit, rate, density, drums, litre
  conversion, feed-adjusted litres, available litres, GST, sub total, GST
  amount, amount + GST, feed-adjusted amount, final amount, bill total for the
  PR, company, status, bill received, bill number, notes, godown, short label
  name, litres per drum, and its inventory posting state ("Posted" or "Not
  posted: rate missing", with retry). Actions: Bill Received / Not Received,
  Change Status (prompt with allowed values), Do Pending (admin), Add more,
  Select Purchase, Download. Design both the with-money and without-money
  versions.
- **Purchase Barcode:** read-only list of chemical lots at the working godown,
  with Download for label printing.

### 4. Raw-Material Inventory
- **Available stock:** one row per lot × godown with stock > 0: item, current
  stock, lot no, godown, entry id (and rate/value for cost holders). Grouped by
  godown.
- **Inventory log:** every entry (Purchase or Transfer), newest first, with the
  deleted-source flag. No manual add.

### 5. Semi-Finished (SFG)
- **SFG batches:** list grouped by godown, date, SFG No, with total litres
  used. The batch form is multi-line: header (date, SFG No, godown, SFG product,
  number of batches), then one line per raw-material lot: item (only items
  with stock at this godown, excluding cans), lot (only lots with stock),
  quantity available, quantity per batch, total use (derived, validated
  "Low Stock!"), litres adjusted, available SFG litres, lot code (derived from
  the first lot), and for cost holders the purchase rate, costing and batch
  SFG rate. "Add more SFG" adds a line. Posting state per line.
- **Available SFG stock** (with Download) and **SFG log**, as for raw materials,
  plus batch size, number of batches, SFG rate and stock value.

### 6. Finished Goods (filling)
- **FG filling:** list grouped by godown and date. Form: date, FG Num, godown,
  SFG product and lot (only those with stock), SFG litres available, FG product
  (only those made from this SFG), can size and packing item (pre-filled),
  packing material available, **number of cans/drums**, litres used (derived),
  can adjusted, cans available, finished lot code (derived), packing type
  (Can / Drum / Naket), packing rate, FG costing (cost holders). The three
  validation messages. Posting state.
- **Available FG stock** and **FG log** (lot, product, SKU, packing type, can
  use, stock in cans, rate and value for cost holders).

### 7. FG Packing
- **Packing batches:** list grouped by godown and date. The form is
  multi-line: header (date, godown, FG product, boxed SKU, number of boxes for
  the whole batch), then one line per FG lot used: lot (only those with stock),
  FG available, cans from this lot, and remaining cans for the batch. The batch
  must be visibly **complete / incomplete** ("Match" / "Not Match"). Batch no,
  total cans, box type, empty boxes required, box amount and packing costing
  (cost holders) are shown. It posts only when complete. "Add more", "Select
  batch".
- **Available packing stock** (grouped by SKU with total boxes) and
  **packing log**.

### 8. Item Transfer
- List grouped by date and source godown. Flags for today's transfers and
  lost-stock transfers. Download.
- Progressive form: date → item type (Purchase / Semi Finished / Finish Goods /
  FG Packing) → from godown → item (only items with stock there) → lot (only lots
  with stock) → available quantity → transfer quantity (validated) → to godown
  (excluding the source; "Item Lost Record" only for the lost-stock power) →
  remark. Confirmation "Transfer {item} {qty}".

### 9. Re-Order
- **RM levels:** list grouped by godown and material type, sorted by re-order
  %. Form: godown, material type, item (only un-levelled items; duplicate
  error), min, max, Follow / Unfollow. It shows available, re-order % and
  required quantity. "Add more."
- **FG levels:** godown, SKU (duplicate error), minimum, Follow / Unfollow,
  product type (loose → FG stock, boxed → packing stock), available, re-order %.
- **Re-order raw items** and **Re-order finished goods**: the actionable lists.

### 10. Sales Orders
- **Taken orders:** list grouped by order number with total labels. Flags: under
  process, ready + allocation short, ready + allocated, bill no / rate missing,
  rate present.
- **Order form** (multi-line order): date, godown, billing party, delivery party
  (defaults to billing), area, transporter, standing instructions (derived:
  instructions – delivery type – payment type – weight type), then per line: SKU,
  quantity in cans, box quantity (derived; must be whole), status (Under
  Process, Ready, Today, Delay, Cancel, Tomorrow, Hold From Office), remark,
  number of labels. "Add more" adds the next SKU to the same order.
- **Order record:** everything above plus rate and discount (pre-filled from the
  customer's price list; power-restricted), live price-list rate, Tally bill no,
  transport cost, entry status (Done / Not Done), party status (Pending /
  Approved By Admin), type (Can / Box / Drum), weight, **allocation status**
  (Done / Add More Quantity / Remove Some Quantity) with the allocated lots
  listed, and the order-details line once created.
- **Order actions** with their availability conditions: Ready, Under Process,
  Done, Not Done, Approved By Admin, Generate New Order Number, Select order,
  **Add To Order Details** (enabled only when Ready + bill no + rate + Done +
  allocation Done, and when it is not, which of these is missing).
- **Pending orders** and **Under process / Ready** lists, with bulk actions.
- **Lot allocation (Batch Code):** from an order line, add allocations. The
  form shows SKU, source (FG stock for loose SKUs, packing stock for boxed),
  required quantity remaining (in cans or boxes, labelled accordingly), **lot
  code (scan or pick)**, available in that lot, quantity (defaults to
  required), and per-lot remaining. Error "Invalid Quantity Or Wait For
  Synchronization". Design the repeated scanning flow of allocating several lots
  in a row until the order line reads Done.
- **Batch codes** list (all allocations, grouped by godown).
- **Sales label printing:** open orders grouped by transporter with total
  labels, and Download.

### 11. Order Details (billing & dispatch)
- List grouped by order date and order number with the average bill total.
  Flag: not verified; sales target reached.
- **Record:** order data (read from the order), litres dispatched, type, GST
  (18% / 0%), amount, discount amount, final amount, bill total, company
  (Mahek Marketing India / Mylac), dispatch status, dispatch date, fulfilment
  days, credit days, due date, customer payment / delivery / weight type,
  segment, sales man, monthly target, monthly sale, month, transport follow-up
  link, extra expenses, credit-note amount, and for cost holders lot costing,
  cost per can and margin.
- Actions: **Do Verified** (prompt for dispatch date; available only when lots
  are allocated and the allocation is Done), Extra Expenses (prompt), Credit
  Note Updater, Select order number.

### 12. Logistics
- **All transport:** grouped by bill date. Record: order no, bill date, party,
  bill no, **LR no**, transporter, area, payment type, extra expense (Paid
  only), track status, **material stage** (Dispatch from Bhiwandi, Dispatch from
  Ambernath, In Transit, On the way to Destination area, Reached Destination
  Area, Close – Received to Party), reminder-call date, note, sales people,
  tagged sales man, monthly sales.
- **Pending LR** (quick LR entry), **Track LR** (updating stage and reminder
  date quickly), **Transportation Paid** (order lines awaiting extra expense,
  grouped by transporter with the total).

### 13. Customer Requests & Credit Notes
- **Raise request** form: salesman (pre-filled for sales people), customer,
  location and mobile (derived), complaint type, description, photo, credit note
  required (Yes / No). If Yes: bill number (suggested from the customer's
  bills), bill date, goods on that bill, and the CN amount with GST (derived).
  Decision fields are not shown while raising.
- **Customer requests** (grouped by status, with the three status flags).
  **Issue credit note** (CN = Yes). **Customer complaints** (CN = No, grouped by
  type). **Pending CN** (order lines whose credit-note amount is out of sync,
  with the updater action).
- **Record and decisions:** Accept / Reject (power-restricted, stamped);
  **Issue credit note** prompt (amount, date, number, remark, file upload);
  **Resolve complaint** prompt (remark, responsible employee); approval and
  resolution times and response duration; **Add more credit** (opens a new
  request pre-filled from this one).

### 14. Order Follow-up
- List sorted by order date: party, FG product, order number, cans, previous
  order (party-wise and product-wise), day gaps, average order interval, **next
  upcoming order**, reminder days (editable), **calling date**, remark.
  Filters for calls due today, overdue, and the next 7 days.
- **Party order pivot** report: per party, last order date and gap in days.

### 15. Expenses
- **Credit (funds given):** date, godown, employee, mode (Bank Cash / Cash /
  Other), amount, credit note (reference), available balance. Grouped by godown
  and mode.
- **Expenses:** date, godown, expense by, category, mode, particular, amount,
  note, status (Pending / Verify, changeable in place), available balance.
  Grouped by godown and mode. The balance for the chosen person × godown × mode
  must be visible **while entering** an expense.

### 16. My Customers
The sales person's own customers, editable in place (grade, area, location,
state, transporter, payment / delivery / weight type, contacts, email, counter
type, monthly target, credit days), plus each customer's requests.

### 17. Help Videos
Library newest first with search by title and tag. Record: title, player
(YouTube or uploaded file), description, tags. Add form with source choice
(YouTube URL / file upload) showing only the relevant input.

### 18. Settings
Working location (only godowns the user is assigned to), name, position.

---

## End-to-end flows to storyboard

1. **Chemical purchase:** requisition → inward (PR 1234, 2 lines) → one line
   sent to testing, one to register → tester records evidence → CEO verifies →
   register row appears → office enters rate → stock appears in available RM
   stock with its lot number.
2. **Production:** SFG batch consuming two RM lots → FG filling of 1 L cans
   from that SFG lot → packing of 32 cans per box across two FG lots until the
   batch reads complete → packing stock appears.
3. **Order to dispatch:** order with two SKUs (one loose, one boxed) → scan lots
   until allocation reads Done → Ready → Done → office enters Tally bill no and
   rate → Add To Order Details → Do Verified with dispatch date → transport
   record → LR entered → tracked to "Close – Received to Party".
4. **Credit note:** sales person raises a complaint with CN required → admin
   accepts → issues CN with file → the order line shows up in Pending CN →
   updater syncs → margin reflects the CN.
5. **Transfer and loss:** transfer SFG from Bhiwandi to Ambernath; CEO writes 5
   cans off to Item Lost Record.
6. **Re-order:** an item falls below level → appears in re-order list and on
   the dashboard → a requisition is raised with present quantity shown.
7. **Petty cash:** credit ₹5,000 cash to an employee at a godown → the employee
   records expenses and sees the balance drop → the manager marks them Verify.

## Deliverables

Designs for every screen and state above, at desktop, tablet and phone width,
plus the storyboards for the seven flows. Name each screen with the module and
screen names used here so that each design maps to the functional spec.
