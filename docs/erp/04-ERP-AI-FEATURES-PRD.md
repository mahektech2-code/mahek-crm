# MahekOne ERP — AI Features (PRD addendum)

| | |
|---|---|
| Extends | `01-ERP-PRD.md` and `02-ERP-FUNCTIONAL-SPEC.md` |
| Design brief | `05-ERP-AI-CLAUDE-DESIGN-PROMPT.md` |
| Status | Approved for scope by the client: features AI-1 to AI-8 |

These eight features are the only AI additions to the ERP. They sit on top of
the base ERP. Every base screen and rule works exactly as specified whether or
not any AI feature is switched on.

| # | Feature | Where it lives |
|---|---|---|
| AI-1 | Supplier bill reading | Purchase Register |
| AI-2 | Orders from WhatsApp, pasted text and voice | Sales Orders |
| AI-3 | Voice notes in any language | Every remark, note and description field |
| AI-4 | Unusual-activity alerts | ERP Dashboard and an Alerts screen |
| AI-5 | Ask the ERP | Global search / assistant |
| AI-6 | Complaint assistant and batch tracing | Customer Requests & Credit Notes |
| AI-7 | Suggested re-order levels and next-order prediction | Re-Order, Order Follow-up |
| AI-8 | Reading LR numbers and test readings from photos | Logistics, Purchase Testing |

---

## 1. Principles that apply to every AI feature

1. **AI drafts, a person decides.** No AI output is written to a record, stock
   or money field until a person has seen it and pressed accept. It is the rule
   MahekOne's dictation already follows: nothing arrives in a field unseen.
2. **Show the evidence beside the suggestion.** Each extracted value is shown
   next to its source: the bill image, the original message, the photo, or the
   list of records an answer was computed from. A suggestion nobody can check
   is one nobody should trust.
3. **Say how sure it is, and when it cannot tell.** Every extracted field
   carries a confidence (high / check / not found). "Not found" leaves the field
   empty rather than guessing. Low-confidence fields must be confirmed one by
   one; they cannot be accepted in bulk with the rest.
4. **Deterministic where a rule can do it.** Matching, stock checks,
   calculations, anomaly detection and batch tracing are ordinary code, the same
   rules as the base ERP. AI is used only for reading (images, free text, speech)
   and for writing (summaries, explanations, answers in plain language).
5. **Permissions follow the person.** An AI feature never shows or uses data
   the user could not see on the normal screen. Rates, costs and margins stay
   behind their capabilities (`erp.purchase.viewMoney`, `erp.cost.view`,
   `erp.sales.viewRate`, `erp.sales.viewAmounts`), including inside AI answers,
   explanations and exports.
6. **Switched on per feature, and absent when unavailable.** Each feature has
   its own on/off setting (`erp.ai.<feature>.enabled`). With the feature off,
   with no provider key, or with the provider failing, the AI controls do not
   appear or say plainly that they are unavailable, and the manual screen works
   as normal. A failed AI call never blocks or loses a save.
7. **Every suggestion is logged.** Log what was suggested, what the person
   accepted, edited or rejected, who did it and when (`erp_ai_suggestions`). This is the
   audit trail and also the only honest measure of whether a feature is
   working.
8. **Providers and keys are MahekOne's existing ones.** Speech uses the
   dictation stack (Sarvam first, OpenAI fallback). Reading and writing use the
   configured writing and vision models. Keys are set in Admin Console →
   secrets, never in code. Monthly usage is shown there, and each feature has a
   monthly call cap (`erp.ai.<feature>.monthlyCap`). Past the cap the feature
   goes quiet and says so.
9. **Media is kept only where the base ERP keeps it.** A bill image and an LR
   or test photo are attachments of the record they fill (new attachment parents,
   with the same access rules as their record). Voice audio is never stored. A
   pasted message is kept on the draft order as its source text.
10. **Languages.** Input may be English, Hindi, Marathi or Gujarati, or a mix
    of them. Stored text is English, with the original available where the
    feature says so.

---

## 2. AI-1 Supplier bill reading

**Who:** holders of Purchase Register access **and** `erp.purchase.viewMoney`
(the feature fills rates).

