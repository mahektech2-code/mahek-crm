# MahekOne ERP — Functional Specification (all features, all logic)

Companion to `01-ERP-PRD.md`. This document defines **every** field,
default, calculation, validation, list, action, flag and automation of the ERP,
derived line by line from the client's *Mahek One ERP Application
Documentation* (AppSheet "Mahek Plus"). Where the source contradicts its own
evident intent, the source behaviour and the ERP decision are both recorded
in §14.

---

## 1. Conventions and glossary

### 1.1 How to read the field tables

| Column | Meaning |
|---|---|
| **Field** | Field name (source name kept, typos corrected in the label only, e.g. "Recieved" → "Received") |
| **Type** | Text, Long text, Number, Decimal(n), Money (₹, 2 dp), Percent, Date, DateTime, Duration, Enum, Multi-enum, Ref → Entity, Image, File, Video, Phone, Email, Address, LatLong, Yes/No, List (derived related records) |
| **Kind** | **Input** (user types), **Default** (pre-filled on create, editable), **Derived** (always calculated, never typed), **Stamp** (set by the system at an event), **System** (id) |
| **Rule** | Default formula, derivation, validation ("Valid if"), visibility ("Shown if"), required-ness, error message |

Notation used in formulas:
- `this.X` is a field of the current record.
- `Σ Entity.X where …` means the sum of X over the matching records.
- `any(Entity.X where …)` means the value from any one matching record (the source uses ANY; the ERP takes the first by creation time).
- `next(Entity.N)` means the maximum existing N + 1, allocated atomically (see §1.3).
- "Godown list (active)" means the names of godowns whose status is Active.
- "Godown list (active, no loss)" means the same list minus **Item Lost Record**, unless the user holds `erp.stock.lostRecord`.

### 1.2 Glossary

| Term | Meaning |
|---|---|
| **RM** | Raw material: chemicals, cans, drums, boxes and stationery, bought from purchase parties |
| **Lot No / Raw material Lot No** | Identity of one purchased lot: `Own Party code & Item code & PR Number` |
| **SFG** | Semi-finished goods: a liquid made in a batch by mixing RM lots |
| **SFG No / Semi Product Lot code** | Batch number and the SFG lot code `SFG No & first RM lot no` |
| **FG** | Finished goods: SFG filled into cans or drums (unit = can) |
| **Finished Lot Code** | `"FG" & FG Num & UPPER(LEFT(godown,2))` |
| **FG Packing / Batch No.** | Filled cans boxed into cartons: `"FP" & Batch Serial & UPPER(LEFT(godown,2))` (unit = box) |
| **SKU / Description Of Goods** | The sellable product line, e.g. "Mahek N C Thinner - 1 Liter (Loose or 32 Can/Box)" |
| **FG Product Name** | Brand + pack size, e.g. "Mahek N C Thinner - 0.5 Liter" |
| **SFG Product Name** | The liquid (formulation) |
| **Loose SKU** | An SKU whose `No. Of Can Per Box = 1` **and** `No. Of Empty Box Required = 0`. It is sold as individual cans or drums from FG stock. |
| **Boxed SKU** | Any other SKU. It is sold in boxes from FG packing stock. |
| **Taken Order** | A customer order line as booked |
| **Batch Code** | An allocation of a stock lot (FG lot or packing batch) to an order line |
| **Order Details** | The billing and dispatch line created from a ready order line |
| **LR** | Lorry receipt number from the transporter |
| **CN** | Credit note |
| **Item Lost Record** | A reserved godown used to write stock off as lost |
| **Working location** | The godown the signed-in user is currently working at |

### 1.3 Sequential numbers

