# Empty drums and scrap

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**A DRUM IS REGISTERED WHEN IT IS EMPTY, OFF ITS EXISTING GRN LABEL.** The GRN
is not redesigned and never edited: production scans the drum's lot label
(the purchase register's `lot_no`, or its id) once the material is used up,
weighs the empty drum, and `recordEmptyDrum` (`lib/erp/drums.ts`) writes an
`erp_empty_drums` row that COPIES the GRN, supplier, material, lot and the
declared empty weight (`erp_inward.empty_drum_weight`). From then on the
record carries the link, so a label that tears or falls off in the yard costs
nothing. The rules are pure in `engines/drums.ts`; the screens are
`screens/scrap.ts`; the phone's Empty drum entry is two factory ops,
`drumLookup` and `emptyDrum`, and the `drum` route in both factory apps. Who
on the floor sees it is `erp.drums.factoryDepartments` plus every supervisor.

**OWNERSHIP IS READ, NEVER GUESSED.** `erp_inward.drum_ownership` (the GRN
line's "Drums belong to", copied from the supplier at save) wins over
`erp_suppliers.drum_ownership` ("Their drums are"); null on both is a drum in
`review`, which the Production Head classifies with a sentence. A lot whose
owner a person decided under the first version of this module
(`erp_purchases.drum_ownership`, carried by `0257` with every drum, sale and
receipt 0256 recorded) wins over both. Changing an
already-classified drum's owner is an `erp_drum_adjustments` row of kind
`ownership`, approved by somebody else holding `scrapApprove`.

**ONE RECORD PER DRUM OF A LOT.** A label names a lot and a lot brings
`drums` drums, so each emptied drum takes the next `seq` of its lot under an
advisory lock, held at the database by a partial unique index on
`(purchase_id, seq)`; a fifth drum off a four-drum lot is refused with the four
already recorded. A second drum of the same lot within
`erp.drums.sameLotMinutes` is saved only after the person says it is a
different drum. A GRN with no drum count cannot be checked, so its drums go to
review. The phone's `DRM-…` key is `client_key`: a resend answers from the
first save. The weight must sit between `erp.drums.minEmptyKg` and
`maxEmptyKg` unless a `scrapApprove` holder writes why it is right.

**MAHEK'S DRUMS AND A SUPPLIER'S NEVER MIX.** Status is the stock: `available`
is Mahek's scrap, `returnable` a supplier's drum waiting to go back. A scrap
sale draws only `available` drums and a returnable outward only that
supplier's `returnable` ones, both BY QUANTITY and OLDEST FIRST (`fifoPick`,
over a pool selected `for update`). The allocation is stored on the drums
(`scrap_sale_id`, `return_id`) for traceability; it does not claim anybody
checked those physical drums. A returnable drum named in a sale is refused
with "This drum goes back to its supplier. Use Return drums instead."
whatever button sent it. Nothing holds a balance: every stock figure is a
count of records, and every change is a row in `erp_drum_events`, which a
trigger makes append-only.

**A SCRAP SALE IS A RECEIVABLE, AND ONLY THE ACCOUNTANT CLEARS IT.** What is
owed is the sale less its live `erp_scrap_allocations`, read and never stored.
Money arrives as an `erp_cash_receipts` row on Petty Cash/Bank → Receipts
(`scrapAccounts`) and is matched to one or more sales; `allocateReceipt` locks
both rows and refuses more than the receipt has left or the sale owes. A wrong
match is voided with a reason, never deleted. Production cannot mark a sale
paid. `ref_kind = 'none'` is a sale with no external invoice: it carries NO
reference — a check constraint refuses one — and is traced by its `sale_no`.

**NON-DRUM SCRAP IS A BATCH, NOT A RECORD PER BAG.** Plastic, cardboard and
the rest of the `scrapCategory` reference list are `erp_scrap_entries` by
category, unit and godown, and a sale is refused above recorded less sold.

**CORRECTIONS ARE SOMEBODY ELSE'S.** Opening stock (drums here before
MahekOne, with no GRN — `source = 'opening'`, the one kind of drum the link
check allows), write-offs and owner changes are asked for by one person and
approved by another holding `scrapApprove`, an ERP administrator excepted.
Weight corrections, cancelled entries, cancelled sales (only with nothing
matched) and cancelled outwards need `scrapApprove` and a reason, and keep the
original in the drum's history.

A pending correction is WITHDRAWN by whoever asked for it
(`withdrawDrumAdjustment`, status `withdrawn` since 0367): kept on the list,
nothing about the drums moves, and it can no longer be approved.