**Entry points:** on a Purchase Register row, or on a PR number ("read bill for
PR 1234"). Upload one or more photos or a PDF of the supplier's bill.

**What the AI reads:** supplier name and GSTIN, bill number, bill date, and for
each item line the item description, quantity, unit, rate, GST %, taxable
amount and line total. It also reads the bill total, and freight or other
charges if printed.

**What the system then does (deterministic):**
- Matches the supplier to a Purchase Party by GSTIN, then by name. If there is
  no match, it says so; it never creates a party.
- Matches each bill line to a Raw Material by name, code and the party's
  purchase history, and to the PR's inward or register lines of the same item.
- Proposes values for the matching register rows: Bill Number, Purchase Date,
  Rate (₹), Unit, GST %, Quantity. A PR with no register row yet for an item
  gets a proposed new row (the "Add More" copy).
- **Checks and flags** (each shown against its line):
  - bill quantity differs from the inward quantity (after unit conversion) by
    more than `erp.ai.bill.qtyTolerancePct`;
  - rate differs from this supplier's last rate for the item by more than
    `erp.ai.bill.rateDeviationPct`;
  - GST % differs from the default 18%;
  - the bill number was already used for this supplier;
  - Σ line totals ≠ bill total;
  - an item on the bill has no inward line in this PR, or the reverse.

**Person's decision:** a review screen with the bill image beside the proposed
values. The person can accept all high-confidence values, accept field by
field, edit or reject. Accepting writes the values through the normal register
save, so every base rule applies (for example, a rate above zero triggers
posting to stock). The bill image is attached to the register rows of that PR.

**Done when:** a typical two-page bill of five lines is read and proposed in
under 30 seconds, and ≥ 90% of fields are accepted without edit on a
month of real bills.

---

## 3. AI-2 Orders from WhatsApp, pasted text and voice

**Who:** Taken Order access.

**Inputs:**
1. **Paste** a customer's message (any of the supported languages, shorthand
   such as "20 peti NC 1L, 5 drum Stoving").
2. **Speak** the order (uses the AI-3 hearing stack).
3. **Order inbox:** inbound WhatsApp messages that MahekOne already receives
   through its WhatsApp account are screened. Those that look like an order are
   listed in an **Order inbox**, with the sender matched to a Sales Party by the
   Mobile No. or WhatsApp number on the party record.

**What the AI reads:** the customer (if named), each product mention, quantity
and unit ("peti" / box, can, drum, litre), the delivery party if different,
transporter or remark, and requested date words ("today", "kal").

**What the system then does (deterministic):**
- Customer: by sender number, then by name. If there is no match, the user picks.
- Product: resolves each mention to an SKU (Description Of Goods) using the
  product search (misspellings tolerated) plus the customer's past orders.
  Where several SKUs fit, it shows the choices and never picks one silently.
- Quantity: converts to **Order Qty No. Of Can** using the SKU's cans per box
  and litres per can. Box quantity must be a whole number (the base rule).
- Everything else comes from the base Taken Order defaults: godown (working
  location), delivery party, transporter, standing instructions, rate and
  discount from the price list, status Under Process.

**Person's decision:** the draft order lines are shown beside the source
message. Each line shows the matched SKU, how it was matched and the confidence.
The person accepts, which creates the Taken Order lines under one new order
number through the normal save, or edits or rejects. An inbox message is
marked **Converted** (linked to the order), **Not an order**, or **Duplicate**.
Nothing is sent back to the customer by this feature.

**Done when:** ≥ 80% of real order messages produce draft lines needing no
product correction, and no order is ever created without a person accepting it.

---

## 4. AI-3 Voice notes in any language

**Who:** everyone, on every long-text field.

**Where:** a microphone on every remark, note and description field. That
includes Purchase Requisition Remarks, Inward Remark, Test Remark, Purchase
Notes and Remark, Item Transfer Remark, Taken Order Remark, Transport Note,
Complaint Description, Request Remark, Order Follow-up Remark, Expense Note,
Help Video Description and the Godown Remark.

**Behaviour:** identical to MahekOne's existing dictation (`VoiceTextarea`).
The person speaks in any language and sees the faithful English (with the
original-language transcript one click away) before anything is inserted.
They choose Add or Replace. Optional Tighten and Rewrite are available. Audio is
never stored. The microphone is not drawn when dictation is off or has no
provider.

**Done when:** every listed field carries the microphone and behaves exactly
as the CRM's.

---