The source uses `IF(value is new, MAX+1, keep)`, so that **copying a line ("Add
more") keeps the document number** and a fresh record gets the next one. The
ERP keeps exactly that behaviour:

- **New document:** number = next in its series, allocated atomically.
- **Add another line to the same document:** same number.
- **Regenerate** (Taken Order only, action "Generate New Order Number"): the
  selected lines get a new next number.

The series are PR Number (shared by Purchase Inward and Purchase), SFG No,
FG Num, Batch Serial (FG Packing), Order number (Taken Order), Raw Materials
Serial No., My Products Product ID and Pricelist Sr. No.

> Source detail: Purchase Inward and Purchase each compute MAX+1 over their **own**
> table. Because a purchase row created from an inward or a test copies the
> inward's PR Number, the ERP uses **one** PR series, allocated at inward, and a
> manually created purchase row also draws from it (see §14 A-01).

### 1.4 Record identifiers

The source's generated keys are kept as each record's human-readable
reference:

| Entity | Key |
|---|---|
| Purchase Inward | `PrIn` + unique id |
| Purchase Test | `Test` + unique id, or the inward's Received ID when created from an inward |
| Purchase | `PR Billno-` + unique id, or the Test ID / Received ID it came from |
| Semi Finished line | `SFG-` + unique id |
| Finished Goods | `FINI ` + unique id |
| FG Packing | unique id |
| Item Transfer | `TRF` + unique id |
| Taken Order line | `ODID-` + 6 characters |
| Batch Code, Purchase Order, Expenses, Credit Expense, Min-qty rows | unique id |
| Inventory entries | the id of the document that created them (see §6.1) |

### 1.5 Common fields

Most records carry **User / User Name / Appuser** (the signed-in employee's
name, stamped on create) and **Timestamp** (stamped on create). The ERP also
keeps a full audit trail of edits. Where the source's Timestamp is an
*app formula* `NOW()` (Expenses, RM Minimum Quantity), it updates on every edit.
The ERP keeps it as "last updated at".

---

## 2. Access

### 2.1 Sign-in

MahekOne sign-in. The ERP opens only for a user linked to an **Active**
employee. The source's settings-form checks become:

| Source (Per User Settings) | ERP |
|---|---|
| User ID must be an Active employee's ID | Linked employee must be Active |
| Password must equal the employee's password; error "Please Enter Valid Password or Contact Admin Maybe You are inactive employee." | MahekOne sign-in. An inactive employee sees that sentence. |
| User Name = employee name | Shown in Settings; stamped on records |
| Position = employee position | Shown in Settings; used by Request Form default (§12.2) |
| Select Location: godowns whose Assign Employee includes the user | Working location (§2.2) |
| Options heading / login image / Option 2–4 | Not carried (decorative or unused) |

### 2.2 Working location

- The choices are godowns where `Assign Employee` contains the user **and**
  status = Active. It is changed from Settings at any time and remembered per
  user.
- It is the default godown on: Expenses, Credit Expense, and every form with a
  Location field when no GPS default applies.
- **GPS default (as in the source)** applies on Purchase Order, Purchase
  Inward, FG Packing and Item Transfer (From Location): if the browser provides
  a position, the default is any godown whose LatLong is within 5 km. Otherwise
  it is the working location.
- **Purchase Barcode** list is filtered to the working location.

### 2.3 Permission names → ERP screens

Each source permission name becomes one grantable ERP screen (a MahekOne
module). A person sees a screen, its menu entry, and its dashboard tiles only
if they hold it. The source's menu dashboards become module groups, each
visible if the user holds the group permission.

| Source permission name | ERP module group → screen |
|---|---|
| Master Dashboard | M02 Masters (group) |
| Raw Materials | M02 → Raw Materials |
| Purchase Party | M02 → Purchase Parties |
| My Products | M02 → Products |
| Sales Party | M02 → Sales Parties |
| Location Registration | M02 → Godowns |
| Pricelist | M02 → Price Lists |
| *(role = admin)* | M02 → Employees (`erp.employee.admin`) |
| Purchase Dashboard | M03 Purchase (group) |
| Purchase Order | M03 → Purchase Requisitions |
| Purchase Inward | M03 → Purchase Inward |
| Purchase Test | M03 → Purchase Testing |
| Purchase | M03 → Purchase Register |
| Purchase Barcode | M03 → Purchase Barcode |
| Purchase Inventory Dashboard | M04 RM Inventory (group) |
| Available Purchase Inventory (Slice) | M04 → Available RM Stock |
| Purchase inventory Log | M04 → RM Inventory Log |
| Semi Finished Inventory Dashboard | M05 SFG (group) |
| Semi Finished | M05 → SFG Batches |
| Available Semi Finished Inventory Slice | M05 → Available SFG Stock |
| Semi Finished Inventory Log | M05 → SFG Inventory Log |
| Finish Goods Inventory Dashboard | M06 FG (group) |
| Finished Goods | M06 → FG Filling |
| Available Finish Goods Inventory Slice | M06 → Available FG Stock |
| Finished Goods Inventory Log | M06 → FG Inventory Log |
| FG Packing Inventory Dashboard | M07 FG Packing (group) |
| FG Packing | M07 → FG Packing |
| Available FG Packing Inventory Slice | M07 → Available Packing Stock |
| FG Packing Inventory Log | M07 → Packing Inventory Log |
| Item transfer | M08 Item Transfer |
| Re-Order Dashbord | M09 Re-Order (group) |
| Re-Order Raw Items | M09 → Re-Order Raw Items |
| Re-Order Finish Goods | M09 → Re-Order Finish Goods |
| Raw Materials Minimum Quantity | M09 → RM Levels |
| Finish Goods Minimum Quantity | M09 → FG Levels |
| Sales Dashboard | M10 Sales Orders (group) |
| Take Order | M10 → Taken Orders |
| *(inside Sales Dashboard, no own gate)* | M10 → Pending Orders |
| Under process / Ready Orders | M10 → Under Process / Ready |
| Batch Code | M10 → Batch Codes |
| Download For Sales Label Printing | M10 → Sales Label Printing |
| Order Details | M11 Order Details |
| Logistic Dashboard | M12 Logistics (group) |
| TRANSPORT ALL LIST | M12 → All Transport |
| Pending LR | M12 → Pending LR |
| Track LR | M12 → Track LR |
| Transportation Paid | M12 → Transportation Paid |
| CN Dashboard | M13 Customer Requests & CN (group, with Customer Request, Issue Credit Note, Customer Complaint, Pending CN) |
| Order Followup | M14 Order Follow-up (plus Party Order Pivot report) |
| Expenses | M15 → Expenses |
| Credit Expense | M15 → Credit (Funds) |
| *(no gate; row-scoped)* | M16 My Customers (every user; shows only their tagged customers) |
| *(no gate)* | M17 Help Videos |
| *(new)* | M01 ERP Dashboard (every ERP user; tiles follow the table above) |

### 2.4 Capabilities and field visibility

Capabilities are listed in PRD §5.4. The fields they reveal:

| Capability | Fields revealed (hidden otherwise) |
|---|---|
| `erp.purchase.viewMoney` | Purchase: Rate (₹), Liter per Rate, GST %, GST Amount, Sub total, Amount + GST, Feed adjusted amount, Final amount, Company Name, Status, Bill Received, This Bill Final Amount |
| `erp.cost.view` | Semi Finished: Purchase Rate, Purchase Costing, Test (SFG rate). Finished Goods: FG COSTING. FG Packing: FG Packing Costing. RM / SFG / FG / Packing inventory: Rate, Amount, SFG Rate, SFG Costing, SFG Costing-Slice, Finish Goods Amount-Slice. Batch Code: Costing. Order Details: Cost Price per Litre, Lotcode Costing, Margine, Payment type |
| `erp.sales.viewRate` | Taken Order: Rate, Rate 2 |
| `erp.sales.viewAmounts` | Taken Order: Discount. Order Details: Amount, Discounted Amount, Final Amount, This Bill Final Amount |

Hidden fields are omitted from the server response, not just from the screen.
They are also excluded from exports for users without the capability.

---

## 3. Reference lists (editable, "Masters → Reference lists")

Fixed lists stay fixed. Open lists (empty in the source because their values
live in the sheets) are editable reference lists. The ERP seeds them from the
distinct values found in the migrated data.

| List | Values | Kind |
|---|---|---|
| RM Item Unit | Kg, Litre, Unit | fixed |
| Material type (RM master) | Chemical, Can, Drum, Box, Stationary, *(others as configured)* | editable |
| Purchase unit | Kg, Litre, Pcs | fixed |
| Purchase company | Mahek Marketing India, MYLAC | fixed |
| Purchase status | Invoice Received, Purchase Matched, Purchase Verified | fixed (+ Pending, see §5.4) |
| Bill received | Received, Bill Not Received | fixed |
| Testing list | PH, Smell, Color, Oil Paint, Fast Paints, Nc Paints, Primer, Density, Tharmakol Pass | editable |
| Smell | Good, Moderate, Bad | fixed |
| Verification status (test) | Verified, Not Verified | fixed |
| Requisition material type | Chemical, Can, Box, Stationary, Finish Good | fixed |
| Requisition priority | Urgent, Medium, For Stock | fixed |
| Requisition status | Pending, Order Placed, Booked, Received | fixed |
| Inward material type | Chemical, Can, Box | fixed |
| Packing type | Can, Drum, Naket | fixed |
| Box type | Empty Box 1 Liter, Empty Box 5 Liter, Empty Box 10 Liter, Empty Box 20 Liter, Empty Drum | fixed |
| Item transfer type | Purchase, Semi Finished, Finish Goods, FG Packing | fixed |
| Follow status | Follow, UnFollow | fixed |
| Area, State (party) | — | editable |
| Transporter (Transport Detail) | — | editable |
| Payment type (customer) | Paid, To Pay | fixed |
| Delivery type | Door Delivery, Godown Delivery | fixed |
| Weight type | No Weight, With Weight | fixed |
| Sales person | — (active employees) | editable |
| Segment, Counter type | — | editable |
| Customer grade | A+, A, B+, B, C | fixed |
| Party status | Active, Deactive, Pending | fixed |
| Order status | Under Process, Ready, Today, Delay, Cancel, Tomorrow, Hold From Office | fixed |
| Entry status | Done, Not Done | fixed |
| Order party status | *(copied)* Pending, Approved By Admin | fixed |
| GST on order details | 18%, 0% | fixed (configurable rate) |
| Dispatch status | Dispatched, Pending | fixed |
| Verification (order details) | Verified, Not Verify, Pending | fixed |
| Transport payment type | To Pay, Paid | fixed |
| Track status | Track, Don't Track | fixed |
| Material stage | Dispatch from Bhiwandi, Dispatch from Ambernath, In Transit, On the way to Destination area, Reached Destination Area, Close - Received to Party | fixed |
| Complaint type | Packaging, Staff, Product, Transport, Rate Discount, Immediate Payment, Transportation, Product Complain, Sales Promotion | editable |
| Customer request status | Requested, Accepted, Rejected | fixed |
| Yes/No (CN required) | Yes, No | fixed |
| Expense / credit mode | Bank Cash, Cash, Other | fixed |
| Expense category, Particular, Credit note (fund reference) | — | editable |
| Expense status | Pending, Verify | fixed |
| Price-list name, Zone | — | editable |
| Godown city (Location) | — | editable |
| Video source | From YouTube URL, From File Upload | fixed |
| Video search tags | — | editable |
| Employee status | Active, Inactive | fixed |
| Godown status | Active, Inactive | fixed |

---

## 4. Masters (M02)

### 4.1 Raw Materials

| Field | Type | Kind | Rule |
|---|---|---|---|
| Serial No. | Number | Default, **key** | `next(Serial No.)` |
| Raw Item | Text | Input | Item name. Unique in practice (used as lookup key everywhere). |
| Item Code | Text | Input | Part of the lot number |
| Item Unit | Enum (Kg, Litre, Unit) | Input | |
| Material type | Enum (editable list) | Input | |
| Density Kg to Litre | Decimal(3) | Input | Shown and **required** if Material type = Chemical |
| Testing List | Multi-enum (testing list) | Input | Shown and **required** if Material type = Chemical |
| Price | Money | Input | Used as packing rate for cans and drums (§8) |
| Remark | Long text | Input | |
| User ID | Email | Stamp | Signed-in user's email |
| Timestamp | DateTime | Stamp | |
| Total Stocks | Number | Derived | `Σ Purchase.Quantity where Raw Item = this − Σ SemiFinished.Total use incl batch where Raw material Item Name = this` (all godowns) |

Actions: Add, Edit, Delete (restricted), Email user.

### 4.2 Purchase Parties

| Field | Type | Kind | Rule |
|---|---|---|---|
| Party Name | Text | Input, **key**, unique | |
| Own Party code | Text | Input | Part of the lot number |
| Area | Enum (editable) | Input | |
| Location | Text | Input | |
| State | Enum (editable) | Input | |
| Credit Days | Number | Input | |
| Mobile No. | Phone | Input | Call / message |
| Whatsapp Contact | Phone | Input | Call / message |
| Broker Name | Text | Input | |
| Grade | Text | Input | |
| Party Email | Email | Input | Email action |
| User | Text | Derived | Signed-in user's name (see §14 A-02) |
| Date | Date | Default | Today |
| Related Purchases | List → Purchase | Derived | Purchases where Party Name = this |

List: grouped by State (with count) and sorted by name. Call is the quick action.

### 4.3 Products (My Products)

| Field | Type | Kind | Rule |
|---|---|---|---|
| Product ID | Number | Default, **key** | `next(Product ID)` |
| SFG Product Name | Enum (editable) | Input | The liquid |
| FG Product Name | Enum (editable) | Input | Label: "FG Product Name (For Ex:- Mahek N C Thinner - 0.5 Liter)" |
| Can Use | Text | Input | Valid if: an RM item whose Material type is Can or Drum |
| Liter Per Can | Decimal(2) | Input | |
| Description Of Goods | Enum (editable, long text) | Input | Label: "Description Of Goods (For Ex:- Mahek N C Thinner - 1 Liter (Loose or 32 Can/Box))". The SKU. |
| No. Of Can Per Box | Number | Input | 1 for loose |
| No. Of Empty Box Required | Number | Input | 0 for loose |
| Box Type | Enum (box types) | Input | |
| Rate | Money | Input | Used as the **box rate** in packing costing (§9) |
| Weight | Decimal(2) | Input | Copied to orders |

Actions: Add, Edit, Delete, **Add More Item** (copy the row into a new form).

### 4.4 Sales Parties (customers)

| Field | Type | Kind | Rule |
|---|---|---|---|
| Date | Date | Default | Same as the previous row's date (source `@(_FILL)`); the ERP defaults to today |
| Sales Party Name | Text | Input, **key**, unique | |
| Area | Enum (editable) | Input | |
| Location | Text | Input | City |
| State | Enum (editable) | Input | |
| Transport Detail | Enum (transporters) | Input | Default transporter |
| Payment type | Enum (Paid, To Pay) | Input | Freight paid by us or by customer |
| Delivery Type | Enum (Door Delivery, Godown Delivery) | Input | |
| Weight type | Enum (No Weight, With Weight) | Input | |
| Sales Person | Enum (sales people) | Input | |
| Mobile No. | Phone | Input | Sensitive |
| Whatsapp Contact | Phone | Input | Sensitive |
| Party Email ID | Email | Input | Sensitive |
| Segment | Enum (editable) | Input | |
| Counter type | Multi-enum (editable) | Input | |
| GRADE | Enum (A, A+, B, C, B+) | Input | |
| Monthly Target | Money | Input | |
| allocate | Email | Input | Allocation email, with an email action |
| Company name | Text | Input | |
| Standing Instructions | Text | Input | |
| Party Status | Enum (Active, Deactive, Pending) | Default Active | Changed only by the actions below |
| GST Number | Text | Input | |
| Tag Sales Person | Enum (sales people) | Input | Scopes "My Customers" |
| Tag PriceList | Enum | Input | Valid if: an existing price-list name |
| Credit Days | Number | Input | |
| Related Taken Orders | List → Taken Order | Derived | Where Billing Party Name = this |
| Related Request Forms | List → Request Form | Derived | Where Company/Customer Name = this |

**Actions** (each needs `erp.customer.setStatus` and confirmation):
- **Do Active:** shown when status ≠ Active. Confirmation text: "Are You Sure! This Party Is Verified By Admin". Sets Active.
- **Do Deactive:** shown when status ≠ Deactive. Confirmation "Are You Sure!". Sets Deactive.
- **Do Pending Party:** shown when status ≠ Deactive (see §14 A-03). Confirmation "Are You Sure!". Sets Pending.
- Call / message / email on the phone and email fields. Add, Edit, Delete.

List columns: Name, Area, Transport Detail, Payment type, Monthly Target,
Standing Instructions, GST Number, Tag Sales Person, Tag PriceList, Credit
Days, then all others.

### 4.5 Godowns (Location Registration)

| Field | Type | Kind | Rule |
|---|---|---|---|
| Location ID | Text | System | Hidden |
| Location | Enum (editable city list) | Input | |
| Godown Name | Text | Input, **key**, unique | |
| Address | Address | Input | Map action |
| Phone Number | Phone | Input | Call / message |
| GSTIN Number | Text | Input | |
| Email ID | Email | Input | Email action |
| Assign Employee | Multi-enum | Input | Valid if: active employee names. Drives working-location choices. |
| Status | Enum (Active, Inactive) | Default Active | Quick-editable on the record |
| Remark | Long text | Input | |
| Timestamp | DateTime | Stamp | |
| Latlong | LatLong | Input | Used for the 5 km GPS default. Map action. |

**Item Lost Record** is a godown record with that exact name. It is flagged
wherever it appears (Godown Name here; From/To Location on transfers).

List sorted by godown name.

### 4.6 Price Lists

| Field | Type | Kind | Rule |
|---|---|---|---|
| Sr. No. | Number | Default, **key** | `next(Sr. No.)` |
| Pricelist Name | Enum (editable) | Input | |
| Product Name | Text | Input | Suggested: FG Product Names not yet in this price list. Unique per (Pricelist Name, Product Name). |
| Rate Including GST | Money | Input | Cleared when the product is changed to one not already in this list |
| Rate | Money | Default | `Rate Including GST ÷ 118 × 100` (GST rate from configuration, default 18%) |
| Discount | Percent(2) | Input | |
| Zone | Enum (editable) | Input | |

List grouped by Pricelist Name (with count). Actions: Add, Edit, Delete, Add More (copy).

### 4.7 Employees

Read from the MahekOne HRMS employee master (the same "Mahek EMP 2.0"
workbook the source reads, with updates only, no adds). Fields shown to
`erp.employee.admin`: Employee Id, Name, Gender, Office Name, Report To,
Address, Personal Mobile, Emergency contact, Permanent Address, Bank Name,
Account Number, IFSC, Alternate Number, Position Type, Position, Date Of
Joining, Date Of Birth, Status, Marriage Anniversary, Email, Child-1 and
Child-2 birthdays, Salary Allocate, Conveyance, Other Salary, Company Mobile,
Aadhaar Number, Photo, Area Allocated, Visit Target, Km Target, Liter Sales
Target, Working Hour Target, Amount Of Sale Target, Date of Leave, Yearly Paid
Leave, Yearly Maximum Leave, PF/ESIC Applicable, UAN No., ESIC No.

- List grouped by Status (with count). Header shows name and position type.
  Inactive employees are flagged.
- **Permissions** (source action "Permissions": admin types a job description
  into the Permissions list) is replaced by **"Manage ERP access"**, which
  opens the MahekOne access screen for this person (§2.3). The employee
  **password** field is not shown or used (sign-in is MahekOne's).
- **Ux Permission** (a free-text field beside Permissions in the source, not
  read by any rule or screen) is migrated with the record and superseded by
  MahekOne module access, the same as Permissions.
- Call / message on Personal Mobile and Emergency contact, email on Email, map
  on Address and Permanent Address.
- Position Type values used by rules: `office staff`, `sales`.

---

## 5. Purchase (M03)

### 5.1 End-to-end flow

```
Purchase Requisition (need)                          [independent tracker]
Purchase Inward (goods at gate, PR Number) ──┬─ Testing Required = Yes ─► Purchase Test ─ Verify (CEO) ─► Purchase Register
                                             └─ Testing Required = No  ──────────────────────────────────► Purchase Register
Purchase Register (rate > 0) ─► RM inventory entry (lot at godown)
```

### 5.2 Purchase Requisitions (source table "Purchase Order")

| Field | Type | Kind | Rule |
|---|---|---|---|
| Purchase OrderID | Text | System, key | |
| Date | Date | Default | Today |
| Location | Godown | Default | GPS/working-location default (§2.2). Valid: godown list (active, no loss). |
| Material type | Enum (Chemical, Can, Box, Stationary, Finish Good) | Input | |
| Raw Item | Text | Input | Valid: if Finish Good, any SKU (Description Of Goods); otherwise RM items of that material type |
| Present Quanity | Number | Derived | Finish Good: `Σ FG Levels.FG Available Quantity where Product Name = item and Location = this`. Otherwise: `Σ RM Levels.Raw Item Available where Raw Item = item and Location = this`. It is blank if no level row exists (§14 A-04). |
| Unit | Text | Default | Can/Box/Stationary → Pcs. Chemical → Liter. Finish Good → Box or Pcs. Valid only from that set. |
| Required Quantity | Number | Input | |
| Order Priority | Enum (Urgent, Medium, For Stock) | Input | |
| Order Status | Enum (Pending, Order Placed, Booked, Received) | Default Pending | Quick-editable from the record |
| Remarks | Long text | Input | |
| User Name | Text | Default | Current user |
| Timestamp | DateTime | Stamp | |

- List: grouped by Order Status. Columns: Date, Status, Material type, Item,
  Required Qty, Unit, Present Qty, Priority, Remarks, Location, User.
- Flags: **Order Placed** and **Booked** rows are marked distinctly on Date,
  Material type, Item, Unit, Required Qty and Status.
- Record header: Item and Required Quantity.
- See §14 A-05 for the "Quotation Party" / "PO (Tally)" fields.

### 5.3 Purchase Inward

| Field | Type | Kind | Rule |
|---|---|---|---|
| Received ID | Text | System, key | `PrIn…` |
| PR Number | Number | Default | §1.3 (PR series). "Add more" keeps it. |
| Item Received Date | Date | Default | Today |
| Party Name | Ref → Purchase Party | Input | |
| Material Type | Enum (Chemical, Can, Box) | Input | |
| Raw item | Text | Input | Valid: RM items of that material type |
| No. of Drum | Number | Input | Shown if Chemical |
| Quantity | Number | Input | |
| Unit | Text | Default | Box → "Pcs". Otherwise the item's Item Unit. Valid: an RM unit. |
| Wt With Drum | Number | Input | Shown if Chemical |
| Location | Godown | Default | GPS/working default. Valid: godown list (active, no loss). |
| Remark | Long text | Input | |
| Testing Required | Yes/No | Derived | Yes if the item's Testing List is not empty |
| User Name, Timestamp | | Stamp | |

**Actions**
- **Send to Testing** (source "Purchase Inward To Test"). Available when
  Testing Required = Yes and no Purchase Test has Test ID = this Received ID.
  It creates a Purchase Test with: Test ID = Received ID, Raw Item, Quantity,
  Party Name, Location, PR Number, Unit, Timestamp = now, Weight with Drum =
  Wt With Drum, Testing Date = Item Received Date, No. of Drum. It works on one
  or many selected rows.
- **Send to Purchase** (source "Send To Purchase"). Available when Testing
  Required = No and no Purchase has PR Bill no = this Received ID. It creates a
  Purchase with: PR Bill no = Received ID, PR Number, Raw Item, Quantity, Party
  Name, Unit, Timestamp = now, Remark, Location, Purchase Date = Item Received
  Date, GST % = 18%, No. of Drum. Bulk-capable.
- **Add More** (copy into a new line of the same PR), **Select PR Number**
  (select every inward line with this PR Number for bulk actions), Add, Edit,
  Delete.
- List: grouped by PR Number (count), newest received first. Record header:
  No. of Drum, Raw item, Quantity.

### 5.4 Purchase Testing (source "Purchase Test")

| Field | Type | Kind | Rule |
|---|---|---|---|
| Test ID | Text | System, key | `Test…` or the Received ID |
| PR Number | Number | Input/copied | |
| Raw Item | Text | Input/copied | |
| Party Name | Text | Input | Valid: purchase party names |
| Unit | Text | Default | Item's Item Unit |
| Weight with Drum | Number | Input | |
| Quantity | Number | Input | |
| No. of Drum | Number | Input | |
| Testing | Multi-enum | Derived | The item's Testing List (split on commas) |
| PH Image | Image | Input | Shown if Testing includes PH |
| Smell | Enum (Good, Moderate, Bad) | Input | Shown if Testing includes Smell |
| Color Image | Image | Input | Shown if Color |
| Oil Paints Image | Image | Input | Shown if Oil Paint |
| Fast Paints Image | Image | Input | Shown if Fast Paints |
| NC Paints Image | Image | Input | Shown if Nc Paints |
| Primer Image | Image | Input | Shown if Primer |
| Density | Decimal(3) | Default | The item's Density Kg to Litre. Shown if Density. |
| Density Image | Image | Input | Shown if Density |
| Tharmakol Pass Image | Image | Input | Shown if Tharmakol Pass |
| Test Video | File | Input | Open action |
| Tester Name | Text | Derived | Current user (see §14 A-02) |
| Verification Status | Enum (Verified, Not Verified) | Default Not Verified | Changed only by the actions below |
| Remark | Long text | Input | |
| Testing Date | Date | Default | Today |
| Timestamp | DateTime | Stamp | |
| Location | Godown | Input | Valid: godown list (active, no loss) |

**Actions**
- **Do Verify** (needs `erp.qc.verify`). Available when status ≠ Verified. In one
  step it (1) sets Verification Status = Verified and (2) runs **Test To
  Purchase**: if no Purchase has PR Bill no = Test ID, it creates a Purchase with
  PR Bill no = Test ID, PR Number, Raw Item, Party Name, Unit, Testing ID =
  Test ID, Quantity, Timestamp = now, Purchase Date = Testing Date, Density,
  GST % = 18%, Location, Remark, No. of Drum. Bulk-capable.
- **Do Not Verified** (needs `erp.qc.verify`). Available when status ≠ Not
  Verified. Sets Not Verified. It does **not** remove a purchase row already
  created (see §14 A-06).
- **ADD More Lot:** copy the test into a new test (for another lot of the same
  inward).
- Add, Edit, Delete, open Test Video.
- List: grouped by Verification Status, then Testing Date descending, sorted by
  PR Number descending. Record detail shows the Verification Status first.

### 5.5 Purchase Register (source "Purchase")

| Field | Type | Kind | Rule |
|---|---|---|---|
| PR Bill no | Text | System, key | `PR Billno-…`, or the Test ID / Received ID |
| PR Number | Number | Default | PR series (§1.3) |
| Purchase Date | Date | Default | Today |
| P.O. Number | Number | Input | |
| Party Name | Ref → Purchase Party | Default | Party of a **Verified** test with the same PR Number |
| Own Party code | Text | Derived | Party's Own Party code |
| Material Type | Text | Derived | The item's Material type |
| Raw Item | Text | Input | Suggested: RM items of the Material Type |
| Item code | Text | Derived | The item's Item Code |
| Raw material Lot No | Text | Derived | `Own Party code & Item code & PR Number` (no separators). If it collides with an existing lot, error: "! Please Change 4 Digit PR Num Manually or Generate New PR Num!" |
| Quantity | Number | Input | |
| Unit | Enum (Kg, Litre, Pcs) | Input | |
| Rate (₹) | Money | Input | 🔒 viewMoney. Flag if blank or ≤ 0. |
| Density | Decimal(3) | Input | |
| No. of Drum | Number | Input | |
| In LItre | Decimal(2) | Derived | `ROUND(Unit = Kg ? Quantity ÷ Density : Quantity)` |
| Liter per Rate | Money | Derived | `Unit = Kg ? Rate × Density : Rate` (rate per litre). 🔒 viewMoney. |
| Feed adjusted litre | Decimal(2) | Input | Litres lost or adjusted |
| available Litres | Decimal(2) | Derived | `ROUND(In LItre − Feed adjusted litre)`. **This quantity is posted to stock.** |
| GST % | Percent | Default 18% | 🔒 viewMoney |
| Sub total | Money | Derived | `Quantity × Rate` 🔒 |
| GST Amount | Money | Derived | `Sub total × GST %` 🔒 |
| Amount + GST | Money | Derived | `GST Amount + Sub total` 🔒 |
| Feed adjusted amount | Money | Input | 🔒 |
| Final amount | Money | Derived | `ROUND(Amount + GST − Feed adjusted amount)` 🔒 |
| Company Name | Enum (Mahek Marketing India, MYLAC) | Default Mahek Marketing India | 🔒 |
| Status | Enum | Input | 🔒. A holder of `erp.purchase.verify` may set only **Purchase Verified**. Everyone else may set **Invoice Received** or **Purchase Matched**. |
| Bill Received | Text (Received / Bill Not Received) | Actions | 🔒 |
| Notes | Long text | Input | |
| Wt With Drum | Number | Input | |
| Bill Number | Text | Input | Supplier bill number |
| Pr num Bill no | Text | Derived | `PR Number & " " & Bill Number & " " & Purchase Date as dd-mmm-yy` |
| User Name | Text | Derived | Current user |
| Timestamp | DateTime | Stamp | |
| Testing ID | Text | Copied | From the test |
| Remark | Long text | Input | |
| Location | Godown | Input | Valid: godown list (active, no loss) |
| Item Name | Text | Derived | Short label name: Toulene → "Stoving", Acetone Mix → "Acet Mix", Acetone → "Acet". Otherwise Raw Item. (Mapping is an editable list.) |
| This Bill Final Amount | Number | Derived | `ROUND(Σ Amount + GST − Σ Feed adjusted amount)` over all rows with the same PR Number 🔒 |
| Qty in Liter Per Drum | Decimal(2) | Derived | `available Litres ÷ No. of Drum` |
| Total Verified Item | Number | Derived | Never shown in the source. Not carried (§14 A-07). |

**Actions**
- **Bill Received:** available when Bill Received is "Bill Not Received" or blank. Sets Received. Bulk.
- **Bill Not Received:** available when Received. Sets "Bill Not Received". Bulk.
- **Change Purchase Status:** prompts for a status (limited as in the Status rule). Bulk.
- **Do Pending** (needs `erp.purchase.reopen`): available when status is
  Verified or blank. Sets status "Pending" (§14 A-08). Bulk.
- **Post to inventory** (source "Purchase to inventory"; automatic, §6.2).
  Condition: rate > 0 and not yet posted.
- **Add More:** copy the row as a new lot on the same PR.
- **Select Purchase:** select every row with this PR Number.
- **Download:** export the list as CSV.
- Add, Edit, Delete, view party.

List: grouped by Purchase Date descending then PR Number descending, with the
group showing the average bill final amount. Columns as in the source (PR Bill
no, Date, P.O., Party, Bill Number, Item, Quantity, Rate, Density, Unit, Drums,
Feed adj. amount, Wt with drum, In litre, Litre rate, Feed adj. litre,
Available litres, Location, GST %, GST amt, Sub total, Amount + GST, Final
amount, Company, Status, Bill received, Notes, Material type, PR/Bill label,
Remark). Money columns follow `erp.purchase.viewMoney`.

### 5.6 Purchase Barcode (label export)

- Rows: Purchase Register rows where Material Type = Chemical **and** Location =
  the user's working location. Read-only.
- Columns: Purchase Date, Raw material Lot No, Item Name, In Litre, No. of
  Drum, Location, Density, Quantity, Unit, Remark, PR Bill no (plus Qty in
  Liter Per Drum, PR Number and Testing ID in the export).
- Sorted by Purchase Date descending. **Download** exports CSV for the label
  printer.

---

## 6. Inventory model and Raw-Material Inventory (M04)

### 6.1 How stock works (applies to all four stages)

Every stage has an **inventory log**: one entry per inflow of stock to a
lot at a godown. Each entry is created by a source document and carries that
document's id as its Inventory ID. It also carries an **Inventory Type** that
says where it came from:

| Stage | Inflow entries (Inventory Type ← source document) | Unit |
|---|---|---|
| RM (Purchase inventory) | `Purchase` ← Purchase Register row · `Transfer` ← Item Transfer (type Purchase) | litres (chemicals), pcs (cans, boxes, stationery) |
| SFG | `Semi Finished` ← each Semi Finished line · `Transfer` ← Item Transfer (type Semi Finished) | litres |
| FG | `Finish Goods` ← Finished Goods record · `Transfer` ← Item Transfer (type Finish Goods) | cans |
| FG Packing | `FG Packing` ← FG Packing line of a complete batch · `Transfer` ← Item Transfer (type FG Packing) | boxes |

**Outflows are never entries.** They are read from the documents that consume
stock:

| Stage | Outflows subtracted |
|---|---|
| RM | Item Transfer out (type Purchase, from this godown, this lot) · SFG consumption (Semi Finished `Total use incl batch`, this godown, this lot) |
| SFG | Item Transfer out (type Semi Finished) · FG filling (`Use quantity in Liter`, this godown, this SFG lot) |
| FG | Item Transfer out (type Finish Goods) · FG Packing (`No. Of Can`, this godown, this FG lot) · Batch Code allocations (`Quantity`, this godown, Lot Code = this FG lot) |
| FG Packing | Item Transfer out (type FG Packing) · Batch Code allocations (`Quantity`, this godown, Lot Code = this batch) |

**Current Stock Lot Wise** (per lot × godown) = Σ inflow entries for that lot
at that godown − Σ outflows for that lot at that godown. The FG Packing
exception is in §9.3.

**Available views** show, for each lot × godown with Current Stock > 0, the
**latest** entry only (the source's "last row per lot and godown" slice), so
each lot appears once.

**Log views** show every entry. An entry whose source document no longer exists
is flagged **Deleted Warning** (source rule on Purchase inventory; the ERP
applies it to all four logs).

**Posting rules (ERP):** posting happens automatically when the source
document is saved and meets the posting condition. It is **idempotent**: one
entry per source document id. A document that did not qualify when first
saved (e.g. a purchase with no rate) posts when it later qualifies, and each
record also offers a manual "Post to inventory" while unposted. An entry
reflects its source document: editing the document's quantity, lot, godown or
item updates the entry, because the source reads these as live formulas on the
purchase log. Deleting a posted source document is admin-only and leaves the
entry flagged Deleted Warning.

Every stock-reducing form also validates **at save time** against current stock
(the source's validations), so stock cannot go below zero through normal use.

### 6.2 RM inventory entry fields (source "Purchase inventory")

| Field | Rule |
|---|---|
| Inventory ID | Source document id (PR Bill no, or Transfer ID) |
| Date | Purchase Date, or Transfer Date |
| Raw item | From Purchase (Raw Item), or from Transfer (Item Name) |
| Raw material Lot No | From Purchase (lot no), or from Transfer (Item Lot No.) |
| Quantity | From Purchase (**available Litres**), or from Transfer (Transfer Quantity) |
| Location | From Purchase (Location), or from Transfer (**To Location**) |
| Rate | `any(Purchase.Liter per Rate where lot = this lot)` 🔒cost |
| Amount | `Rate × Quantity` 🔒cost |
| Inventory Type | `Purchase` or `Transfer` |
| Timestamp | posting time |
| Current Stock Lot Wise | §6.1 |

- Add is not offered from the log or its group screen (source rule). Entries
  come only from posting.
- **Available RM Stock:** columns Raw item, Current Stock, Lot No, Location,
  Inventory ID. Grouped by Location (count), sorted by item then stock
  descending.
- **RM Inventory Log:** newest first.
- Raw-material totals across all godowns: see Raw Materials → Total Stocks (§4.1).

---

## 7. Semi-Finished Production and Inventory (M05)

### 7.1 SFG batch (source "Semi Finished")

One **batch** = one SFG No. It has **one line per raw-material lot** consumed.
The first line is entered, then "ADD More SFG" copies it (keeping SFG No, date,
godown, product and number of batches) to add the next lot.

| Field | Type | Kind | Rule |
|---|---|---|---|
| Semi finish ID | Text | System, key | `SFG-…` |
| Date | Date | Default | Today |
| SFG No | Number | Default | §1.3 |
| Location | Godown | Input | Valid: godown list (active, no loss) |
| SFG Product Name | Text | Input | Valid: SFG Product Names in Products |
| Number of Batch | Decimal(2) | Input | |
| Raw material Item Name | Text | Input | Valid: RM items with a lot of stock > 0 at this godown, **excluding** items of material type Can |
| Raw material Lot No. | Text | Input | Valid: lots of that item at this godown with stock > 0 |
| QTY Available in Litre | Decimal(2) | Derived | Current stock of the lot at this godown − Σ `Total use incl batch` of other lines of the same batch (same SFG lot code) on this lot (§14 A-09) |
| QTY in Litre use | Decimal(2) | Input | Quantity per batch. Cleared if the item is changed to one not already on this batch. |
| Total use incl batch | Number | Derived | `Number of Batch × QTY in Litre use`. **Valid if ≤ QTY Available in Litre**, error "Low Stock!" |
| Purchase Rate | Money | Derived | Litre rate of the lot (`Purchase.Liter per Rate`) 🔒cost |
| Litres Adjusted | Decimal(2) | Input | Loss or adjustment in litres |
| Available SFG in Litres | Decimal(2) | Derived | `Number of Batch × QTY in Litre use − Litres Adjusted` |
| Semi Product Lot code | Text | Derived | For the batch's first line: `SFG No & Raw material Lot No.` Later lines copy the batch's code. |
| Purchase Costing | Money | Derived | `Purchase Rate × Total use incl batch` 🔒cost |
| Test (SFG rate) | Decimal(2) | Derived | `Σ Purchase Costing ÷ Σ Total use incl batch` over the batch 🔒cost |
| User Name | Text | Default | Current user |

**Posting (source "SFG to SFG inventory"):** each line posts one SFG inventory
entry: Inventory ID = Semi finish ID, Type = Semi Finished, Date, SFG Product
Name, Semi Product Lot code, **Quantity = Total use incl batch − Litres
Adjusted**, Location. Once per line.

Actions: Add, Edit, Delete, **ADD More SFG** (copy), **Select SFG** (select all
lines with this SFG No), post (automatic, plus manual retry).

List: grouped by Location, Date descending, SFG No descending, with the group
showing total Total use incl batch. Columns: SFG No, Semi finish ID, product,
batches, RM item, lot, qty/batch, total use, date, purchase rate, purchase
costing, location, litres adjusted, lot code, SFG rate, user.

### 7.2 SFG inventory entry (source "Semi Finished Inventory")

| Field | Rule |
|---|---|
| Inventory ID | Semi finish ID, or Transfer ID |
| Date, SFG Product Name, Semi Product Lot code, Quantity, Location | From the posting |
| SFG Rate | `Σ SemiFinished.Purchase Costing ÷ Σ SemiFinished.Total use incl batch` for this lot code 🔒cost |
| SFG Costing | `SFG Rate × Quantity` 🔒cost |
| Remark | Input |
| Inventory Type | `Semi Finished` / `Transfer` |
| Timestamp | posting time |
| Current Stock Lot Wise | §6.1 |
| SFG Costing-Slice | `Current Stock (lot, godown) × SFG Rate` (value of stock) 🔒cost |
| No. of Batch | Number of Batch of the source line (blank for transfers) |
| Batch Size | `Σ Total use incl batch for the lot code ÷ No. of Batch` |

- **Available SFG Stock:** Date, product, current stock, lot code, location,
  batch size, type, SFG rate, stock value, id, batches. Grouped by Location then
  lot code. **Download SFG** exports it.
- **SFG Inventory Log:** grouped by Location, Date descending, product, with
  the group showing average SFG rate. Newest first.

---

## 8. Finished Goods Filling and Inventory (M06)

### 8.1 FG filling record (source "Finished Goods")

One record fills cans (or drums) of **one FG product** from **one SFG lot**.
Records with the same FG Num belong to one filling run ("Select SFG 2" selects
them).

| Field | Type | Kind | Rule |
|---|---|---|---|
| Finished ID | Text | System, key | `FINI …` |
| Date | Date | Default | Today |
| FG Num | Number | Default | §1.3 |
| Location | Godown | Input | Valid: all godowns (active not required in the source, §14 A-10), no loss |
| SFG Product Name | Text | Input | Valid: SFG products with a lot of stock > 0 at this godown |
| Semi Product Lot Codes. | Text | Input | Valid: SFG lots of that product at this godown with stock > 0 |
| SFG QTY Available in Litre | Number | Derived | Current SFG stock of that lot at this godown |
| FG Product Name | Text | Input | Valid: FG Product Names in Products whose SFG Product Name = this SFG product |
| Can Size | Decimal(2) | Default | Products.Liter Per Can for the FG product. Valid: one of those values. |
| Can Use | Text | Default | Products.Can Use for (FG product, can size). Valid: one of those values. |
| Available Packing Quantity | Number | Derived | RM Levels.Raw Item Available for (godown, item = Can Use) (§10.2) |
| Can size Quantity | Number | Input | **Number of cans or drums filled** |
| Use quantity in Liter | Decimal(2) | Derived | `Can Size × Can size Quantity` |
| Can Adjusted | Number | Input | Cans lost or adjusted |
| FG Can Available | Number | Derived | `Can size Quantity − Can Adjusted` |
| Finished Lot Code | Text | Derived | `"FG" & FG Num & UPPER(LEFT(Location, 2))` |
| Packing Type | Enum (Can, Drum, Naket) | Default | Material type of the Can Use item |
| Packing Rate | Money | Derived | Can or Drum → Price of the Can Use item in Raw Materials. Naket → 0. |
| FG COSTING | Money | Derived | `(SFG Rate of the lot × Use quantity in Liter) + (Can size Quantity × Packing Rate)` 🔒cost |
| User Name | Text | Default | Current user |
| Timestamp | DateTime | Stamp | |

**Validation of Can size Quantity** (on create; an existing record being edited
skips it, as in the source). All of these must hold:
`SFG QTY Available > 0`, `Use quantity ≤ SFG QTY Available`,
`Use quantity > 0`, `Available Packing Quantity > 0`. The error messages are:
- use quantity ≥ SFG available → **"Low SFG Stock"**
- use quantity < 1 → **"Minus Quantity Not Allowed"**
- packing available < 0 → **"Low Packing Quantity"**
(see §14 A-11 for the gap between the check and the messages)

**Posting (source "FG to FG inventory"):** one FG inventory entry per record:
Inventory ID = Finished ID, Type = Finish Goods, Date, FG Product Name, Finish
Lot Code = Finished Lot Code, **Quantity = Can size Quantity**, Location, Can
Use, Packing Type. Once per record (see §14 A-12 on Can Adjusted).

Actions: Add, Edit, Delete, **Select SFG 2** (select all with this FG Num),
post.

List: grouped by Location then Date (descending), sorted by FG Num descending.
Form order: Date, FG Num, Location, SFG product, SFG lot, SFG available, FG
product, can size, can use, packing available, cans, litres used, can
adjusted, cans available, lot code, costing, packing type.

### 8.2 FG inventory entry (source "Finish Goods Inventory")

| Field | Rule |
|---|---|
| Inventory ID | Finished ID, or Transfer ID |
| Date, FG Product Name, Finish Lot Code, Quantity (cans), Location, Packing Type, Can Use | From the posting |
| Rate | Packing Type = Can → `FG COSTING ÷ Can size Quantity` of the originating filling record (**per can**). Otherwise → `FG COSTING ÷ Use quantity in Liter` (**per litre**). 🔒cost |
| Amount | Can → `Rate × Quantity`. Otherwise → `Rate × Use quantity in Liter` of the origin. 🔒cost |
| Inventory Type | `Finish Goods` / `Transfer` |
| Description Of Goods | Filling entries: the **loose SKU** of this FG product with the same Can Use (cans per box = 1, boxes required = 0). Transfer entries: the description of any FG inventory entry for the same FG product. |
| Current Stock Lot Wise | §6.1 (cans) |
| Finish Goods Amount-Slice | `Current Stock × Rate` 🔒cost |

- **Available FG Stock:** latest entry per lot × godown with stock > 0.
- **FG Inventory Log:** grouped by Location, Date descending. Newest first.

---

## 9. FG Packing and Packing Inventory (M07)

### 9.1 Packing batch (source "FG Packing")

A **packing batch** (Batch No.) boxes a number of boxes of one **boxed SKU**.
It can draw cans from one or more FG lots: the first line is entered, then
"Add More" copies it (same Batch Serial, SKU and No. Of Box) to take the
remaining cans from another lot.

| Field | Type | Kind | Rule |
|---|---|---|---|
| FG Packing ID | Text | System, key | |
| Date | Date | Default | Today |
| Location | Godown | Default | GPS/working default. Valid: all godowns, no loss (§14 A-10). |
| FG Product Name | Text | Input | Suggested: FG products with FG stock > 0 at this godown |
| Description Of Goods | Text | Input | Valid: SKUs of this FG product with No. Of Empty Box Required > 0 (boxed SKUs) |
| No. Of Box | Number | Input | Boxes in the **whole batch** |
| Finish Lot Code | Text | Input | Suggested: FG lots of this product with stock > 0 |
| Available FG Quantity | Number | Derived | Current FG stock of that lot at this godown |
| No. Of Can | Number | Default | `No. Of Box × Cans Per Box of the SKU`. Cans taken **from this lot** on this line. On create it must be ≤ Available FG Quantity, error "Low Stock". |
| Batch Serial | Number | Default | §1.3 |
| Batch No. | Text | Derived | `"FP" & Batch Serial & UPPER(LEFT(Location,2))`. On create, `Remaining Batch Can ≥ No. Of Can` is required, error "You Cant Select More Than {Remaining} Can". |
| Total No. of Can | Number | Derived | `Cans Per Box × No. Of Box` |
| Remaining Batch Can | Number | Derived | `Total No. of Can − Σ No. Of Can of all lines of this batch (same SKU)` |
| Validation Match | Text | Derived | "Match" if Σ No. Of Can over the batch = Total No. of Can, otherwise "Not Match". A Not Match line is flagged on SKU, cans and batch no. |
| Box Type | Enum | Derived | SKU's Box Type |
| Total Empty Box Required | Number | Derived | `SKU's Empty Boxes Required × No. Of Box` |
| Box Amount | Money | Derived | `SKU's Empty Boxes Required × No. Of Box × SKU's Rate` |
| FG Packing Costing | Money | Derived | `(FG lot's Rate × No. Of Can) + Box Amount of the batch` 🔒cost (§14 A-13) |
| Remarks | Text | Input | |
| User Name | Text | Default | |
| Timestamp | DateTime | Stamp, read-only | |

**Posting (source "FG Packing to FG Packing inventory"):** allowed only when
the batch is **complete** (Σ No. Of Can of the batch = Total No. of Can). Each
line posts one entry: Inventory ID = FG Packing ID, Type = FG Packing, Date,
Description Of Goods, Batch No., **No. Of Box**, Location.

Actions: Add, Edit, Delete, **Add More** (copy), **Select Batch** (select all
lines of the batch), post.

List: grouped by Location and Date (descending, with count), sorted by lot code
descending, all columns.

### 9.2 Packing inventory entry (source "FG Packing Inventory")

| Field | Rule |
|---|---|
| Inventory ID | FG Packing ID, or Transfer ID |
| Date, Description Of Goods, Batch No., No. Of Box, Location | From the posting |
| Rate | `Σ FG Packing Costing of the batch ÷ Total No. of Can` (**per can**) 🔒cost |
| Amount | `Σ FG Packing Costing of the batch` 🔒cost |
| Inventory Type | `FG Packing` / `Transfer` |
| Current Stock Lot Wise | §9.3 (boxes) |

### 9.3 Packing stock rule

Several lines of one batch each post an entry carrying the **same** No. Of Box
(the batch total). Counting all of them would multiply the boxes, so:

- Inflow for (batch, godown) = if the entries are **Transfer** entries: the
  **sum** of their boxes. Otherwise: the boxes of **one** entry (the batch total).
- Current stock = that inflow − Σ transfers out (type FG Packing) − Σ batch-code
  allocations of this batch at this godown.

The source also computes a "Test Stock" variant. It is not shown in the ERP
(§14 A-14). The ERP stores a batch's box total once (§14 A-15).

- **Available Packing Stock:** Date, batch, SKU, current stock, rate, boxes,
  location, timestamp, amount. Grouped by SKU and Date, with the group showing
  total stock. Sorted by SKU.
- **Packing Inventory Log:** grouped by Location, Date and row, newest first.

---

## 10. Item Transfer (M08) and Re-Order (M09)

### 10.1 Item Transfer

| Field | Type | Kind | Rule |
|---|---|---|---|
| Transfer ID | Text | System, key | `TRF…` (hidden) |
| Transfer Date | Date | Default | Today |
| Item Type | Enum (Purchase, Semi Finished, Finish Goods, FG Packing) | Input | |
| From Location | Godown | Default | GPS/working default. Shown once Item Type is chosen. Valid: godown list (active, no loss). |
| Item Name | Text | Input | Shown once From is set. Valid by type: Purchase → RM items with stock > 0 at From. Semi Finished → SFG products with stock > 0 at From. Finish Goods → FG products with stock > 0 at From. FG Packing → SKUs with packing stock > 0 at From. |
| Item Lot No. | Text | Input | Shown once From is set. Valid by type: RM lots of the item at From with stock > 0 · SFG lot codes of the product at From with stock > 0 · FG lots of the product with stock > 0 · packing batches of the SKU with stock > 0 |
| Lot Code Available | Number | Derived | Current stock of that lot at From, for the type. Shown once a lot is chosen. |
| Transfer Quantity | Number | Input | Must be > 0 and ≤ Lot Code Available. Error "Select Correct Quantity!" |
| To Location | Godown | Input | Label "Transfer To Location". Shown once a quantity is entered. Valid: godown list (active, no loss) minus From. Error "You Selected The Same Location, Change To Location". |
| Remark | Long text | Input | |
| Timestamp | DateTime | Stamp | |
| User | Text | Default | Current user |

**Posting.** Saving shows the confirmation **"Transfer {Item Name} {Transfer
Quantity}"**. Once confirmed, one inflow entry is posted at the destination
stage:

| Item Type | Posts to | Entry fields |
|---|---|---|
| Purchase | RM inventory | Inventory ID = Transfer ID, Type = Transfer, Date = Transfer Date (item, lot, qty, location read from the transfer: To Location) |
| Semi Finished | SFG inventory | + SFG Product Name = Item Name, Quantity, Location = To, Semi Product Lot code = Item Lot No. |
| Finish Goods | FG inventory | + FG Product Name = Item Name, Quantity, Location = To, Finish Lot Code = Item Lot No. |
| FG Packing | Packing inventory | + Description Of Goods = Item Name, No. Of Box = Quantity, Location = To, Batch No. = Item Lot No. |

The source's outflow side is automatic: stock at From drops because the
transfer itself is subtracted (§6.1). Once per transfer.

**Lost stock.** Transferring **to Item Lost Record** writes stock off. It
needs `erp.stock.lostRecord`. Rows to or from it are flagged.

**List:** grouped by Transfer Date (descending) and From Location (count),
sorted by date and type. Today's transfers are flagged (date, from, item).
**Download** exports the list. Form order: Date, Type, From, Item, Lot,
Available, Quantity, To, Remark.

### 10.2 Raw-Material Levels (source "Raw Materials Minimum Quantity")

| Field | Type | Kind | Rule |
|---|---|---|---|
| RMMQID | Text | System, key | |
| Location | Godown | Input | Valid: all godowns except Item Lost Record |
| Material Type | Enum (material types) | Input | |
| Raw Item | Text | Input | Suggested: RM items of that type not already levelled at this godown. On create, (godown, item) must be unique, error "Duplicate Entry!" |
| Minimum Quantity | Number | Input | |
| Maximum Quantity | Number | Input | |
| status | Enum (Follow, UnFollow) | Input | |
| User ID | Text | Derived | Current user |
| Timestamp | DateTime | Derived | Last updated |
| Raw Item Available | Number | Derived | By material type (below) |
| Re-order % | Percent | Derived | `Raw Item Available ÷ ((Max + Min) ÷ 2) − 1` |
| Required Quantity | Number | Derived | Label "Required Quantity". `Max − Available` if > 0, otherwise blank. |

**Raw Item Available** by Material Type:
- **Chemical:** Σ current RM stock of all lots of the item at this godown.
- **Can:** Σ current RM stock of the item at this godown − Σ FG filling
  `Can size Quantity` where Can Use = item, Location = godown, Packing Type = Can.
- **Drum:** Σ Purchase `No. of Drum` (all purchases, all godowns) − Σ Order
  Details `Order qty No. Of can` where Type = Drum (§14 A-16).
- **Box:** Σ current RM stock of the item at this godown − Σ FG Packing
  `Total Empty Box Required` where Box Type = item, Location = godown.
- Other types: blank (§14 A-16).

List: columns Item, Required, Available, Re-order %, Min, Max, status,
Location. Grouped by Location and Material Type, sorted by Re-order %
ascending. Actions: Add, Edit, Delete, **Add More** (copy).

**Re-Order Raw Items:** rows with Required Quantity > 0 **and** status =
Follow. Columns: Item, Available, Min, Re-order %, Location, Type. Grouped by
Location and Type (count), sorted by Re-order % ascending.

### 10.3 FG Levels (source "Finish Goods Minimum Quantity")

| Field | Type | Kind | Rule |
|---|---|---|---|
| FGMQID | Text | System, key | |
| Location | Godown | Input | Valid: all godowns except Item Lost Record |
| Product Name | Text | Input | An SKU. Suggested: SKUs not yet levelled at this godown. Unique per godown on create, error "Duplicate Entry!" |
| Minimum Quantity | Number | Input | |
| Status | Enum (Follow, UnFollow) | Default Follow | |
| Product Type | Text | Derived | "Finish Goods Inventory" for a loose SKU, otherwise "FG Packing Inventory" |
| FG Available Quantity | Number | Derived | Loose: Σ current FG stock (cans) of entries whose Description Of Goods = SKU at this godown. Boxed: Σ current packing stock (boxes) of entries with this SKU at this godown. |
| Re-Order % | Percent | Derived | `Available ÷ Minimum` |

List: Product, Min, Available, Location, then others. Grouped by Location,
Status and Product Type, sorted by product. Actions: Add, Edit, Delete, **Add
More**.

**Re-Order Finish Goods:** rows with Minimum > Available **and** Status =
Follow. Columns: Re-Order %, Product, Available, Location, Type, Min. Grouped by
Location and Type (count), sorted by Re-Order % descending.

---

## 11. Sales Orders (M10) and Order Details (M11)

### 11.1 Order lifecycle

```
Taken Order line  (Status: Under Process ⇄ Ready …; Entry status: Not Done)
   │  allocate lots → Batch Codes until Can Quantity Verification = Done
   │  set Ready → Done (entry)  + Tally Bill No + Rate present
   ▼
"Add To Order Details"  →  Order Details line
   │  "Do Verified" (enter Dispatch Date) → Verified, Dispatched, stamped
   ├─► "Send To Transport Followup" → Transport Follow (1 per order number)
   └─► Order Follow-up record (1 per line)
```

### 11.2 Taken Order (order line)

Lines with the same **Order number** are one order. The first line is entered,
then "ADD More" copies it to add the next SKU.

| Field | Type | Kind | Rule |
|---|---|---|---|
| Order ID | Text | System, key | `ODID-XXXXXX` |
| Order number | Number | Default | §1.3. Not shown on the entry form. |
| Location | Godown | Input | Valid: godown list (active, no loss) |
| Date | Date | Default | Today |
| Billing Party Name | Ref → Sales Party | Input | |
| Delivery Party Name | Text | Default | Billing party. Valid: any Sales Party. |
| Standing Instructions | Text | Derived | `{party Standing Instructions} - {Delivery Type} - {Payment type} - {Weight type}` of the **delivery** party |
| Area | Enum | Derived | Delivery party's Area |
| Transporter name | Text | Default | Delivery party's Transport Detail |
| Description Of Goods | Text | Input | Valid: any SKU |
| Order Qty No. Of Can | Number | Input | Quantity in cans |
| Box Quantity | Decimal | Derived | Loose SKU → 0. Otherwise `Order Qty ÷ SKU Cans Per Box`. **Must be a whole number**, error "INVALID". Shown only when > 0. |
| Status | Enum (Under Process, Ready, Today, Delay, Cancel, Tomorrow, Hold From Office) | Default Under Process | |
| Rate | Text (money) | Default | Price-list rate: `PriceList.Rate where Pricelist Name = Tag Pricelist and Product Name = FG product of the SKU`. Editable. 🔒viewRate |
| Discount | Percent | Default | Same lookup, `Discount`. 🔒viewAmounts |
| Tally Bill No. | Text | Input | Entered by the office |
| Transportation Cost | Money | Input | |
| Remark | Long text | Input | |
| Entry status | Enum (Done, Not Done) | Default Not Done | Changed by actions. Not on the entry form. |
| Party Status | Text | Default | "Pending" if the billing party's status is Pending, otherwise blank. Set to "Approved By Admin" by action. Not on the entry form. |
| User Name | Text | Default | Current user. Not on the entry form. |
| Timpstamp | DateTime | Default | Now. Not on the entry form. |
| Weight | Decimal(2) | Derived | SKU's Weight |
| Tag Pricelist | Text | Derived | Billing party's Tag PriceList |
| Type | Text | Derived | SKU Box Type = "Empty Drum" → **Drum**. Box Type blank → **Can**. Box Type starts with "Empty Box" → **Box**. |
| No of Lable | Number | Derived | Type = Box → Box Quantity, otherwise Order Qty (cans). Whole number. |
| Can Quantity Verification | Text | Derived | Target = Box Quantity if Type = Box, otherwise Order Qty. Allocated = Σ Batch Code.Quantity for this Order ID. Equal → **Done**. Target < allocated → **Remove Some Quantity**. Target > allocated → **Add More Quantity**. |
| Rate 2 | Money | Derived | Live price-list rate (same lookup as the Rate default) 🔒viewRate |
| Related Order Details | List | Derived | Order Details for this Order ID. Shown when allocation = Done and Status = Ready. |
| Related Batch Codes | List | Derived | Batch Codes for this Order ID. Shown when Status = Ready. Add a Batch Code from here. |

**Entry form order:** Date, Order number, Location, Billing Party, Delivery
Party, Area, Transporter, Standing Instructions, SKU, Order Qty, Box
Quantity, Status, Remark, User, No of Label. The record header shows Delivery
Party and Standing Instructions.

**Actions**

| Action | Available when | Effect |
|---|---|---|
| **Ready** | Status ≠ Ready | Status = Ready (bulk) |
| **Under Process** | Status = Ready | Status = Under Process (bulk) |
| **Done** | Entry status Not Done or blank, **and** Status = Ready, **and** Can Quantity Verification = Done | Entry status = Done (bulk) |
| **Not Done** | Entry status Done or blank | Entry status = Not Done (bulk) |
| **Approved By Admin** | `erp.order.approveParty` **and** Party Status ≠ Approved By Admin | Party Status = Approved By Admin (bulk) |
| **Generate New Order Number** | always | Order number = next (bulk; applied to the selection as one new order, §14 A-17) |
| **ADD More** | always | Copy as a new line of the same order |
| **Select Order Number** | always | Select all lines of this order number |
| **Add To Order Details** | Not already in Order Details **and** Status = Ready **and** Tally Bill No. present **and** Rate present **and** Entry status = Done **and** Can Quantity Verification = Done | Creates the Order Details line (Order ID = this) (bulk) |
| **View customer** | billing party set | Opens the Sales Party |
| **Download Barcode** | (label list) | Export (§11.5) |
| Add / Edit / Delete | | |

**Flags on Taken Order**
- Status = Under Process → Status flagged "under process".
- Status = Ready, Entry Not Done, allocation = Add More Quantity → Status
  flagged "allocation pending".
- Status = Ready, Entry Not Done, allocation = Done → Status flagged "ready".
- Tally Bill No. **or** Rate blank → Date flagged "bill no / rate missing".
- Rate present → Order Qty, Rate and Discount emphasised.

### 11.3 Order lists

| List | Rows | Grouping / sorting | Allowed actions |
|---|---|---|---|
| **Taken Orders** | all | grouped by Order number (desc), group shows Σ labels; newest date first | all |
| **Pending Orders** | Status ≠ Cancel **and** SKU ≠ "Empty Drum" **and** Order number not in Order Details; updates only (no add) | grouped by Date then Order number (desc), group Σ labels | Edit, view customer, Done, Not Done, Ready, Under Process, Add To Order Details, Generate New Order Number, ADD More, Select Order Number |
| **Under Process / Ready** | (Status = Ready **or** Under Process) **and** Entry status = Not Done | grouped by Order number (desc), group Σ labels | same |
| **Batch Codes** | all allocations | grouped by Location and row, newest first; quick edit | |

### 11.4 Batch Code (lot allocation)

A Batch Code allocates stock of one lot to one order line. It is created from
the order line's Related Batch Codes (Order ID preset). **The Lot Code field
accepts a barcode scan.**

| Field | Type | Kind | Rule |
|---|---|---|---|
| ID | Text | System, key | |
| Order ID | Ref → Taken Order | Preset | |
| Description Of Goods | Text | Derived | Order line's SKU |
| Lot Code From | Enum (FG Packing Inventory, Finish Goods Inventory) | Derived | Loose SKU → **Finish Goods Inventory**, otherwise **FG Packing Inventory** |
| Lot Code | Text | Input (scannable) | Valid: from packing stock, batch numbers of this SKU at the order's godown with stock > 0. From FG stock, FG lots whose Description Of Goods = SKU at the order's godown with stock > 0. |
| Available Quantity | Number | Derived | Label "Available Box Quantity" (packing) or "Available Can Quantity" (FG). The lot's current stock at the order's godown. |
| Required Quantity | Number | Derived | Label "Required Box/Can Quantity". FG → Order Qty (cans) − Σ allocated for the order. Packing → Box Quantity − Σ allocated. |
| Quantity Verification | Number | Derived | `Available − Σ allocated from this lot to this order` (must be > 0) |
| Quantity | Number | Default = Required | Must be ≤ Required, ≤ Available and ≤ Quantity Verification. Error "Invalid Quantity Or Wait For Synchronization". |
| Costing | Money | Derived | FG → the lot's FG Rate (per can). Packing → the batch's packing Rate (per can). 🔒cost |
| Location | Text | Derived | Order line's godown |
| Timestamp | DateTime | Stamp | |

Form order: SKU, Required, Lot Code From, Lot Code, Available, Quantity,
Quantity Verification. See §14 A-18 on how "required" treats the row being
edited.

**Effect on stock:** a Batch Code reduces the lot's current stock immediately
(§6.1). Deleting it releases the stock.

### 11.5 Sales Label Printing

- Rows: same as Under Process / Ready. Read-only.
- Columns: Order ID, Order number, Date, Billing Party, Delivery Party, SKU,
  Order Qty, Type, Remark, Transporter, Area, No of Label, Status (plus Weight
  in the export).
- Grouped by Transporter, with the group showing **Σ No of Label**. Sorted by SKU.
- **Download Barcode** exports CSV for the label printer.

### 11.6 Order Details (billing and dispatch line)

Created only by "Add To Order Details". Everything from the order line is
**read live** from it.

| Field | Type | Kind | Rule |
|---|---|---|---|
| Order ID | Ref → Taken Order | key | Valid: Ready order lines not already in Order Details |
| Order Number | Number | Derived | Order line's Order number |
| Location, Order Date, Billing Party Name, Delivery Party Name, Description Of Goods, Order qty No. Of can, Standing Instructions, Rate, Area, Transport Name, Transportation Cost, Discount, Tally Bill No. | | Derived | From the order line |
| Quantity Dispatch in Liter | Number | Derived | `SKU Liter Per Can × Order qty` |
| Type | Enum (Drum, Can) | Derived | SKU Box Type = Empty Drum → Drum, otherwise Can |
| GST | Enum (18%, 0%) | Default 18% | Editable |
| Amount | Money | Derived | Drum → `Quantity Dispatch in Liter × Rate`. Otherwise `Order qty × Rate`. 🔒viewAmounts |
| Discounted Amount | Money | Derived | `Amount × Discount` 🔒viewAmounts |
| Final Amount | Money | Derived | `ROUND((Amount + Transportation Cost − Discounted Amount) × GST + (Amount − Discounted Amount + Transportation Cost))` 🔒viewAmounts |
| This Bill Final Amount | Money | Derived | Σ Final Amount of lines with the same Order Number and Billing Party 🔒viewAmounts |
| Company Name | Text | Derived | GST > 0 → **Mahek Marketing India**, otherwise **Mylac** |
| Extra Expenses | Money | Input (action) | Extra freight on paid-freight orders |
| Lotcode Costing | Money | Derived | Can → `average(Batch Code.Costing of the order) × Order qty + Extra Expenses`. Drum → `average(...) × Quantity Dispatch in Liter + Extra Expenses`. 🔒cost |
| Cost Price per Litre | Money | Derived | `Lotcode Costing ÷ Order qty` (cost per can despite the name) 🔒cost |
| Credit Note Amount | Money | Set by action | From the accepted customer request (§12.2) |
| Margine | Money | Derived | `Amount − Discounted Amount − Lotcode Costing − Credit Note Amount` 🔒cost |
| Dispatch Status | Enum (Dispatched, Pending) | Action | |
| Dispatched Stamp | DateTime | Action | |
| Dispatch Date | Date | Action (prompt) | |
| Verification | Text (Verified, Not Verify, Pending/blank) | Action | Blank → flagged "not verified" on Order Number, Date, Party |
| Order Fulfill Days | Number | Derived | Days between Order Date and Dispatch Date |
| Credit Days | Number | Derived | Billing party's Credit Days |
| Due Date | Date | Derived | `Dispatch Date + Credit Days` |
| Payment type | Text | Derived | Billing party's Payment type 🔒cost (admin in the source) |
| Delivery type, Weight type | Text | Derived | Billing party's (hidden in the source; kept for the transport list) |
| Segment Counter type | Text | Derived | `Delivery party Segment & " " & Counter type` |
| Sales Man | Text | Derived | Delivery party's Sales Person |
| Monthly Target | Money (0 dp) | Derived | Delivery party's Monthly Target |
| MonthID | Text | Derived | `Mon` + year of the Dispatch Date, e.g. "Aug2026" |
| Monthly Sale | Money | Derived | Σ Amount of lines with the same MonthID and Billing Party |
| Without GST | Money | Input | Kept as in the source (free entry) |
| Transport Follow up | Text | Input | Kept (see §12.1) |
| Year | Date | Default | Today |
| User Name, Timestamp | | Stamp | |
| Legacy hidden fields | | — | Order Party Code, Can Size., Finished Lot code., Available FG, Empty name, Empty Box type, Payment Status, Payment Received Date, Stage 1, Billing Status, Billing Stamp. Never shown in the source (always hidden). Kept as migrated data only, not on any screen (§14 A-19). |

**Actions**

| Action | Available when | Effect |
|---|---|---|
| **Do Verified** (label "Verified" once done) | Verification Pending or blank **and** the order has at least one Batch Code **and** the order line's allocation = Done | Prompts for **Dispatch Date**. Sets Verification = Verified, Dispatch Status = Dispatched, Dispatched Stamp = now, Dispatch Date. Bulk. |
| **Not Verify** | Verification ≠ Not Verify | Sets Not Verify (not shown on screens in the source; admin-only in the ERP) |
| **Send To Transport Followup** | Order Number not yet in Transport Follow **and** Verification = Verified **and** Transport Follow up blank | Creates the Transport Follow record (§12.1). Automatic on verification in the ERP (§18). |
| **Extra Expenses** | Extra Expenses blank | Prompts "Enter Extra Expenses" and sets it. Bulk. |
| **Credit Note Updater** | The order line's CN amount ≠ the accepted request's CN amount for (billing party, Tally bill no, SKU) | Copies the request's CN amount. Bulk. |
| **Select Order Number** | always | Select all lines of this order number |
| **Copy to follow-up** | automatic (§18) | Creates the Order Follow-up record |
| View order, Add, Edit, Delete | | |

**Flag:** "Sales target reached" on Monthly Sale when Monthly Sale > Monthly
Target (§14 A-20).

**List:** grouped by Order Date (desc) and Order Number, with the group
showing the average bill total. Sorted by Order Date then Timestamp (desc).
Columns: Transport Follow up, Order Date, Billing Party, SKU, Rate, Bill
total, Discount, Dispatch Date, Verification, Qty, Monthly Sale, Amount,
Standing Instructions, Discounted Amount, Order ID, Area, Transport Name,
Transport Cost, Extra Expenses, Tally Bill No., Payment type, Margin, MonthID.

---

## 12. Logistics (M12) and Customer Requests & Credit Notes (M13)

### 12.1 Transport Follow

One record per **order number** (i.e. per bill), created from its first
verified Order Details line.

| Field | Type | Kind | Rule |
|---|---|---|---|
| Transport ID | Text | key | The Order ID of the line that created it |
| Order No | Text | Copied | Order Number |
| Bill Date | Date | Copied | Dispatch Date |
| Billing Party Name | Text | Copied | |
| Bill No | Text | Copied | Tally Bill No. |
| Despatch LR No | Text | Input | Lorry receipt number |
| Transport Name | Text | Copied | |
| Area | Text | Copied | |
| Note | Long text | Input | |
| Payment Type | Enum (To Pay, Paid) | Copied | Customer's payment type |
| Extra Expence. | Money | Copied | Shown when Payment Type = Paid |
| Track Status | Enum (Track, Don't Track) | Default Don't Track | |
| Material Stage | Enum (Dispatch from Bhiwandi, Dispatch from Ambernath, In Transit, On the way to Destination area, Reached Destination Area, Close - Received to Party) | Default Dispatch from Bhiwandi | |
| Remainder call | Date | Input | Reminder date to call |
| Tag Sales Man | Text | Derived | Billing party's Tag Sales Person |
| Sales Person Name | List | Derived | Sales Person values of the billing party |
| MonthID | Text | Derived | `Mon` + year of Bill Date |
| Monthly Sales | Money | Derived | Σ Order Details.Amount for (MonthID, billing party) |

**Lists**
- **All Transport:** grouped by Bill Date (desc, count), sorted by Order No
  (desc). Columns: Order No, party, bill no, LR no, transporter, area, track
  status, payment type, extra expense, note, material stage, reminder call,
  sales people, tagged sales man, monthly sales.
- **Pending LR:** LR No blank. Editable. Grouped by transporter (count),
  newest bill first.
- **Track LR:** LR No present **and** Track Status = Track. Updates only.
  Grouped by transporter (count), newest bill first.
- **Transportation Paid** (rows are Order Details lines): billing party's
  Payment type = Paid **and** Extra Expenses blank. Columns: party, extra
  expenses, SKU, litres, payment type. Grouped by transporter with the group
  showing Σ Extra Expenses. Action: Extra Expenses (prompt).

### 12.2 Customer Request (source "Request Form")

| Field | Type | Kind | Rule |
|---|---|---|---|
| Timestamp | DateTime | key, Stamp | Raise time |
| Name of Salesman | Text | Default | If the user's Position = sales, the user's name. Valid: active employees with Position Type `office staff` or `sales`. |
| Company/Customer Name | Ref → Sales Party | Input | |
| Mobile Number | Phone | Default | Customer's Mobile No. (call / message) |
| Complain Type | Enum (reference list) | Input | |
| Complain Description | Text | Input | |
| Upload Complain Picture | Image | Input | |
| Required Credit Note | Enum (Yes, No) | Input | |
| Bill Number | Text | Default | Shown if CN = Yes. Suggested: Tally bill numbers of this customer's Order Details. Default: any of them. |
| Bill Date | Date | Default | Shown if CN = Yes. Dispatch Date of that bill. |
| Description Of Goods | Long text | Input | Valid: SKUs on that bill |
| Customer Request Status | Enum (Accepted, Rejected, Requested) | Default Requested | Hidden on the raise form. Changed by actions only. |
| Credit Note Amount | Money | Action | |
| Credit Note Amount (GST) | Money | Derived | `CN Amount × 1.18`. Shown if CN = Yes. |
| Credit Note Date | Date | Action | Hidden on the raise form |
| Credit Note Number | Number | Action | Hidden on the raise form |
| Remark | Text | Action | Hidden on the raise form |
| Upload Credit Note File | File | Action | Hidden on the raise form. Open action. |
| Responsible Employee | Text | Action | Valid: active employees |
| Approval Stamp | DateTime | Stamp | Set when accepted or rejected |
| Resolution stamp | DateTime | Stamp | Set when CN or complaint details are recorded |
| Response Time | Duration | Derived | `Resolution stamp − Timestamp` |
| Location | Text | Derived | Customer's Location |
| Month ID | Text | Derived | Timestamp as "MMM YYYY" |

**Raise form order:** Salesman, Customer, Location, Mobile, Complain Type,
Description, Picture, Required CN, Bill Number, Bill Date, Description Of
Goods, CN Amount, CN Amount (GST). The decision fields are hidden while
raising (§14 A-21).

**Actions**

| Action | Available when | Effect |
|---|---|---|
| **Accepted** | `erp.request.decide` **and** status ≠ Accepted | Status = Accepted, Approval Stamp = now. Bulk. |
| **Rejected** | `erp.request.decide` **and** status ≠ Rejected | Status = Rejected, Approval Stamp = now. Bulk. |
| **Issue Credit Note** (source "Admin Form CN") | Status = Accepted **and** Required CN = Yes | Prompts for CN Amount, CN Date, CN Number, Remark and CN File. Sets them and Resolution stamp = now. |
| **Resolve Complaint** (source "Admin Form Complain") | Status = Accepted **and** Required CN = No | Prompts for Remark and Responsible Employee. Sets them and Resolution stamp = now. |
| **Add More Credit** | always | Opens a new request pre-filled with Salesman, Customer, Complain Type, Description, Required CN, Bill Number, Bill Date (the Order Date of that bill) |
| Call / message customer, view customer, open CN file, Add, Edit, Delete | | |

**Flags:** Accepted, Rejected and Requested each flag Timestamp, Salesman,
Customer, Mobile and Complain Type distinctly.

**CN group lists**
- **Customer Request:** all, grouped by status, newest first.
- **Issue Credit Note:** Required CN = Yes. Updates only. Newest first.
- **Customer Complaint:** Required CN = No. Updates only. Grouped by Complain
  Type (count), newest first.
- **Pending CN:** Order Details lines where the accepted request's CN amount
  for the same (customer, bill no, SKU) differs from the line's Credit Note
  Amount. Updates only. Action: **Credit Note Updater**.

---

## 13. Order Follow-up, Expenses, My Customers, Help Videos, Settings, Dashboard

### 13.1 Order Follow-up

A record is created automatically per Order Details line (§18). Key: RowKey =
the Order ID, so each line is copied once.

| Field | Type | Kind | Rule |
|---|---|---|---|
| RowKey | Text | key | Order ID |
| Order Number | Text | Copied | |
| Order Date | Date | Copied | |
| Delivery Party Name | Text | Copied | |
| FG Product Name | Text | Copied | FG product of the SKU |
| Order qty No. Of can | Number | Copied | |
| Last Order Party Wise | Date | Derived | The delivery party's **previous** order date before this one (§14 A-22) |
| Last Order Day Count Party Wise | Number | Derived | `Order Date − Last Order Party Wise` in days (blank if none) |
| Reminder Days Party wise | Number | Input | |
| Last Order Product Wise | Date | Derived | The previous order date of the same party **and** FG product |
| Last Order Day Count Product Wise | Number | Derived | `Order Date − Last Order Product Wise` in days (§14 A-22) |
| Reminder Days Product Wise | Number | Input | |
| Remark | Long text | Input | |
| User Name, Timestamp | | Stamp | |
| Average Order Days | Number | Derived | Average of the party's Day Count Party Wise values that are > 0 |
| Next Upcoming Order | Date | Derived | If a previous order exists: `Order Date + Average Order Days` |
| Calling Date Party Wise | Date | Derived | `Next Upcoming Order + Reminder Days Party wise` |

List sorted by Order Date (desc). Columns: Order Date, day count, party,
calling date, next order, average, FG product, order number, id, qty, last
order (party), reminder days, last order (product), day count (product),
reminder (product), remark, user.

**Party Order Pivot (report):** per delivery party and order: **Last Order
Date** (the party's previous order date) and **Order Diff** (days since it).
It is derived from Order Follow-up. Actions: view and export only (§14 A-23).

### 13.2 Expenses (petty cash)

**Credit (funds given), source "Credit Expense"**

| Field | Type | Kind | Rule |
|---|---|---|---|
| Credit ID | Text | key | |
| Date | Date | Default | Today |
| Location | Godown | Default | Working location. Valid: all godowns. |
| Employee Name | Text | Default | Current user. Valid: active employees. |
| Credit Mode | Enum (Bank Cash, Cash, Other) | Input | Quick-editable |
| Credit Amount | Money | Input | |
| Credit Note | Enum (editable) | Input | Reference or remark for the credit |
| Appuser, Timestamp | | Stamp | |
| Available Amount | Money | Derived | Balance for (Employee Name, Location, Credit Mode) (§13.2.1) |

**Expenses**

| Field | Type | Kind | Rule |
|---|---|---|---|
| Expense ID | Text | key | |
| Date | Date | Default | Today |
| Location | Godown | Default | Working location |
| Expense By | Text | Default | Current user. Valid: active employees. |
| Category | Enum (editable) | Input | |
| Expense Mode | Enum (Bank Cash, Cash, Other) | Input | |
| Particular | Enum (editable) | Input | |
| Amount | Money | Input | Quick-editable |
| Expense Note | Long text | Input | |
| Status | Enum (Verify, Pending) | Default Pending | Quick-editable |
| Appuser | Text | Default | Current user |
| Timestamp | DateTime | Derived | Last updated |
| Available Amount | Money | Derived | Balance for (Expense By, Location, Expense Mode) |

#### 13.2.1 Balance rule

`Available Amount(employee, godown, mode) = Σ Credit Amount (employee, godown, mode) − Σ Expense Amount (Expense By = employee, godown, mode)`.
The same figure is shown on both screens (§14 A-24).

**Lists**
- **Expenses:** Date, Particular, Amount, Note, Available, Mode, Location,
  Status. Grouped by Location, Mode and row, with the group showing the average
  Available. Newest first. Record header shows Available and Mode.
- **Credit:** Date, Amount, Credit Note, Available, Employee, Location, ID.
  Grouped by Location and Mode, newest first. Record header shows Available and
  Mode.

### 13.3 My Customers (source "Edit Customer Details")

- Rows: Sales Parties whose **Tag Sales Person** = the current user. Updates
  only (no add or delete).
- Editable columns: Sales Party Name, GRADE, Area, Location, State, Transport
  Detail, Payment type, Delivery Type, Weight type, Mobile No., Whatsapp
  Contact, Party Email ID, Counter type, Monthly Target, Credit Days. Quick
  edit in the list.
- Shows the customer's Related Request Forms.

### 13.4 Help Videos

| Field | Type | Rule |
|---|---|---|
| VideoID | key | |
| Title | Text | |
| Video From | Enum (From YouTube URL, From File Upload) | |
| Video File | File | Shown if File Upload |
| Youtube URL | URL | Shown if YouTube |
| Search Tags | Multi-enum (editable) | |
| Description | Long text | |
| Thumbnail | Derived | Icon from the source type |
| Timestamp, UserID | Stamp | |
| Play Video / Youtube Player | Derived | Plays the file or the YouTube link inside the ERP |

List shows Title with Search Tags and Description, newest first, with a
search. The record shows Title, player, URL, Description and the rest.

### 13.5 Settings

Working location (§2.2), name, position.

### 13.6 ERP Dashboard metric definitions

Each tile links to the list filtered to exactly the rows counted. "Godown
filter" applies where marked (G).

| Tile | Definition |
|---|---|
| Requisitions by status | count Purchase Requisitions per Order Status ≠ Received (G) |
| Urgent open requisitions | Priority = Urgent, status ≠ Received (G) |
| Inward awaiting routing | Inward lines where (Testing Required = Yes and no Test) or (Testing Required = No and no Purchase) (G) |
| Tests awaiting verification | Tests with status ≠ Verified (G) |
| Purchases with missing rate | Rate blank or ≤ 0 (G) |
| Bills not received | Bill Received ≠ Received 🔒viewMoney |
| Purchases by status | count per Status 🔒viewMoney |
| Purchase value this month | Σ Final amount, Purchase Date in the current month 🔒viewMoney |
| Stock lots and quantity per stage | lots with current stock > 0 and Σ current stock, per stage (G) |
| Stock value per stage | Σ stock value: RM `stock × Rate`, SFG `SFG Costing-Slice`, FG `Finish Goods Amount-Slice`, packing `Rate × boxes × cans/box` 🔒cost (G) |
| Orphaned inventory entries | Log entries flagged Deleted Warning |
| Incomplete packing batches | Batches with Validation Match = Not Match (G) |
| Raw items to re-order | rows in Re-Order Raw Items (G) |
| Finished goods below minimum | rows in Re-Order Finish Goods (G) |
| Production today / month | SFG batches (distinct SFG No) and Σ SFG litres; FG records and Σ cans; packing batches and Σ boxes (G) |
| Transfers today | Transfers with today's date (G = From or To) |
| Lost this month | Transfers to Item Lost Record this month, by type 🔒lostRecord |
| Orders by status | distinct order lines per Status, excluding lines already in Order Details (G) |
| Allocation short | Ready, Entry Not Done, allocation = Add More Quantity |
| Awaiting "Done" | Ready, Entry Not Done, allocation = Done |
| Missing bill no / rate | Tally Bill No. or Rate blank, not cancelled |
| Pending-customer orders | Party Status = Pending 🔒approveParty |
| Labels to print | Σ No of Label in Sales Label Printing (G) |
| Awaiting dispatch verification | Order Details with Verification blank or Pending (G) |
| Dispatched today / month | Verified with Dispatch Date today / this month (G) |
| Sales value this month | Σ Amount (and Σ Final Amount), Dispatch Date this month 🔒viewAmounts |
| Margin this month | Σ Margine, Dispatch Date this month 🔒cost |
| Paid freight without extra expense | rows in Transportation Paid |
| Pending LR | rows in Pending LR |
| Tracking by stage | Track LR rows per Material Stage |
| Reminder calls due | Transport Follow with Remainder call ≤ today and stage ≠ Close - Received to Party |
| Requests by status | Customer Requests per status |
| Credit notes to issue | Accepted, CN = Yes, no CN Number |
| Credit notes pending sync | rows in Pending CN |
| Average response time (month) | mean Response Time of requests resolved this month |
| Follow-up calls | Calling Date Party Wise = today / < today / next 7 days (latest record per party only) |
| Petty-cash balance | Available Amount per godown × mode (current user's own, or everyone with Expenses screen access) |
| Expenses pending verification | Expenses with Status = Pending |
| Customers pending activation | Sales Parties with Party Status = Pending 🔒setStatus |
| My customers vs target | For the current user's tagged customers: this month's Monthly Sale vs Monthly Target |

---

## 14. Source anomalies and ERP decisions (for client sign-off)

Each item states what the source does, what it evidently intends, and what
the ERP will do. Items marked **⚑** change a visible behaviour and need an
explicit yes from the client (PRD Q6).

| # | Where | Source behaviour | ERP decision |
|---|---|---|---|
| A-01 | PR Number | Inward and Purchase each compute MAX+1 over their own table | One PR series shared by both. A manual purchase row draws from it. |
| A-02 | "User"/"Tester Name"/"User Name"/"User ID" fields defined as formulas of the *current* user (Purchase Party, Purchase, Purchase Test, Order Follow-up, RM Levels) | They show whoever is viewing, not who entered | Stamped with the creator. The audit trail keeps editors. |
| A-03 ⚑ | Sales Party "Do Pending Party" | Shown when status ≠ Deactive (cannot pend a deactivated party; can re-pend a pending one) | Shown when status ≠ Pending |
| A-04 | Requisition Present Quantity | Read only from level tables, so blank when no level row exists | Same, and the field says "no level set for this godown" |
| A-05 ⚑ | Requisition form | Lists "Quotation Party" and "PO (Tally)", which do not exist in the data | Not built unless the client confirms (PRD Q8) |
| A-06 ⚑ | Test "Do Not Verified" after a verify | Status reverts but the created purchase row stays | Same, with a warning that a register row exists. The verifier decides whether to delete it. |
| A-07 | Purchase "Total Verified Item" | Hidden everywhere, unused | Not carried |
| A-08 | Purchase "Do Pending" | Sets "Pending", which is not an allowed status | "Pending" is added as a status value |
| A-09 ⚑ | SFG "QTY Available in Litre" | Lot stock (already net of every SFG use) minus this batch's use again, so a batch's own consumption is counted twice | Available = lot's current stock, not counting this line's own consumption |
| A-10 | FG filling and FG Packing godown choice | All godowns, including inactive ones | Active godowns only, as on every other form |
| A-11 ⚑ | FG "Can size Quantity" messages | Checks (`>0`, `≤ SFG available`, `packing > 0`) and messages (`≥`, `<1`, `<0`) disagree, so some failures show no message | Each failed check shows its own message: insufficient SFG → "Low SFG Stock"; ≤ 0 → "Minus Quantity Not Allowed"; no packing stock → "Low Packing Quantity" |
| A-12 ⚑ | FG posting | Posts `Can size Quantity`, ignoring `Can Adjusted`, whereas SFG posts net of `Litres Adjusted` | Posts `FG Can Available` (net of adjustment) |
| A-13 ⚑ | FG Packing costing | Every line of a batch adds the **whole** batch's box amount, so a two-line batch costs its boxes twice | Box amount is apportioned across the batch's lines by cans |
| A-14 | Packing "Test Stock" | Experimental duplicate of stock | Not carried |
| A-15 | Packing posting | One entry per batch line, each with the batch's total boxes | New batches post one entry per batch. Migrated multi-entry batches are read with the §9.3 rule. |
| A-16 ⚑ | RM Levels availability | Drum = company-wide drums received − drums sold (not per godown). Other types (e.g. Stationary) have no formula. | Drum kept company-wide as in the source. Other types use the Chemical rule (Σ lot stock at the godown). |
| A-17 ⚑ | "Generate New Order Number" (bulk) | Evaluated row by row, so each selected line may get a different number | The whole selection gets one new order number |
| A-18 | Batch Code "Required"/"Quantity Verification" | Include the row being edited, so an edit is refused | Exclude the row being edited |
| A-19 | Order Details hidden columns | 11 columns always hidden | Kept as migrated data only |
| A-20 ⚑ | "Sales Target" flag | Condition "Monthly Sale > Target **and** Monthly Sale is blank" can never be true | Flag when Monthly Sale ≥ Monthly Target (target > 0) |
| A-21 ⚑ | Request Form views "raise customer request" and "Sales By Complaint_Form" | Referenced by visibility rules but absent | The ERP's raise form hides the decision fields. Separate forms only if the client confirms (Q8). |
| A-22 ⚑ | Order Follow-up | Party-wise takes the previous order by row position. Product-wise takes the *current* order (so its gap is 0), and its day-count field is typed Date with default today. | Both take the previous order by Order Date, and both day counts are numbers of days |
| A-23 | Party Order Pivot | Spreadsheet formulas and four unnamed header columns | Rebuilt as a report from Order Follow-up |
| A-24 ⚑ | Credit Expense "Available Amount" | Filters expenses by a field "Employee Name" that expenses do not have, so expenses are never subtracted there | Uses Expense By, identical to the Expenses screen |
| A-25 | RM inventory Location | Enum limited to Ambernath, Bhiwandi | Any godown |
| A-26 | Transport Material Stage | Two stages name godowns (Bhiwandi, Ambernath) | Kept as fixed values per the source. Adding a godown does not add a stage unless the client asks. |
| A-27 | Requisition initial status | "Pending", not in its list | "Pending" added to the list |
| A-28 | Taken Order Rate | Stored as text | Stored as money |
| A-29 ⚑ | Raw Materials "Total Stocks" | Σ purchase Quantity (purchase unit, may be kg) − Σ SFG use (litres) | Σ current RM stock of the item across godowns (litres or pcs) |
| A-30 ⚑ | Packing-material consumption | Cans used in filling and boxes used in packing reduce "available" only in RM Levels, not the RM lot stock | Same as the source. Can and box lot stock is shown with a note that filling and packing consumption is reflected in RM Levels. Open for the client to decide whether it should reduce lot stock. |
| A-31 | Hard-coded emails and "admin" role | Special powers tied to three addresses | Capabilities (PRD §5.4) |
| A-32 | `@(_FILL)` date on Sales Party | Copies the previous row's date | Today |
| A-33 | Timestamps defined as NOW() formulas (Expenses, RM Levels) | Change on every edit | Kept as "last updated". The creation time is also kept. |

---

## 15. Source views → ERP screens

Every source table has list, record (detail) and form screens. The named source
views map as follows. System-generated `_Detail`, `_Form` and `_Inline` views
become the record, form and related-list parts of each screen.

| Source view (type) | ERP screen |
|---|---|
| Master Dashboard (dashboard: Raw Materials, Purchase Party, My Products, Sales Party, Location Registration, Pricelist, Employee Details) | M02 group |
| Purchase Dashboard (Purchase Order, Purchase Inward, Purchase Test, Purchase, Purchase Barcode) | M03 group |
| Purchase Inventory Dashboard (Purchase, Available Purchase Inventory, Purchase inventory Log) | M04 group (the register is linked) |
| Semi Finished Inventory Dashboard (Semi Finished, Log, Available) | M05 group |
| Finish Goods Inventory Dashboard (Finished Goods, Log, Available) | M06 group |
| FG Packing Inventory Dashboard (FG Packing, Log, Available) | M07 group |
| Re-Order Dashbord (Re-Order Raw Items, Re-Order Finish Goods, RM Levels, FG Levels) | M09 group |
| Sales Dashboard (Taken Order, Order Details, Batch Code, Under process / Ready Orders, Take orders Pending) | M10 group (+ M11) |
| Logistic Dashboard (TRANSPORT ALL LIST, Pending LR, Track LR, Transportation Paid) | M12 group |
| CN Dashboard (Customer Request, Issue Credit Note, Customer Complaint, Pending CN) | M13 group |
| Item transfer | M08 |
| Download For Sales Label Printing | M10 → Sales Label Printing |
| Order Followup; Party Order Pivot (detail/form) | M14 |
| Expenses; Credit Expense; Expence_Detail/Form | M15 |
| Edit Customer Details | M16 |
| Helpful Video (deck) | M17 |
| Employee Details (deck, admin) | M02 → Employees |
| Settings (form) | Settings |
| Assistant (search) | Global search within the ERP |
| Recieved Purchase_Detail/Form, Purchase Inventory slice_Detail, Purchase inventory_Form, *_Inline | Record, form and related-list parts of the screens above |

## 16. Source actions → ERP actions

**Generic actions present on every table** (Add, Edit, Delete) are kept on
every ERP entity. Delete is restricted (hidden in menus in the source) and
always confirmed. Contact actions (Call, Message, Email, Map, Open file, Open
URL, View referenced record) are kept on every field the source attaches
them to:

| Entity | Contact / navigation actions |
|---|---|
| Purchase Party | Call and message Mobile and WhatsApp; email Party Email |
| Sales Party | Call and message Mobile and WhatsApp; email Party Email ID and allocate |
| Godown | Call and message Phone; email Email ID; map Address and Latlong |
| Employee | Call and message Personal Mobile and Emergency contact; email Email; map Address and Permanent Address |
| Request Form | Call and message Mobile Number; open CN file; view customer |
| Raw Materials | Email User ID |
| Help Video | Open URL; open file; email UserID |
| Purchase Test | Open test video |
| Purchase | View party |
| Taken Order | View billing party |
| Order Details, Batch Code | View order |

**Business actions** (all defined in the sections cited):

| Source action | Entity | ERP section |
|---|---|---|
| ADD More Lot | Purchase Test | §5.4 |
| Bill Received / Bill Not Received / Do Pending / Change Purchase Status / Download / Add More / Select Purchase / Purchase to inventory | Purchase | §5.5 |
| Purchase Inward To Test / Send To Purchase / Add More 6 / Select PR Number | Purchase Inward | §5.3 |
| Verified / Do Verify / Test To Purchase / Do Not Verified | Purchase Test | §5.4 |
| ADD More Lot 2 (ADD More SFG) / SFG to SFG inventory / Select SFG | Semi Finished | §7.1 |
| Download 2 (Download SFG) | SFG inventory | §7.2 |
| FG to FG inventory / Select SFG 2 | Finished Goods | §8.1 |
| Add More 4 / FG Packing to FG Packing inventory / Select Batch | FG Packing | §9.1 |
| Transfer to Purchase / Semi Finished / Finished Goods / FG Packing inventory / Download 3 | Item Transfer | §10.1 |
| Add More 2 / Add More 3 | RM Levels / FG Levels | §10.2, §10.3 |
| ADD More Item | My Products | §4.3 |
| Add More 5 | Pricelist | §4.6 |
| Do Active / Do Deactive / Do Pending Party | Sales Party | §4.4 |
| Permissions | Employee Details | §4.7 (becomes "Manage ERP access") |
| Ready / Under Process / Done / Not Done / Approved By Admin / Generate New Order Number / ADD More Lot 3 / Select Order No. / Add To Order Details / Download Barcode | Taken Order | §11.2, §11.5 |
| Verified 2 (Do Verified) / Not Verify / Send To Transport Followup / Extra Expenses / Credit Note Updater / Select Order Number / Copy Orders | Order Details | §11.6, §18 |
| Accepted / Rejected / Admin Form CN / Admin Form Complain / Add More Credit | Request Form | §12.2 |

## 17. Flags (source format rules)

Each flag is a named state. How it is shown is a design decision.

| Flag | Entity | Condition | Fields flagged |
|---|---|---|---|
| Lost-stock godown | Godown | Godown Name = Item Lost Record | Godown Name |
| Lost-stock transfer | Item Transfer | From or To = Item Lost Record | From, To |
| Empty rate | Purchase | Rate blank or ≤ 0 | PR Number, Date, Rate |
| Batch incomplete | FG Packing | Validation Match = Not Match | SKU, No. Of Can, Batch No. |
| Deleted warning | RM inventory (all logs in the ERP) | Source document no longer exists | Inventory ID, Date, Item |
| Inactive employee | Employee | Status = Inactive | Name |
| Under process | Taken Order | Status = Under Process | Status |
| Allocation pending | Taken Order | Ready, Entry Not Done, allocation = Add More Quantity | Status |
| Missing bill no / rate | Taken Order | Tally Bill No. or Rate blank | Date |
| Ready | Taken Order | Ready, Entry Not Done, allocation = Done | Status |
| Not verified | Order Details | Verification blank | Order Number, Date, Billing Party |
| Sales target reached | Order Details | §14 A-20 | Monthly Sale |
| Rate present | Taken Order | Rate present | Order Qty, Rate, Discount |
| Transferred today | Item Transfer | Transfer Date = today | Date, From, Item |
| Order placed | Purchase Requisition | Status = Order Placed | Date, Type, Item, Unit, Required, Status |
| Booked | Purchase Requisition | Status = Booked | same |
| CN accepted / rejected / requested | Request Form | Status = Accepted / Rejected / Requested | Timestamp, Salesman, Customer, Mobile, Complain Type |

## 18. Automations

The source has AppSheet bots ("process" tables) and manual buttons that post
records onward. In the ERP each becomes an automatic, idempotent step that
runs in the same transaction as the save that qualifies it:

| Source bot / action | Trigger in the ERP | Effect |
|---|---|---|
| Process for Purchase to Purchase inventory ("Copy & Send") | Purchase saved with Rate > 0 and not posted | RM inventory entry (§6.2) |
| Process for Purchase Transfer to Purchase inventory | Transfer of type Purchase confirmed | RM inventory entry at To |
| Process for SFG Transfer to SFG inventory ("Move From Transfer to Semi Finished Inventory") | Transfer of type Semi Finished confirmed | SFG inventory entry at To |
| Process for FG Transfer to FG inventory ("Move on Finish goods inventory") | Transfer of type Finish Goods confirmed | FG inventory entry at To |
| Process for FG Store Transfer to FG inventory Packing ("Send to Fg Packing inventory") | Transfer of type FG Packing confirmed | Packing inventory entry at To |
| SFG to SFG inventory (manual in the source) | Semi Finished line saved | SFG inventory entry |
| FG to FG inventory (manual in the source) | Finished Goods saved | FG inventory entry |
| FG Packing to FG Packing inventory (manual in the source) | Batch becomes complete | Packing inventory entry |
| Process for Orders to order followup ("Copy Paste Auto" / Copy Orders) | Order Details line created (PRD Q5) | Order Follow-up record (§13.1) |
| Send To Transport Followup (manual in the source) | Order Details line verified, and its order number has no transport record | Transport Follow (§12.1) |

Routing steps that need a person's decision stay manual, as in the source:
Send to Testing, Send to Purchase, Do Verify, Add To Order Details, Do
Verified, Credit Note Updater, Extra Expenses.

Each automatic step can be retried from its source record while it has not yet
produced its output, and a failure never loses the source record.
