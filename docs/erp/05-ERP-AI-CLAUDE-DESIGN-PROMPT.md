# Prompt for Claude Design — ERP AI features (addition to the existing ERP design)

> Copy everything below the line into Claude Design, together with the
> existing ERP designs. It describes **what** must be added and **how it
> behaves**. It says nothing about visual style, layout, colour, typography,
> components or branding. Those decisions belong to Claude Design, and the
> additions should sit naturally within the ERP design that already exists.

---

## Brief

The ERP designs for MahekOne are complete. We are adding eight AI features.
Please design the **new screens, panels, controls and states** they need, and
show where each one attaches to the existing screens. Full requirements are
in `04-ERP-AI-FEATURES-PRD.md`.

### Rules every AI element must make visible

1. **AI proposes, the person decides.** Every AI output arrives as a **draft**
   that is visibly different from saved data, and is saved only after an
   explicit accept. Design the three outcomes: **accept**, **edit then accept**,
   **reject**.
2. **Evidence beside the suggestion.** The source (bill image, original
   message, photo, the records an answer came from) sits next to what was
   extracted from it. Where possible, selecting a proposed value shows where it
   came from in the source.
3. **Confidence per field:** *high*, *check* (must be confirmed individually)
   and *not found* (left empty). Bulk "accept all" applies only to high.
4. **Flags** raised by the system's checks (e.g. "rate 18% above last
   purchase", "quantity differs from inward") appear on the line they concern,
   with the reason in words.
5. **States for every AI element:** idle, working (reading, listening,
   thinking), result, partial result, nothing found, error (with a retry), and
   **unavailable** (feature off, no provider, or monthly limit reached). In the
   unavailable state the manual screen must still work normally.
6. **Permissions:** a user without a power never sees rates, costs or margins
   anywhere, including inside AI answers, explanations and alerts. Design
   each of those with and without money visible.
7. Works at desktop, tablet and phone width. Photo capture uses the device
   camera where available, plus file upload.

---

## Designs needed

### AI-1 Supplier bill reading (Purchase Register)
- A **"Read supplier bill"** entry point on a Purchase Register row and on a
  PR number (all lines of that PR). It shows only to users who can see purchase
  money.
- **Upload / capture step:** one or more photos or a PDF. Show progress while
  it is being read.
- **Review screen:** the bill image (zoomable, multi-page) beside the
  proposed values: supplier (matched party, or "no match: pick"), bill number,
  bill date, and a table of bill lines each mapped to a register row. Each
  mapped row shows item, quantity, unit, rate, GST %, line total and
  confidence.
  - Lines on the bill with no matching inward line, and inward lines missing
    from the bill.
  - Flags: rate deviation vs last purchase, quantity mismatch, GST ≠ 18%,
    duplicate bill number, totals not adding up.
  - Actions: accept all high-confidence values; accept, edit or reject per field;
    propose a new register line for an unmatched bill line; cancel.
- **After accept:** the register rows show that they were filled from a bill
  (with the bill attached and viewable), and posting to stock follows as normal.

### AI-2 Orders from WhatsApp, pasted text and voice (Sales Orders)
- On the order form: **"Paste message"** and **"Speak order"** options.
- **Order inbox** screen: incoming WhatsApp messages detected as orders. Each
  shows sender, matched customer (or "unknown number"), time, message text,
  and status: New, Converted (links to the order), Not an order, Duplicate. It
  can be filtered and bulk-marked.
- **Draft order review:** the source message (with the original-language text
  available) beside the proposed order: customer, delivery party, and lines,
  each with the matched SKU, quantity in cans and boxes, and how the product
  was matched. Ambiguous products show choices. Pre-filled base defaults
  (godown, transporter, standing instructions, rate / discount if permitted).
  Actions: accept (creates one new order), edit line, remove line, add line,
  reject, mark not an order.
- The resulting order shows its source message.

### AI-3 Voice notes (every remark / note / description field)
- The same dictation experience MahekOne's CRM already has: a microphone in
  each long-text field, a listening state with pause and resume, a review panel
  showing the English text with the original-language transcript one click away,
  Add or Replace, optional Tighten and Rewrite, and undo. It is absent when
  dictation is unavailable, and a no-signal state appears on devices without
  a connection.
- Show it on one representative field per module (the full list of fields is in
  the PRD).

### AI-4 Unusual-activity alerts (Dashboard + Alerts screen)
- **Dashboard:** an alerts summary with open counts by kind, each opening the
  filtered Alerts screen. Also the **owner's daily summary**: a short written
  paragraph with the date it covers and links to what it mentions.
