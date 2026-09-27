# MahekOne ERP — Product Requirements Document

| | |
|---|---|
| Product | **ERP**, a new app inside MahekOne (web first; a mobile app follows later on the same backend) |
| Source of truth for scope | *Mahek One ERP Application Documentation* (the client's AppSheet export of "Mahek Plus", version 1.002491, generated 20 Aug 2026, 952 pages: 44 tables, 928 columns, 17 slices, 131 views, 19 format rules, 188 actions, plus automation bots) |
| Companion documents | `02-ERP-FUNCTIONAL-SPEC.md` (every field, formula, rule and action) · `03-ERP-CLAUDE-DESIGN-PROMPT.md` (brief for the screen designs) |
| Status | Draft for build |

---

## 1. Purpose

Mahek Marketing India runs its factory, godowns, purchasing and order fulfilment on
an AppSheet app called **Mahek Plus**, backed by a dozen Google Sheets. The
client has asked for that application to be rebuilt as the **ERP** app of
MahekOne, with **every feature it has today**, working end to end on the web,
plus an **ERP dashboard** (the AppSheet app has no real dashboard, only menu
groupings of lists).

The ERP covers the whole physical flow of the business:

```
Purchase requisition → Goods inward → Quality test → Purchase register
      → Raw-material stock → Semi-finished production (batching)
      → Finished-goods filling (cans / drums) → FG packing (boxes)
      → Sales order → Lot allocation (batch codes) → Ready → Order details
      → Dispatch verification → Transport follow-up (LR tracking)
      → Order follow-up (repeat-order prediction)
Side flows: stock transfers between godowns · lost-stock record · re-order levels
            · customer complaints & credit notes · petty-cash expenses
            · masters · training videos
```

### 1.1 What "done" means

1. Every table, field, calculation, validation, list, filter, status, action,
   automation and permission in the source document has a working equivalent in
   the ERP. The functional spec maps them one by one.
2. A user who works in Mahek Plus today can do the same job in the ERP without
   losing a field, a check or a report.
3. The ERP has a home dashboard summarising the state of the business across
   all modules.
4. The data model and the business logic are built so that the later mobile
   app can use the same APIs without a rewrite.

### 1.2 Scope rule

**The ERP builds what the source document contains. Nothing else is in scope.**
A capability that is not in the source is added only when one of the source's
own features cannot work on the web without it. Every such addition is listed
in §9 with the source feature it serves. Anything the client wants beyond that
is a separate request.

**Approved extension:** eight AI features (AI-1 to AI-8) have been approved on
top of this scope. They are specified in `04-ERP-AI-FEATURES-PRD.md`. The base
ERP works fully without them.

---

## 2. Users and roles

### 2.1 Who uses it (as evidenced by the source)

| Persona | What they do in the source app |
|---|---|
| **Owner / CEO** | The only person who can verify a purchase quality test, set a purchase to "Purchase Verified", and use the "Item Lost Record" godown. Accepts or rejects customer requests. |
| **Admin** | Sees every rate, cost and margin. Reopens verified purchases ("Do Pending"), approves orders from pending customers ("Approved By Admin"), activates or deactivates customers, decides customer requests, assigns employee permissions. Manages the employee directory. |
| **Office / accounts user** | Sees purchase amounts and order amounts, enters Tally bill numbers, activates or deactivates customers, verifies dispatches, enters extra transport expenses. |
| **Purchase / store staff** | Raise purchase requisitions, record goods inward, enter purchase register rows, print drum barcodes. |
| **Quality tester** | Records purchase tests with photographs, a video and readings. |
| **Production staff** | Record SFG batches, FG filling, FG packing, and post them to stock. |
| **Godown / dispatch staff** | Allocate lot codes to orders (scanning), mark orders ready, print sales labels, transfer stock between godowns. |
| **Order-desk staff** | Enter taken orders, manage their status, move ready orders to order details. |
| **Logistics staff** | Enter LR numbers, track consignments, set material stage and reminder calls. |
| **Sales person** | Raises customer complaints and credit-note requests. Edits the details of the customers tagged to them. |
| **Any employee** | Records expenses against their petty-cash credit, and watches help videos. |

### 2.2 Access model

The source controls access in three layers. The ERP keeps all three.

1. **Sign-in.** In the source, a user types an Employee ID and a password into a
   settings form and picks a working location. In the ERP this becomes the
   MahekOne sign-in plus a **working-location** selector (§5.2).
2. **Screen permissions.** Each employee carries a list of permitted screens
   (`Employee Details → Permissions`), and every menu item checks it. In the ERP
   this becomes **ERP module access** per person (§5.3). The source's
   permission names are carried over one for one (listed in the functional spec).
3. **Special powers.** These are hard-coded in the source against an admin role
   and three specific email addresses. The ERP turns them into named
   **capabilities** granted to people (§5.4). No email address is hard-coded.

---

## 3. Modules

These are the ERP's modules. Each one is a navigable area and a unit of access.

| # | Module | Source equivalent | Summary |
|---|---|---|---|
| M01 | **ERP Dashboard** (Home) | *(new, requested)* | One-page operational summary across every module (§6) |
| M02 | **Masters** | Master Dashboard | Raw materials, suppliers (purchase parties), products, customers (sales parties), godowns, price lists, employees |
| M03 | **Purchase** | Purchase Dashboard | Purchase requisitions, purchase inward, purchase testing (QC), purchase register, purchase barcode labels |
| M04 | **Raw-Material Inventory** | Purchase Inventory Dashboard | Available raw-material stock by lot and godown, and the movement log |
| M05 | **Semi-Finished (SFG)** | Semi Finished Inventory Dashboard | Batch production from raw-material lots, SFG stock by lot and godown, and the log |
| M06 | **Finished Goods (FG)** | Finish Goods Inventory Dashboard | Filling SFG into cans or drums, FG stock by lot and godown, and the log |
| M07 | **FG Packing** | FG Packing Inventory Dashboard | Boxing filled cans into packing batches, packing stock by batch and godown, and the log |
| M08 | **Item Transfer** | Item transfer | Moving any stock type between godowns, including to the lost-stock record |
| M09 | **Re-Order** | Re-Order Dashboard | Minimum and maximum levels per godown, and re-order lists for raw materials and finished goods |
| M10 | **Sales Orders** | Sales Dashboard | Taken orders, pending orders, under-process and ready orders, lot allocation (batch codes), label-printing export |
| M11 | **Order Details (Billing & Dispatch)** | Order Details | Billing lines for ready orders: amounts, GST, costing, margin, dispatch verification |
| M12 | **Logistics** | Logistic Dashboard | Transport follow-up list, pending LR, LR tracking, paid-transport extra expenses |
| M13 | **Customer Requests & Credit Notes** | CN Dashboard | Complaints, credit-note requests, decisions, credit-note issue, pending credit-note sync |
| M14 | **Order Follow-up** | Order Followup, Party Order Pivot | Repeat-order prediction and calling dates per party and per product |
| M15 | **Expenses** | Expenses, Credit Expense | Petty-cash credits and expenses per employee, godown and mode, with running balance |
| M16 | **My Customers** | Edit Customer Details | A sales person's own tagged customers, editable fields only |
| M17 | **Help Videos** | Helpful Video | Library of training videos (YouTube link or uploaded file) |
| — | **Settings** | Settings (user settings form) | Working location, the signed-in user's name and position |

---

## 4. Functional requirements (summary)

The full logic for every item below is in `02-ERP-FUNCTIONAL-SPEC.md`. This
section states the requirements at product level. The IDs are referenced from the spec.

### 4.1 Masters (M02)

- **FR-M-01 Raw Materials.** Maintain items with serial number, name, code, unit
  (Kg / Litre / Unit), material type (Chemical, Can, Drum, Box, Stationary, and
  other configured types), density (required for chemicals), testing list
  (required for chemicals), price and remark. Show each item's total stock.
- **FR-M-02 Purchase Parties (suppliers).** Name (unique), own party code (used
  in lot numbers), area, location, state, credit days, mobile, WhatsApp, broker,
  grade, email. Call, message and email actions. List of the party's purchases.
- **FR-M-03 Products.** Product ID; SFG (liquid) name; FG product name
  (brand + pack size); packing item used (can or drum); litres per can;
  description of goods (the sellable SKU, e.g. "…1 Liter (Loose or 32 Can/Box)");
  cans per box; empty boxes required; box type; rate; weight. "Add more item"
  copies a row as a template.
- **FR-M-04 Sales Parties (customers).** Name (unique), area, location, state,
  transporter, payment type (Paid / To Pay), delivery type (Door / Godown),
  weight type (With / No Weight), sales person, contact numbers, email, segment,
  counter types, grade (A+, A, B+, B, C), monthly target, allocate email,
  company name, standing instructions, party status (Active / Deactive /
  Pending), GST number, tagged sales person, tagged price list, credit days.
  Lists of the customer's orders and requests. Status actions (activate,
  deactivate, pending) need confirmation and a capability.
