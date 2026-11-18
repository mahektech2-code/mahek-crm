# Material returns

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**FINANCIAL DOCUMENTS ADJUST THE LEDGER; PHYSICAL TRANSACTIONS ADJUST STOCK.**
The ERP's Material returns group is two screens: Vendor returns (Purchase
returns · Debit notes · Return outward) and Customer returns (Returns ·
Quarantine & QC · Rework · Waste disposal). Rules are pure in
`engines/returns.ts`; reads in `lib/erp/returns.ts`; screens in
`screens/returns.ts`. A debit note or a credit note never moves stock.

**A RETURN NAMES ITS ORIGINAL.** A purchase return is raised against a GRN
lot (`erp_purchases`) and refused past what the lot received less earlier
returns, or past what is still on a shelf. A customer return is raised against
a dispatched `erp_batch_codes` row (the line and the lot that left) and
refused past what was sent less what is already back. Both are approved by
somebody other than their raiser (`returnApprove`), and above
`erp.returns.ownerApprovalPaise` an ERP administrator approves second
(`approvalRefusal`).

**VENDOR: APPROVAL ISSUES THE DEBIT NOTE, THE OUTWARD MOVES THE STOCK.** The
last approval writes `erp_debit_notes` at the lot's CURRENT rate and GST, in
the same transaction. `syncPurchasePayouts` nets issued debit notes off the
PR's unpaid payout. A goods return outward is prepared at a godown and changes
nothing until it is confirmed; `rmLots` then counts a CONFIRMED
`erp_return_outwards` row as an outflow of its lot, after locking the lot under
both spellings (`rm`, `Purchase`) and refusing a shortfall. A confirmed outward
is reversed (marked cancelled, stock back), never deleted.

**CUSTOMER: RECEIVED INTO QUARANTINE, OUT OF SALEABLE STOCK.** Quarantine is a
state on the return, not a ledger: the returned boxes/cans are `returned` in
`erp_units`, which dispatch already refuses. The credit note is the Accounts
one: the approval raises a complaint (`createComplaint`, `requestCn`,
`cn_amount` the return's value) and Accounts issue it with `issueCreditNote`.
QC (`returnQc`) splits what is left in quarantine across decisions
(`erp_return_dispositions`), each posting into an EXISTING ledger: reuse →
`erp_fg_entries`/`erp_pack_entries` on the SAME lot (`source_type 'return'`);
rework → `erp_rework_orders`, whose completion posts `erp_sfg_entries`
(`source_type 'rework'`) on lot `RW<n>` with an `erp_sfg_qc` Pending row;
chemical scrap → `erp_scrap_entries` under `Chemical Scrap` (Kg, sellable);
waste → `erp_waste_disposals` (date, method, responsible person, agency, cost,
certificate). A decision is reversed only while what it posted is still there.
`entryOrphans` treats a return/rework entry without its live parent as a
missing record.

**THE BATCH TRACE SHOWS RETURNS.** `traceCode` appends a "Material returns"
stage from `returnRowsForTrace`: a raw-material lot's purchase returns, an FG
or packing lot's (or an order's) customer returns, and an `RW` lot's source.