- **Alerts screen:** list of alerts with kind, the record(s) involved, the
  plain-English explanation, the figures behind it (e.g. "₹92/L vs usual ₹78/L,
  last 6 purchases"), godown, age and status. Filters by kind, status, godown
  and date. Actions: open record, **Acknowledge** (with a note), **Resolve**
  (with a reason), bulk acknowledge. Resolved-automatically state.
- Alert kinds to cover: purchase rate jump, rate missing too long, high SFG
  loss, high filling loss, repeated write-offs, negative or thin margin, slow
  fulfilment, ready but not billed, stuck work (test, LR, CN, packing batch),
  duplicate-looking expense, petty cash below zero, stock below re-order level.
- An alert badge on the records an open alert refers to.

### AI-5 Ask the ERP (global)
- An **ask** entry point available from every ERP screen (typed or spoken).
- **Answer panel:** the question as asked, a short answer, the figure(s), the
  list of records it came from (a few rows plus "open full list", which opens the
  matching ERP screen filtered), and "as of" time.
- States: answering; answer; answer partly hidden because of permissions
  (saying so); "I can't answer that from ERP data" with a suggested screen;
  ambiguous question with clarifying choices; unavailable.
- Recent questions and a few example questions for first use.
- It must be clear that this assistant only reads and navigates. It never changes data.

### AI-6 Complaint assistant and batch tracing (Customer Requests)
- On the **raise request** form: suggested Complain Type and one-line summary
  from the description or photo, each accepted or changed by the user.
- **Trace panel** on a request: the chain bill → order line → dispatched lots →
  FG lot or packing batch → filling record → SFG lot → raw-material lots →
  supplier and purchase test, each step linked. Partial chains are shown when a
  step is missing, saying which.
- **Trace a lot** entry point from any lot or batch screen, showing the same chain in both
  directions: where a lot came from, and which customers received it.
- **Decider view additions:** the customer's previous requests and outcomes;
  a **possible batch problem** notice listing other requests on the same lots;
  suggested responsible employee (marked as a suggestion); bill line amount as a
  reference for CN requests.

### AI-7 Suggested re-order levels and next-order prediction
- **RM Levels and FG Levels:** for each row, current min/max beside suggested
  min/max with the basis in words (usage per day, days of cover, lead time).
  Apply per row, apply selected, dismiss. Show the one-line explanation where
  recent use has shifted. Rows with no history say "not enough history".
- **Order Follow-up:** the CRM's predicted next-order date and its confidence
  beside the ERP's own next upcoming order and calling date, labelled as the
  CRM prediction the telecallers work from, with the disagreement visible when
  they differ.

### AI-8 Reading LR numbers and test readings from photos
- **Transport Follow and Pending LR:** "Photograph LR" gives the proposed
  LR number, transporter and date beside the photo. Flags: transporter mismatch,
  LR already used. Confirm fills Despatch LR No. The photo is kept and viewable
  on the record. On Pending LR, allow working down the list one LR after another.
- **Purchase Testing:** on the density and pH evidence fields, the photo gives
  a proposed reading (Density; new **PH Value** field) with confidence. The
  density check against the item's master density is shown. On the colour,
  paint and thermocol photos, a suggested written observation is offered for
  Remark. Verification remains a separate human action and must not look
  AI-driven.

### Admin (Admin Console → ERP AI)
- Per-feature on/off, monthly usage against its limit, and the "limit reached"
  state.
- Alert thresholds per kind, and daily summary recipients.
- A log of AI suggestions (feature, record, outcome, user, time) with filters,
  showing acceptance rate per feature.

---

## Flows to storyboard

1. Office user photographs a 2-page supplier bill for PR 1234 → reviews 5 lines,
   one flagged for a rate jump → edits one rate → accepts → rows filled, stock
   posts.
2. A customer's WhatsApp message "20 peti NC 1L, 5 drum stoving, kal bhejna"
   appears in the order inbox → matched to the customer → one ambiguous
   product resolved → accepted as a new order.
3. Godown staff dictates a transfer remark in Marathi, reviews the English and
   adds it.
4. Owner opens the dashboard → reads the daily summary → opens a "high filling
   loss" alert → acknowledges it with a note.
5. A sales person asks "which of my customers' orders are ready but not billed?"
   → gets the answer with the list and opens it.
6. A complaint on bill MMI/26-27/1119 → trace to SFG lot → notice that two other
   complaints touch the same SFG lot → decider accepts and assigns.
7. Store manager reviews suggested levels for cans at Bhiwandi and applies three.
8. Logistics works through Pending LR by photographing each LR in turn.

## Deliverables

Designs for every addition and state above, shown in place on the existing ERP
screens, at desktop, tablet and phone width, plus the eight storyboards. Name
each design with its feature ID (AI-1 … AI-8) and the screen it attaches to.