- **FR-M-05 Godowns (location registration).** City, godown name (unique),
  address, phone, GSTIN, email, assigned employees, status, remark and map
  coordinates. A reserved godown named **Item Lost Record** is the loss ledger,
  flagged wherever it appears.
- **FR-M-06 Price lists.** Rows of price-list name, product (FG product name),
  rate including GST, rate excluding GST (derived at 18%), discount % and zone.
  A product appears once per price list.
- **FR-M-07 Employees.** Employee directory with personal, bank, statutory,
  target and leave fields, status, and ERP permissions (see §5 on how this
  relates to MahekOne HRMS). Inactive employees are flagged. Only holders of the
  employee-admin capability may see or edit it. The source's **Permissions** and
  **Ux Permission** fields are carried over with the record and superseded by
  MahekOne module access ("Manage ERP access").

### 4.2 Purchase (M03)

- **FR-P-01 Purchase requisition** ("Purchase Order" in the source). Any
  permitted user records a need: godown, material type (Chemical, Can, Box,
  Stationary, Finish Good), item, present quantity at that godown (auto),
  unit, required quantity, priority (Urgent / Medium / For Stock), order status
  (Pending → Order Placed → Booked → Received), remarks. The status can be
  changed quickly from the record.
- **FR-P-02 Purchase inward (GRN).** Records goods arriving: PR number (auto,
  shared by every line of the same delivery), date, supplier, material type
  (Chemical / Can / Box), item, drums, quantity, unit, weight with drum, godown,
  remark. The system decides **Testing Required** from the item's testing list.
  "Add more" adds another line to the same PR. "Select PR" selects all lines of
  a PR for bulk actions.