## 5. AI-4 Unusual-activity alerts

**Who:** managers and holders of the relevant screens. Money- and cost-based
alerts need the matching capability.

**How it works:** a scheduled job (hourly, plus a nightly full pass) runs
**deterministic** checks against each item's own history. AI writes only the
one-line explanation in plain English. An alert names the records behind it
and links to them.

| Alert | Rule (every threshold is configuration) |
|---|---|
| Purchase rate jump | Rate per litre for (item, supplier) differs from the median of its last `n` purchases by > `x`% 🔒viewMoney |
| Rate missing too long | Register row with no rate for > `d` days after purchase date |
| High SFG loss | Litres Adjusted ÷ Total use on a batch > `x`% or > item's usual + `k`σ |
| High filling loss | Can Adjusted ÷ cans filled > `x`% |
| Repeated write-offs | Transfers to Item Lost Record by the same person or from the same godown > `n` in `d` days, or quantity > `q` 🔒lostRecord |
| Negative or thin margin | Order Details Margine < 0, or margin % < `x` 🔒cost |
| Slow fulfilment | Order Fulfill Days > customer's usual + `k`σ, or > `d` days |
| Ready but not billed | Order Ready + allocation Done, with no Tally bill no after `h` hours |
| Stuck work | Test unverified > `h` hours · LR missing > `d` days after dispatch · CN accepted and not issued > `d` days · incomplete packing batch > `d` days |
| Duplicate-looking expense | Same person, amount and particular within `d` days |
| Petty cash below zero | Available Amount < 0 for any employee × godown × mode |
| Stock below re-order level | Rows newly entering the re-order lists |

**Lifecycle:** each alert is **Open → Acknowledged (with a note) → Resolved**
(automatically when its condition clears, or manually with a reason). The same
condition on the same record never raises two open alerts. The Dashboard shows
open alert counts by kind, and an **Alerts** screen lists them with filters.

**Owner's summary (daily):** an AI-written paragraph of the previous day's open
alerts and headline figures, shown on the Dashboard. It can optionally be sent to
named people on WhatsApp (`erp.ai.alerts.digestRecipients`). It contains only
figures the recipient may see.

---

## 6. AI-5 Ask the ERP

**Who:** every ERP user. Answers are scoped to what that user can open.

**What it does:** the person types or speaks a question in any supported
language, for example "how many 1L NC thinner boxes are at Bhiwandi?", "which
orders are ready but not billed?", "what did we pay Shree Chemicals for
toluene last time?", "show SFG batch 412's cost". The answer is a short
sentence, the figure, and **the list of records it came from**, with a link that
opens the matching filtered ERP screen.

**How it works:** the AI does not run free database queries. It chooses from
a fixed set of **question tools** that call the ERP's own services, the same
functions the screens use:

- stock by item, lot and godown at any stage
- orders by status
- order details by customer and period
- purchases by item and supplier
- batch trace (AI-6)
- re-order lists
- follow-ups due
- transport by stage
- requests by status
- expenses balance

Each tool enforces the user's modules and capabilities before returning
anything. Where no tool fits, or the question is ambiguous, it says so and
suggests the screen to use. It never invents a figure. Every answer shows the
time the data was read.

**Scope limit:** answering and navigating only. It cannot create, edit or
approve anything.

---

## 7. AI-6 Complaint assistant and batch tracing

**Who:** Customer Requests users. Deciders see the same assistance.

**On raising a request:** from the description (typed or spoken) and the
photo, the AI suggests the **Complain Type** and a one-line **summary**. The
person confirms or changes them. In the base form, Bill Number and Description
Of Goods are already suggested from the customer's bills.

**Batch trace (deterministic):** for a request naming a bill and goods, the
system shows the chain:
bill → Order Details line → Batch Codes (lots dispatched) → FG lot / packing
batch → FG filling record → SFG lot → RM lots → supplier and purchase test.
This appears as a **Trace** panel on the request, also available on its own
("trace this lot") from any lot screen.

**For the decider:** the request shows
- the customer's previous requests and their outcomes;
- other open or recent requests touching the **same lots or the same SFG/RM
  lot**, as a "possible batch problem" notice when their count reaches
  `erp.ai.complaints.clusterThreshold` within `d` days;
- a suggested responsible employee, taken from who handled the traced
  production or dispatch steps (a suggestion only);
