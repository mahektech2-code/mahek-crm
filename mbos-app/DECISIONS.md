# The ten open decisions

Brief §11 says to proceed with the stated default and flag each. This is the
flag. Nothing here is settled — every one of them is a business decision that
somebody should confirm, and each says what happens if the answer is different.

---

## 1. Where an order's rate comes from — **already answered by MahekOne**

**Not an open question after all.** MahekOne had solved this before MBOS
existed: `products.priceSource` is a config setting with four values
(`unset` · `product` · `pricelist` · `manual`) and `canValueOrders()` refuses to
value anything while it reads `unset`.

MBOS **inherits** that rather than deciding again. `src/engines/order.ts` is a
verbatim port of `src/lib/catalogue.ts` L111-155, and the shipped default is
`unset` — so today every order is captured with quantities and **no value**, and
the screens say the value is not known rather than showing ₹0.

That last part is the point. Reaching for the packing cost because it is the
only number on the row would put believable wrong figures on every target,
incentive and KPI screen in the app.

**What is still needed:** somebody sets `products.priceSource`. `mbos_price_list`
exists and is empty; `checkConsistency` refuses `pricelist` until it has rows.
Until then order valuation, target achievement, KPI sales value and incentive
are all unavailable **by design, and say so**.

## 2. Health score composition — implemented as proposed, unsigned-off

Seven components exactly as §4.4 lists them, weights in config
(`mbos.health.weights`, normalised at use), and `healthScore()` returns the
**breakdown with a sentence per component**, not just a number.

The breakdown is not decoration. A bare 41 that nobody can explain is ignored
within a fortnight; a 41 that says "44 days since the last order against a
normal cycle of 18" is actionable.

**Needs sign-off before it is trusted.** The weights are a guess at what the
business believes and are the easiest thing in the app to change.

## 3. Who confirms a cash deposit — **both, in two steps**

The salesman records the deposit with photographic proof; the back office
confirms it against the bank statement. `payments.deposited` /
`depositedAt` / `depositProofId` is the first half, and the server owns the
second.

The server half had nowhere to land until `0053_receipt_cash_deposit` —
`payment_receipts` now carries `deposited_at`, `deposited_by_id` and
`deposit_proof_id`, and the handset's deposit reaches them. It is deliberately
NOT a confirmation: `status` still moves to `confirmed` only when accounts find
the money on the statement, every money path in MahekOne keys on that, and so
the column moved no figure on any screen the day it arrived.

Either half alone leaves a gap somebody reconciles from memory later. Cash in
hand is a real personal liability for the person carrying it, so it is worth
two steps.

## 4. Offline login validity — **7 days, configurable**

`mbos.sync.offlineLoginValidityDays`. Beyond it, signal is required.

Without a window, an employee terminated on Monday keeps working out of the
cache indefinitely — which makes the Active check the whole login flow performs
pointless. Longer is more convenient in a bad-coverage territory and is a
straight security trade; it is one setting.

## 5. One customer table — **yes, and it is done**

MBOS extends MahekOne's `customers` with GPS, beat, credit limit, potential and
health. It does **not** have its own. The CRM's calling attributes and MBOS's
field attributes are columns on one row.

Same for products (the existing four-level catalogue, orders attach at SKU) and
for attachments (the existing subsystem — MBOS is attachment-heavy and builds
none of its own).

`timeline_events` is new and shared: both apps write it, which is what makes a
telecaller's call from yesterday visible to the salesman walking in today.
**The CRM does not write to it yet** — that backfill is outstanding, and until
it happens an MBOS timeline shows only MBOS events.

## 6. WhatsApp Business API — **assumed not live**

MBOS inherits the CRM's manual copy-to-send mode. Receipts and messages are
prepared for the salesman to send from his own WhatsApp, and a message is only
recorded as sent when a human confirms it.

If the API is live, this becomes a config flip plus a send path — the records
are already shaped for it.

## 7. Customer GPS coordinates — **assumed mostly missing**

`customersWithoutGps()` exists and is countable, because the brief requires
those to be surfaced. Route optimisation appends unlocated stops at the end and
flags them rather than dropping them, and `visitLocationVerdict` treats a
customer with no coordinate as "cannot tell", never as a mismatch.

**If most of the book is missing coordinates, capturing them is an early field
task, not a background nicety** — every visit is an opportunity to record one.

## 8. Attendance, leave, salary, expenses — **built in MBOS, on tables a future HR app can adopt**

They serve every employee, not just field sales, so building them here means
rebuilding them later. Against that: the field team needs them now and there is
no HR app.

The compromise is that the data does not assume MBOS. `mbos_attendance_days` is
deliberately **not** the existing `attendance` table — AGENTS.md is explicit
that one is a sign-in log and a misnomer, and that real attendance is a
check-in system that was never built. This is that system, and a future HR app
takes the table rather than migrating off it.

**Salary is read-only** and no MBOS table holds pay. It reads what payroll
publishes.

## 9. A server-rejected order — **notification AND a task**

Both. The notification is immediate; the task is what survives being missed.

The salesman stood in the shop and told the customer the order was placed. A
bell he swipes away on a bus does not discharge that. `/rejections` is the
review screen, the record is retained, and a rejected order additionally raises
a High task against that customer to ring them back.

## 10. Territory model — **region › area › beat**

Three levels, stored as three columns on the customer (`territoryRegion`,
`area`, `beat`). Scope resolution uses the existing MahekOne `access-control`
ladder rather than a second hierarchy.

The SRS uses all three words; this is the reading that makes them nest.

---

# Where the design and the brief disagreed

Flagged rather than resolved silently, as the brief asks.

1. **The design values orders from a fixture rate.** The brief says the rate
   source is unresolved and blocks valuation. **The brief wins** — the fixture
   rate is gone, and the order screen says the value is not known while
   `priceSource` is `unset`.
2. **The design has no rejection review screen.** The brief says one is needed
   and does not design it. Built at `/rejections`, in the design's own
   vocabulary — no new components, no new colours.
3. **The design's visit checklist blocks the save button.** The brief says a
   visit must always be savable. Both are honoured: the primary button gates on
   the checks, and the dashed override below it saves unverified with a required
   reason. That was already the design's intent; it is now also the rule.
4. **The design's `slHistory` is defined twice**, the second overwriting the
   first and breaking the salary month picker. Took the first.
5. **The design's salary query sheet has no opener** bound in the markup.
   Payslip rows open it.
6. **The design's expense calendar computes its 30-day floor with
   `toISOString()`**, which answers in UTC. Uses a local calendar date — the
   same bug MahekOne's own `AGENTS.md` has a grep test for.