- **FR-P-03 Route to test or register.** An inward line that needs testing is
  sent to Purchase Testing. A line that does not is sent straight to the
  Purchase Register. Each line is sent once only.
- **FR-P-04 Purchase testing (QC).** Shows the tests the item requires and
  collects evidence for each: pH photo; smell (Good / Moderate / Bad); colour
  photo; oil-paint, fast-paint, NC-paint and primer photos; density reading
  plus photo; thermocol-pass photo; test video; remarks. The tester and date are
  recorded. Only the verifier (CEO capability) can mark it **Verified** or
  **Not Verified**. Verifying also creates the purchase register row. "Add more
  lot" copies a test row.
- **FR-P-05 Purchase register.** One row per purchased lot. It holds the rate,
  GST, amounts, litre conversion using density, feed-adjusted (loss) litres and
  amount, and a final amount. The **raw-material lot number** is supplier code
  + item code + PR number. Company (Mahek Marketing India / MYLAC), status
  (Invoice Received / Purchase Matched / Purchase Verified, where only the
  verifier sets Verified), bill-received toggle, bill number, notes, godown.
  Bulk actions: bill received / not received, change status, reopen (admin),
  export, select all rows of a PR. A missing or zero rate is flagged.
- **FR-P-06 Posting to stock.** A register row with a rate above zero posts its
  available litres into raw-material stock at its godown under its lot number.
  It posts once, automatically, and there is a manual retry.