- for CN requests, the bill line's amount as a reference. The AI never
  proposes a credit-note amount.

**Done when:** the trace for any dispatched line opens in under 3 seconds, and
cluster notices fire on a seeded test of three complaints on one SFG lot.

---

## 8. AI-7 Suggested re-order levels and next-order prediction

**Suggested levels (RM and FG Levels screens):**
- **Raw materials:** average daily consumption at the godown (SFG use for
  chemicals; filling use for cans; packing use for boxes) over the last
  `erp.ai.reorder.lookbackDays`. This is multiplied by the cover days
  (`erp.ai.reorder.minCoverDays`, `maxCoverDays`) and rounded to the item's
  purchase pack. Lead time is measured from requisition Order Placed → Received
  in the audit history, where available, and shown with the suggestion.
- **Finished goods:** average daily dispatch per SKU at the godown (Batch Code
  quantities of verified orders) × cover days.
- Each row shows **current min/max, suggested min/max, and the basis** (for
  example "used 42 L/day over 90 days; 10 days' cover"). The person applies
  suggestions one by one or in bulk. Nothing changes until applied. Seasonal
  swings are explained by the AI in one line when recent use differs sharply
  from the lookback average.

**Next-order prediction (Order Follow-up):** the prediction comes from
**MahekOne CRM's existing buying-cycle engine**, which already measures each
customer's reorder cycle and puts them on the telecallers' Call Log. It is not a
second model. ERP dispatches (verified Order Details) feed that engine.
Order Follow-up shows the CRM's predicted next-order date and its confidence
beside the base fields (average order days, next upcoming order, calling
date). Where the two disagree, the CRM figure is labelled as the one the
telecallers are working from.

---

## 9. AI-8 Reading LR numbers and test readings from photos

**LR photo (Logistics):** on a Transport Follow record, or on the Pending LR
list, photograph the lorry receipt. The AI reads the LR number, transporter
name and date. The system checks that the transporter matches the record's
Transport Name (flagged if not) and that the LR number is not already used.
The person confirms, and Despatch LR No is filled through the normal save. The
photo is attached to the transport record.

**Test photos (Purchase Testing):**
- **Density:** the photo of the density meter or hydrometer gives a proposed
  **Density** value. The system flags it when it differs from the raw
  material's master density by more than `erp.ai.qc.densityTolerancePct`.
- **pH:** the pH photo gives a proposed pH reading, stored in a new optional
  field **PH Value** beside PH Image (the only field added by this addendum to
  a base table).
- **Colour / paints / thermocol photos:** the AI gives a short written
  observation ("uniform film, no patches visible") as a suggestion for the Remark,
  never a pass/fail.
- Verification stays with the CEO (`erp.qc.verify`). The AI never sets
  Verification Status.

---

## 10. Data additions

| Addition | Purpose |
|---|---|
| `erp_ai_suggestions` | One row per AI suggestion: feature, record, input reference, proposed values, confidence, outcome (accepted / edited / rejected), user, time |
| `erp_order_inbox` | Inbound order-like messages: sender, matched party, text, status (New / Converted / Not an order / Duplicate), linked order number |
| `erp_alerts` | Alert kind, record references, rule values, explanation, status (Open / Acknowledged / Resolved), notes, times |
| Attachment parents | Supplier bill (Purchase PR), LR photo (Transport Follow) |
| `PH Value` on Purchase Test | AI-8 |
| Configuration (`erp.ai.*`) | On/off per feature, thresholds, caps, recipients, cover days, look-back |

---

## 11. Rollout order

1. **AI-3** voice notes (reuses what exists) and **AI-4** alerts (mostly
   deterministic).
2. **AI-1** bill reading and **AI-8** photo reading (same vision pipeline).
3. **AI-2** orders (paste and voice first, then the WhatsApp inbox).
4. **AI-6** trace and complaint assistant, then **AI-7** suggestions.
5. **AI-5** Ask the ERP, last, because it reuses the question tools the others
   build.

## 12. Open questions

1. Who receives the owner's daily summary on WhatsApp?
2. Initial thresholds for each alert (the defaults will be proposed from a
   month of migrated data for sign-off).
3. Which WhatsApp number(s) feed the order inbox: the main business number
   only, or sales people's numbers too?
4. Monthly AI budget per feature.