- **FR-P-07 Purchase barcode export.** A list of chemical purchase lots at the
  user's working godown, exported as a file for drum label printing (lot number,
  short item name, litres, drums, litres per drum, density, quantity, unit,
  remark, PR Bill no, PR number, testing ID).

### 4.3 Inventory and production (M04–M07)

- **FR-I-01 Stock is lot-wise per godown** at four stages: raw material (by lot
  number), SFG (by SFG lot code), FG (by finished lot code, counted in cans),
  and FG packing (by packing batch number, counted in boxes). Current stock =
  inflows − transfers out − consumption by the next stage − allocations to
  orders, exactly as defined in the spec.
- **FR-I-02 Available-stock views** show only the latest entry of each
  lot × godown that still has stock above zero, with value at cost for
  capability holders. **Log views** show every inventory entry, with orphaned
  entries (whose source document is gone) flagged.
- **FR-I-03 SFG batch production.** A batch (SFG No, auto) at a godown for an
  SFG product and a number of batches consumes one or more raw-material lots.
  Each line picks a lot with stock at that godown (cans excluded) and a quantity
  per batch. Total use = batches × quantity per batch, and it cannot exceed the
  lot's available quantity ("Low Stock!"). Litres adjusted records loss. The
  SFG lot code is the SFG No + the first lot's number. Purchase costing and a
  weighted SFG rate per litre are calculated. Each line posts to SFG stock.
  "Add more SFG" adds a line to the same batch, and "Select SFG" selects the
  batch.
- **FR-I-04 FG filling.** It picks the SFG product and lot with stock at the
  godown, then an FG product valid for that SFG. Can size and packing item are
  filled from the product master. It shows available packing quantity and SFG
  litres. Number of cans (can size quantity) is validated with the messages
  "Low SFG Stock", "Minus Quantity Not Allowed" and "Low Packing Quantity". It
  records can adjustment, the finished lot code "FG{FG Num}{first two letters of
  godown}", packing type (Can / Drum / Naket), packing rate and FG costing.
  Each record posts its cans to FG stock.
- **FR-I-05 FG packing.** It picks an FG product and lot with stock, and a
  boxed SKU (description of goods with boxes required). Number of boxes gives
  the number of cans, validated against lot stock and the batch's remaining
  cans. Several FG lots can make one packing batch "FP{serial}{godown
  letters}". It shows box type, empty boxes required, box amount and packing
  costing. It posts to packing stock **only when the batch is complete**
  (cans packed = boxes × cans per box). An incomplete batch is flagged.

### 4.4 Item transfer (M08)

- **FR-T-01** Transfer any stock type (Purchase, Semi Finished, Finish Goods, FG
  Packing) from one godown to another. The form offers only items and lots
  with stock at the source. Quantity must be > 0 and ≤ the lot's stock.
  Destination ≠ source. Only the lost-stock capability may use **Item Lost
  Record**. The user confirms "Transfer {item} {qty}", and the quantity is
  posted to the destination stock of the right stage. Today's transfers are
  highlighted, loss transfers are flagged, and the list is exportable.

### 4.5 Re-order (M09)

- **FR-R-01 Raw-material levels:** per godown × item (unique), with minimum,
  maximum and Follow / Unfollow. Available quantity is computed per material
  type. Re-order % and required quantity (max − available) are derived.
  The **Re-order raw items** list shows followed items with a required quantity
  above zero.
- **FR-R-02 FG levels:** per godown × SKU (unique), with a minimum and Follow /
  Unfollow. Available comes from FG stock (loose SKUs) or packing stock (boxed
  SKUs). **Re-order finish goods** lists followed rows below their minimum.
- **FR-R-03** Present quantity on a purchase requisition is read from these
  levels.

### 4.6 Sales orders (M10)

- **FR-S-01 Taken order entry.** Order number (auto, shared by all lines of one
  order; "Generate new order number" re-numbers), godown, date, billing party
  (customer), delivery party (defaults to billing), standing instructions
  (derived from the delivery party), area, transporter (defaulted), SKU,
  quantity in cans, box quantity (derived and required to be whole), status
  (Under Process, Ready, Today, Delay, Cancel, Tomorrow, Hold From Office),
  rate and discount (from the billing party's price list), Tally bill number,
  transport cost, remark, entry status (Done / Not Done), party status (Pending
  if the customer is pending), weight, type (Can / Box / Drum), number of
  labels. "Add more" adds a line to the same order.
- **FR-S-02 Lot allocation (batch codes).** For each order line, staff scan or
  pick lot codes from FG stock (loose SKUs) or packing stock (boxed SKUs) at the
  order's godown, with quantities. The quantity is checked against required,
  available and per-lot remaining ("Invalid Quantity Or Wait For
  Synchronization"). The order shows **Can Quantity Verification**: Done / Add
  More Quantity / Remove Some Quantity.
- **FR-S-03 Status actions.** Ready, Under Process, Done, Not Done, Approved By
  Admin, each with its own conditions (see spec). Rows are flagged for: under
  process; ready but short of allocation; ready and fully allocated; missing
  Tally bill number or rate; rate present.
- **FR-S-04 Lists.** All taken orders; **Pending** (not cancelled, not "Empty
  Drum", order number not yet in order details); **Under Process / Ready**
  (entry not done); **Download for sales label printing** (grouped by
  transporter with total labels, exportable).
- **FR-S-05 Move to order details.** Allowed only when status = Ready, Tally
  bill no and rate are present, entry status = Done and allocation = Done.
  Each line moves once.

### 4.7 Order details: billing and dispatch (M11)

- **FR-D-01** Each order-details line pulls everything from its order: party,
  SKU, quantities, litres dispatched, rate, discount, transport cost, Tally bill
  number and the customer's commercial terms. It calculates amount, discounted
  amount, final amount with GST (18% or 0), bill total, company (by GST), lot
  costing, cost per unit, margin (after credit note), due date, fulfilment
  days, month, monthly sale per billing party against the monthly target, and
  sales person.
- **FR-D-02 Dispatch verification ("Do Verified").** Asks for the dispatch
  date. It sets Verification = Verified, Dispatch Status = Dispatched and a
  dispatch timestamp. It is allowed only when verification is pending, the order
  has lot allocations and its allocation check = Done. Unverified lines are
  flagged.
- **FR-D-03 Extra expenses** on paid-freight orders (entered once via prompt).
- **FR-D-04 Credit-note sync.** Lines whose credit-note amount differs from the
  accepted customer request for the same bill, customer and goods appear in
  **Pending CN**, and "Credit Note Updater" copies the amount across.

### 4.8 Logistics (M12)

- **FR-L-01** A verified order-details line creates one transport follow-up per
  order number. It carries bill date, party, bill no, transporter, area, payment
  type, extra expense and track status "Don't Track".
- **FR-L-02** Staff enter the LR number, track status (Track / Don't Track),
  material stage (Dispatch from Bhiwandi, Dispatch from Ambernath, In Transit,
  On the way to destination area, Reached destination area, Close – Received to
  party), reminder-call date and notes. The record shows the sales people, the
  tagged sales man and monthly sales.
- **FR-L-03 Lists:** Transport all list; **Pending LR** (no LR number);
  **Track LR** (LR present and Track); **Transportation Paid** (order lines of
  paid-freight customers with no extra expense yet, grouped by transporter).

### 4.9 Customer requests and credit notes (M13)

- **FR-C-01 Raise.** A sales person (or office staff) raises a request for a
  customer. It records mobile, complaint type (Packaging, Staff, Product,
  Transport, Rate Discount, Immediate Payment, Transportation, Product
  Complain, Sales Promotion), description and photo, and whether a credit note
  is required. If one is, it also records the bill number (suggested from the
  customer's bills), bill date and the goods on that bill. Status starts at
  Requested.
- **FR-C-02 Decide.** Admin or CEO accepts or rejects it, and the time is
  stamped.
- **FR-C-03 Resolve.** Accepted with a credit note: enter CN amount (GST amount
  derived at 18%), CN date, CN number, remark and the CN file, and the
  resolution time is stamped. Accepted without a credit note: enter remark and
  responsible employee, and the resolution time is stamped. Response time is
  derived.
- **FR-C-04 Add more credit.** Opens a new request pre-filled from the current
  one, for another item on the same bill.
- **FR-C-05 Lists:** Customer requests (grouped by status), Issue credit note
  (CN required), Customer complaint (no CN), Pending CN (see FR-D-04). The
  request status is flagged Accepted, Rejected or Requested.

### 4.10 Order follow-up (M14)

- **FR-F-01** Every order line reaching order details creates one follow-up
  record: order number, date, delivery party, FG product, cans.
- **FR-F-02** It derives the previous order date and day gap per party and per
  product, the party's average order interval, the **next upcoming order**
  date and the **calling date** (next order + reminder days). Staff enter the
  reminder days and remarks.
- **FR-F-03 Party order pivot:** last order date and order gap per party, as a
  report.

### 4.11 Expenses (M15)

- **FR-E-01 Credit (fund) entries:** date, godown, employee, mode (Bank Cash /
  Cash / Other), amount, credit note (reference).
- **FR-E-02 Expenses:** date, godown, expense by, category, mode, particular,
  amount, note, status (Pending / Verify, which is quick-editable).
- **FR-E-03 Available amount** per employee × godown × mode = credits − expenses,
  shown on both. The lists are grouped by godown and mode.

### 4.12 My Customers (M16)

- **FR-K-01** A sales person sees only customers whose tagged sales person is
  them, and can edit name-independent fields: grade, area, location, state,
  transporter, payment / delivery / weight type, contacts, email, counter type,
  monthly target, credit days. They also see the customer's requests.

### 4.13 Help Videos (M17)

- **FR-V-01** Title, source (YouTube URL / file upload), file or URL, search
  tags, description, and an in-app player. Newest first.

### 4.14 Settings

- **FR-U-01** Working-location selection among godowns the user is assigned to
  (§5.2), and display of the user's name and position.

---

## 5. Access, identity and working location

### 5.1 Sign-in

The ERP uses MahekOne's single sign-in. The source's Employee-ID-and-password
fields, and its check against the employee sheet, are replaced by it. Only
**active** employees may use the ERP, which carries over the source rule that
the user ID must belong to an active employee.

### 5.2 Working location

In the source, every user picks a godown after signing in, and forms default
their godown from it or from GPS (the nearest registered godown within 5 km).
The ERP keeps both:

- A **working location** per user. It can be chosen only from godowns whose
  *Assign Employee* list includes the user and whose status is Active.
- New records default their godown to the working location. When the browser
  shares a position, the default is the active godown within 5 km, as in the
  source.
- Screens that are scoped to "my godown" in the source, such as the purchase
  barcode list, use the working location.

### 5.3 Module access

Each ERP screen that the source gates with a permission name becomes an ERP
module (or a screen within one). A person holds a module or does not. It is
granted and revoked on MahekOne's access screen (one place for all apps),
never on the employee record. The source's full permission-name list and its
mapping are in the functional spec (§2.3).

### 5.4 Capabilities

| Capability | Held in the source by | What it allows |
|---|---|---|
| `erp.purchase.viewMoney` | admin; office email | Rates, GST, amounts, final amounts, company and status on purchases |
| `erp.cost.view` | admin | Purchase rate and costing on SFG, FG and packing; inventory rate and amount; order lot costing, cost per unit, margin, payment type |
| `erp.sales.viewRate` | admin; office email; second office email | Rate on taken orders |
| `erp.sales.viewAmounts` | admin; office email | Discount, amount, discounted amount, final amount and bill total on orders |
| `erp.qc.verify` | CEO email | Verify or unverify a purchase test (which creates the register row) |
| `erp.purchase.verify` | CEO email | Set purchase status "Purchase Verified" |
| `erp.purchase.reopen` | admin | "Do Pending" on a verified purchase |
| `erp.stock.lostRecord` | CEO email | Use the Item Lost Record godown on any form |
| `erp.customer.setStatus` | admin; office email | Activate, deactivate or mark a customer pending |
| `erp.order.approveParty` | admin | "Approved By Admin" on an order from a pending customer |
| `erp.request.decide` | admin; CEO email | Accept or reject customer requests |
| `erp.employee.admin` | admin | See the employee directory and assign permissions |

Every capability is enforced on the server as well as in what is shown.

---

## 6. ERP Dashboard (new, requested by the client)

The home screen of the ERP. It answers "what needs attention right now and what
is the state of stock", using **only data the modules already hold**. Every
figure links to the list behind it, filtered to exactly the rows counted.
Figures respect the viewer's module access and capabilities. A figure from a
module the viewer cannot open is not shown, and money figures need the matching
capability. A godown filter (defaulting to the working location, with "All")
applies to every stock and godown-scoped figure.

| Section | Figures (each links to its list) |
|---|---|
| **Purchase** | Requisitions by status (Pending, Order Placed, Booked); urgent requisitions open; inward lines awaiting routing (testing required and not sent, or not required and not in register); tests awaiting verification; register rows with missing/zero rate; bills not received; purchases by status (Invoice Received / Matched / Verified); purchase value this month *(money capability)* |
| **Stock** | Lots with stock at each stage (RM, SFG, FG, packing) and total quantity (litres / litres / cans / boxes); stock value per stage *(cost capability)*; orphaned inventory entries; incomplete packing batches |
| **Re-order** | Raw items below required level (count and list); finished goods below minimum |
| **Production today / this month** | SFG batches, FG filling records, packing batches, with quantities |
| **Transfers** | Transfers today; quantity moved to Item Lost Record this month *(lost-record capability)* |
| **Sales orders** | Orders by status (Under Process, Ready, Today, Tomorrow, Delay, Hold From Office, Cancel); ready but allocation short; ready and fully allocated awaiting "Done"; missing Tally bill no or rate; orders from pending customers awaiting admin approval; labels to print |
| **Dispatch & billing** | Order-details lines awaiting verification; dispatched today / this month; sales value this month *(sales-amounts capability)*; margin this month *(cost capability)*; paid-freight lines without extra expense |
| **Logistics** | Pending LR; consignments being tracked, by material stage; reminder calls due today or overdue |
| **Customer requests** | Requests by status; accepted-with-CN awaiting credit-note details; order lines with credit note pending sync; average response time this month |
| **Order follow-up** | Calling dates due today, overdue, and in the next 7 days |
| **Expenses** | Available petty-cash balance per godown × mode; expenses pending verification |
| **Customers** | Customers pending activation; my customers' monthly sale vs target (sales person) |

---

## 7. Non-functional requirements

| Area | Requirement |
|---|---|
| Platform | A MahekOne app (`erp`, named **ERP**) in the existing Next.js / Postgres codebase, sharing the database, sign-in, launcher, app access and module access. |
| Mobile-readiness | Every read and write lives in shared services, not in page code, so the future mobile app can call the same logic over an API. |
| Data integrity | Stock is never typed. It is always derived from source documents (purchases, batches, filling, packing, transfers, allocations). Every derived figure can be rebuilt. |
| Numbering | Sequential numbers (PR number, SFG No, FG Num, packing batch serial, order number) are allocated safely under simultaneous use, and a line added to an existing document keeps its document's number. |
| Money | Stored as integer paise and formatted only for display. GST percentages are configuration. |
| Quantities | Litres and kilograms keep the source's precision (2 decimals for litres, 3 for density), stored exactly. |
| Timezone | Business dates are Asia/Kolkata. |
| Audit | Every create, edit, delete, status action and posting records who and when. |
| Deletion | Delete exists for every table as in the source, restricted and confirmed. A deleted source document leaves its inventory entry flagged, not silently gone. |
| Performance | Lists are paginated and searchable, and "available stock" lists stay fast with years of history. |
| Files | Photos, videos and PDFs (tests, complaints, credit notes, help videos) are stored with access following their record. |
| Export | Each screen that exports in the source exports a CSV of the rows shown. |
| Barcode | Lot-code fields that are scannable in the source accept scanner (keyboard-wedge) input and camera scanning on devices that have one. |
| Configuration | Enum lists the source leaves open (material types, areas, states, segments, counter types, expense categories and particulars, price-list names, zones, testing list values, complaint types) are editable reference lists, not code. |

---

## 8. Integration with the rest of MahekOne

The ERP is one app in a suite that already holds some of the same things. The
rule is **one record per real-world thing**:

| ERP master in the source | Already in MahekOne | Requirement |
|---|---|---|
| Sales Party | Customers (projected today from the same "Sales Party" sheet tab) | The ERP reads and writes the MahekOne customer. Fields the source has that the customer record lacks are added to that record. |
| My Products | The product catalogue (formulation → brand → finished good → SKU) | SFG product = formulation, FG product name = finished good, Description Of Goods = SKU. Packing fields the catalogue lacks are added to it. |
| Employee Details | HRMS employee master (mirrored from the same "Mahek EMP 2.0" workbook) | The ERP reads employees from HRMS. ERP permissions move to MahekOne module access. |
| Pricelist | MahekOne price lists | The order rate and discount lookup reads MahekOne price lists. |
| Taken Order / Order Details tabs | Synced into MahekOne today (order hold-back and bills) | When the ERP becomes where orders are entered, the sheet sync for these tabs is retired, and anything that read the synced rows reads the ERP's records instead. The cut-over is planned with the client (open question Q1). |

---

## 9. Additions that are not in the source, and why each is needed

| Addition | Needed by |
|---|---|
| ERP Dashboard (§6) | Explicitly requested by the client |
| MahekOne sign-in instead of an ID/password form | Replaces the source's own sign-in (§5.1) |
| Working-location selector | Replaces the source's settings form "Select Location" (§5.2) |
| Capabilities instead of hard-coded emails | Keeps the source's special powers without code changes when people change (§5.4) |
| Automatic, idempotent posting to inventory on save, plus a manual retry | The source uses automation bots plus manual buttons to post purchases, transfers and production to stock. On the web both become one reliable step. |
| Editable reference lists for open enums | The source's enums with no fixed values are maintained in sheets. The web needs a place to edit them. |
| Concurrency-safe numbering | The source's "max + 1" breaks when two people save at once. |
| Audit trail | Needed to replace the source's "User Name / Timestamp" columns faithfully across edits |
| Anomaly fixes (spec §14) | Where a source formula contradicts its own evident intent, the ERP implements the intent. Each case is listed for sign-off. |

---

## 10. Out of scope

Anything not in the source. That includes accounting books, GST filing,
invoice generation, e-way bills, BOMs and production planning, vendor
payments, receipts and outstanding (MahekOne Accounts already handles
receipts), payroll, and the mobile app itself (a later phase that reuses the
same backend).

---

## 11. Open questions for the client

1. **Q1 Cut-over of orders.** Will the ERP replace the Taken Order and Order
   Details Google Sheets on day one, or run alongside them for a period?
2. **Q2 Special people.** Who holds each capability in §5.4? The source ties
   them to *mahekmarketingindiaceo@gmail.com*, *mahekmarketingindia@gmail.com*
   and *mahekmarketing1@gmail.com*, plus the AppSheet admin role.
3. **Q3 Opening data.** Is the history in the source sheets migrated in full
   (purchases, batches, inventory entries, orders), or is the ERP opened with
   opening stock per lot per godown?
4. **Q4 Company.** Order lines choose the company from GST (18% → Mahek Marketing
   India, 0% → MYLAC), and purchases choose Mahek Marketing India or MYLAC.
   Confirm that both companies share one stock.
5. **Q5 Order follow-up trigger.** Should a follow-up record be created when an
   order line enters order details, or when it is dispatch-verified? The source
   bot's trigger is not in the document.
6. **Q6 Anomalies.** Sign off each intended-behaviour decision in spec §14.
7. **Q7 Labels.** Is the CSV export enough for label printing (as today), or
   should the ERP produce the labels directly?
8. **Q8 Missing screens.** The source references "raise customer request", "Sales
   By Complaint" forms and Purchase Order fields "Quotation Party" and
   "PO (Tally)" that do not exist in its data. Should these be built?
