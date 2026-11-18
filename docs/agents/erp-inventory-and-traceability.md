# Inventory accuracy, levels, traceability, dispatch desk, labels

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**A PURCHASE REQUIREMENT IS NOT COUNTED, AND THAT IS A REVERSAL (Nov 2026).**
A raw-material requirement used to open a BLIND count of its item at its
godown and stop at a **Blind count** stage until somebody entered it, with a
book comparison and a verdict on the record. Mahek asked for it out of the
flow, so the flow is Requirement → Purchase method → PO number → Receipt
(`FLOW_STEPS`): raising one opens no count, nothing on the purchase side reads
a count (`stockGate`, `gatesFor`, `heldByStock`, `reorderJustification` and
`openRequirementCounts` are gone), and `erp.stockCheck.onRequirement` and
`erp.stockCheck.unexpectedQtyPercent` are retired. `0312` cancelled the open
counts requirements had opened. `stock_check_required` and the
`stock_exception_*` / `qty_confirm_*` columns stay as the record they are and
are read by nothing. Stock accuracy itself is unchanged and stands on its own:
cycle counts, counts somebody asks for, floor checks, red flags, recounts and
approved adjustments. The rules are pure in `engines/stock-check.ts`;
`stock-check.ts` hands them the ledgers' figures; `screens/stock-check.ts` is
the Stock accuracy screen (To count · Red flags · Adjustments · Missing records
· Every count).

**A RED FLAG IS TOLD.** With nothing held, the bell is what makes a leak reach
somebody: `notifyStockFlag`, after `submitCount` commits, tells every active
`stockControl` holder on the ERP, every ERP administrator and, for a count an
older factory phone sent with a requirement, whoever raised it — not the
counter, who saw it — on a new red flag and again
when a recount confirms it. It cannot fail the count.

**THE COUNT IS BLIND.** Nothing on To count, its prompt or its drawer shows the
book; Every count blanks it on an open row. The book is read and SNAPSHOTTED
(`book_qty`, `pending_in`) inside the submit's transaction and only then shown
back. It is compared with the RECONCILED book — ledger + goods at the gate,
under test or unposted for want of a rate — because a drum waiting for its test
is paperwork in progress, not a discrepancy. Tolerance: the item's
`count_tolerance_percent`, else `erp.stockCheck.tolerancePercent`, never below
`toleranceFloor`.

**A RED FLAG IS RECOUNTED BY SOMEBODY ELSE.** A recount is a child count
(`recount_of_id`); only ROOT counts carry the check's state. `recountOutcome`
compares it with the book and with the first count carried to today's book:
book → resolved (`book_confirmed`); first count → `investigating`; neither →
flagged again. The first counter may not count it (refused on the server).

**CAUSES ARE SUGGESTED, NEVER ENTERED.** `causeCandidates` lists only records
that exist (`shelfFacts`), marks one likely when its quantity accounts for the
gap, and names a shortage nothing explains a missing PHYSICAL item. The
assistant (`erp.ai.stockCheck.*`) only ranks those records; anything it names
that is not on the list is dropped. "The missing record is entered" re-reads
the book and refuses unless it now agrees.

**NEVER A SILENT ADJUSTMENT.** `erp_stock_adjustments`: a coded reason and a
sentence, one pending per count, posted only when somebody OTHER than the
requester with `stockControl` approves it. A shortage is transfers to Item Lost
Record, oldest lot first, refused if the lots do not hold it (no negative
stock); a surplus is an `erp_rm_entries` row with `source_type = 'adjustment'`
on the newest lot. Lots are locked under BOTH spellings the ERP uses (`rm`,
`Purchase`) and read again under the locks.

**CYCLE COUNTS ARE OPENED HOURLY, ONCE A DAY'S WORTH.** `erp-cycle-counts`
(`planCycleCounts`) ranks shelves by ABC (value moved over 90 days, 80/95),
how overdue against the class's cycle (halved after a discrepancy), movement
and past discrepancies, up to `erp.stockCheck.dailyCount` per day. One open
count per shelf (a partial unique index); `openCount` answers with the open
one rather than opening a second.

**RAW-MATERIAL LEVELS ARE PLANNED FROM HISTORY, A WEEK AND A HALF AT A TIME.**
`runLevelPlanner` (`lib/erp/level-planner.ts`) sets every raw material's
minimum at every godown to the forecast use over `erp.levels.coverDays` (10.5)
and the maximum to that plus `erp.levels.orderCycleDays`. The model is pure in
`engines/stock-plan.ts`: the RATE from production use (purchases where use is
not recorded), MONTH factors from whichever series reaches back further, and
WEEK-OF-MONTH factors from use only — when a drum is bought is the buyer's
calendar, not the shelf's. Both factors are ratio-to-moving-average, so growth
is taken out first, and shrunk by how much history stands behind them. An AI
review (`erp.ai.levels.*`, feature `levels`) may move a level by at most
`maxAdjustPercent`, with a reason on the level; without it the statistics
stand. `auto_managed` (0280) marks a level the planner keeps: a hand edit of
min or max clears it and the planner never touches that level again; "Let the
planner keep it" hands it back. It runs nightly before the alert pass, in
`deploy:db` (which it never fails) and from "Plan levels now"; `planned_at`
makes it once a day. A raw-material level is now BELOW when stock is under
the MINIMUM (`rmBelowMin`) — it used to fire under the maximum, which with
planned levels would list nearly every item every day.

**MISSING RECORDS ARE A LIST, NOT A FIX.** `missingRecords` finds SFG lines
without an SFG entry, fills without an FG entry, register lots not in stock,
inward lines two days old with no register row, transfers whose destination
has no entry, and packing batches whose cans do not match their boxes. Each
opens its record; nothing is created.

**EACH DEPARTMENT CHECKS ITS OWN STOCK, ANY TIME.** Stock check on the
factory app (`Me.counts`) lists, at the person's godown, what their
departments keep (`lib/factory/stock-reach.ts`, pure): Mixing & Blending the
raw chemicals and SFG; Filling the empty cans and drums, filled cans and
packed boxes; Packing the empty boxes and stationery; Dispatch filled cans and
packed boxes; Quality chemicals and SFG. A raw material is placed by its
item-master type, and a type no department names is the whole floor's.
Several departments reach the union; the Production Head over the whole floor
and an administrator reach everything. The office's open counts are offered
the same way (a count named to one person stays theirs), and the save refuses
anything else. Before this every department checked everything. The list never carries a quantity; the
book is read when the figure arrives (`lib/erp/floor-checks.ts`, judged by the
same `judgeCount` and tolerance as a formal count) and stored beside it in
`erp_floor_checks`. A mismatch is said on the phone with the book and the
difference, asks for an optional reason, and waits for the office on the
dashboard tile and ERP → Stock accuracy → Stock checks until it is reviewed
or, on a raw material, raised into a formal count. A check moves no stock.
It needs the network on purpose: a figure queued for hours would be judged
against a book that has moved. An office count from the phone goes through
the ERP's own `submitCount`.

**STOCK IS ADJUSTED FROM ITS ROW, AND IT TAKES EFFECT ON SAVE.** Every row of
Stock on hand, on all four stages, ends in a ⋯ menu (`ListSpec.rowMenu`) with
**Stock inquiry** and, for a `stockControl` holder, **Adjust stock**: Add or
Remove, a quantity, and a reason from `ADJUST_REASONS` (Other must be written).
Nobody approves it — Mahek asked for it simple. Add posts an inflow entry on
the same lot (`source_type = 'adjustment'`); Remove is `postWriteOff`, the
transfer to Item Lost Record the transfer form makes, so it is never a silent
subtraction and never takes a lot below zero. `erp_manual_adjustments` keeps
who, why, the stock before and what was posted (`lib/erp/stock-adjust.ts`).
The count-driven adjustment above, with its approval, is unchanged.
**The stock inquiry** (`/erp/stock-inquiry`, held with the Stock screen) is one
item's lots now and every movement in a period with a running balance, read
from the same sources `stock.ts` adds up (`lib/erp/stock-inquiry.ts`); Item
Lost Record is left out, so a write-off reads as one movement out. A new way
stock is consumed must be added to its union, or the inquiry's balance drifts
from the stock.

**PRODUCTION & DISPATCH ARE TRACEABLE, BOX BY BOX.** SFG lot → refill (FG
filling) lot → packing batch → BOX → order → customer, and back. The lots
already chained to each other; what `0237_erp_traceability` added is a QC
verdict on the SFG lot, an id for every physical box, a dispatch desk that
judges each box against its order, and a trace that answers both ways. The
rules are pure in `engines/trace.ts`; `units.ts` is the register,
`dispatch.ts` the desk, `traceability.ts` the trace and the dashboard.

**THE LOT CODES DID NOT CHANGE.** SFG `12ASTOL1`, refill `FG12NA`, packing
`FP40NA` are join keys across the ledgers and are on labels already in the
godowns, so the new ids sit beside them rather than replacing them.

**AN SFG LOT IS FILLED ONLY ONCE QC APPROVES IT.** `erp_sfg_qc`, keyed on the
lot code so a transfer carries the verdict; no row reads as Pending. The fill
form offers approved lots only and `saveFill` refuses any other
(`qcRefusal`). Deciding is the `approveSfgQc` power; a reject needs a reason,
and rejecting an approved lot stops further filling while what was filled
stays traceable to it. Every lot in the book when this shipped was written
Approved, or refilling would have stopped on deploy day. In the ERP the
decision asks, for each ACTIVE value of the Testing list (ERP → Settings →
Reference lists), the same EVIDENCE Purchase → Lot testing records — a
photograph per test, the smell, the pH and density readings, a video — from
one list (`EVIDENCE_FIELDS` in `engines/sfg-tests.ts`, which Lot testing reads
too). NONE of it is required and no field says "Optional" (`untagged`); what is
given must make sense (a smell from the list, a density in range). It is
stored in `erp_sfg_qc.evidence` (`0265`), its files filed under `erp_sfg_qc`
and read by whoever holds SFG batches, and drawn in the batch's drawer. A
reject still needs its reason. The factory phone still asks Pass / Fail per
test (`erp_sfg_qc.tests`, every one Pass to approve) until its APK changes.

**A BOX ID IS WHAT THE QR CARRIES; THE LOT IS LINKED DATA.** `erp_units`, one
row per box (`BX-YYMMDD-NNNNNN`, series `unit`), minted by `syncPackEntry`
the moment a packing batch completes and cancelled — never deleted — if an
edit un-completes it (a re-completion restores the same ids, whose labels may
be on the boxes). One lot makes many boxes and one dispatch carries several
lots, which a lot printed into the id could not say. **Which refill lot a box
holds** is derived, not stored: boxes fill in the order the batch drew its
cans (`boxLots`), so a box on a boundary names both lots.

**A LOOSE CAN OR DRUM IS LABELLED ON ASKING**, from FG stock → Label loose
units (`LU-…`), never at the fill: an FG lot's cans may yet be boxed. A lot
never carries more labels than it has cans (`looseHeadroom`), and packing or
a can adjustment cancels the newest labels the lot can no longer be
(`trimLooseUnits`).

**EVERY CHANGE OF A BOX IS AN EVENT, APPENDED.** `erp_unit_events`: created,
labelled, scanned, unscanned, dispatched, transfer, hold, release, reject,
return, lost, override. A transfer moves the lowest-numbered boxes in stock
with the stock (to Item Lost Record they go as `lost`); nothing rewrites a
box's history, and a correction is a further event.

**THE DISPATCH DESK SCANS EVERY BOX AGAINST ITS ORDER** (`/erp/dispatch`,
`scanVerdict`). A box of the allocated lot is matched. A box of ANOTHER lot of
the same SKU takes that lot's place on the allocation (the swap is said on
the scan and in the history). A line still short of allocation takes the
box's lot. A different PRODUCT or PACK SIZE is stopped, as is a duplicate, an
unknown code, a box at another godown, on hold or already gone — and every
scan, refused ones included, is a row in `erp_dispatch_scans`. Scanning works
on a Ready line; the allocation may change by scan before dispatch, never
after.

**THE DISPATCH REGISTER IS WHAT HAS NOT LEFT, AND EVERY COLUMN FILTERS LIKE
EXCEL.** Sales → Dispatch register (`dispatchRegister` in `screens/sales.ts`)
is every line Under Process or Ready and not dispatch-verified
(`isRegisterLine`) — billing party, delivery party, product, weight, transport,
dispatch day — grouped by order with its boxes and kg. It is read-only; the
work stays on Orders and the desk. Its filters are `ListSpec.colFilters`, which
any list can opt into: a funnel on every heading opens the column's values,
counted over what the OTHER column filters leave, or a min/max on a number
column (`ListQuery.cf`, URL key `cf`, `passColFilter` / `colFacetsOf` in
`list-query.ts`, `_ui/column-filter.tsx`). They are applied on the server
before the page is cut, so they reach every page and the export. Ticking rows
adds them up: `ListSpec.selectSum` puts a checkbox on every row of any list
(bulk action or not) and the selection bar says what the ticked rows come to —
weight, boxes, cans, how many orders — through `selectionTotals`, in the
browser while every ticked row is on the page and through `erpListTotals` once
"Select all" reaches past it. A row with no figure is counted, never added as
zero.

**READY MEANS THE STOCK IS ON THE SHELF, AND THE SCAN ALLOCATES IT.** Ready
(the button, the bulk action and the edit form alike) is refused unless the
line's godown holds the boxes — or, for a loose SKU, the cans — it still needs,
net of what lines already Ready and not yet allocated will take
(`readyStockCheck` in `engines/sales.ts`, pure); a bulk Ready marks the lines
that pass and names the rest. "Allocate a lot" is gone from the Orders lists:
scanning at the dispatch desk allocates, and the desk keeps "Allocate a lot by
hand" only for stock packed before box labels, which has nothing to scan.

**A MISMATCH GOES ONLY ON AN OVERRIDE SOMEBODY ELSE APPROVED.**
`erp_dispatch_overrides`: the reason in a sentence, who asked, and a decision
by a holder of `dispatchOverride` who is not the asker (an ERP administrator
excepted). Approved, the box is scanned again and stands in for the line;
the override is then Used and cannot be spent twice.

**DO VERIFIED WAITS FOR THE SCAN, where there is something to scan.**
`scanGateFor`: a line whose allocated lots carry box ids cannot be
dispatch-verified until every box is scanned, and verifying turns those boxes
`dispatched` (`markDispatched`). Stock packed before box ids existed has none
and is not held back — refusing it would have stopped dispatch on the day this
shipped. `erp.dispatch.requireScan` turns the wait off for a day the scanners
are down; scanning is still checked. Billing still comes BEFORE dispatch
verification, as it did: the Tally bill number is entered first.

**LABELS ARE DRAWN FROM THE RECORD, FOUR OF THEM, AND NEVER TYPED**
(`/erp/print-labels`, not `/erp/labels`, which redirects to the Orders tab of
that name). The box label is 50 × 50 mm (`?batch=`, `?lot=`, `?ids=`): the
box's QR and id, the pack size, cans per box, the product, and the batch, box
number and packing date; printing stamps `label_printed_at`. The other three
are 80 × 80 mm: the SFG lot's (`?sfg=`, from SFG batches and Semi-finished
stock; QR = the lot code), the purchased lot's (`?purchase=`, from the Purchase
barcode list and the register; QR = the lot number; one a drum unless
`&copies=` says otherwise), and the dispatch label (`?order=`). `label-data.ts`
reads each through the function its own list reads — `sfgLots`,
`purchaseFigures`, `orderLines` — so a drum and the screen it was printed from
cannot disagree.

**A DISPATCH LABEL IS PER PIECE, NOT PER SCANNED BOX, and that is a
reversal.** It was a sticker for each box already scanned onto the order,
carrying the box's QR. It is now one label for every `labelCount` of every line
not cancelled — a box on a boxed line, a can otherwise — printable before
anything is scanned, with no QR (the box's own label is what the desk scans),
and each carries the LOT SIZE: every label on the order added up (`lotSize`),
so the pieces are counted on and off the lorry against one figure.

**A VALUE THAT CAN BE LONG IS SIZED TO FIT, in `engines/labels.ts`.** A label
is cut to size and nobody scrolls it, so `fitPt` steps a name down through set
sizes against Helvetica Bold's own widths, a long product name on a box label
takes two lines (`boxNameFit`), and the last line of a box label shortens to
"Box 118/120" (`boxFoot`). The CSS ellipsis is the net under that, not the
plan. `label-css.ts` is ONE stylesheet as a string, in millimetres and points.

**THE LABEL PRINTER IS SENT A PICTURE OF THE LABEL ON THE PAGE.** The godown's
printers speak TSPL. The printer team's samples set each line in the printer's
own fonts, which ties a layout to one model, one firmware and one installed
font file (`ROMAN.TTF`). `printer.tsx` instead rasterises each label's own
markup under `LABEL_CSS` at `erp.labels.dotsPerMm` and `engines/tspl.ts` packs
it as one `BITMAP` — so "Send to printer" (WebUSB, Chrome and Edge), "Save
print file" (`.prn`) and the browser's print dialog cannot print three
different labels. In TSPL a set bit is WHITE; `packBitmap` is the only place
that is written. Each QR is redrawn from its modules on whole dots (`qrGrid`).
The same label several times over is one picture and a count (`printRuns`,
keyed on `data-key`). `erp.labels.gapMm` and `erp.labels.direction` are the
other two printer settings. A Windows printer driver holds the USB port, so
there WebUSB is refused and the screen says to use Print; the print dialog is
never removed.

**TRACE TAKES ANYTHING ON A LABEL** (`/erp/trace?q=`): a box id, an SFG,
refill or raw-material lot, a packing batch, `ORDER-n` or a Tally bill — back
to the supplier's drum and QC, forward to every refill lot, batch, box,
customer and what is still on a shelf. With nothing searched it is the
traceability dashboard: today's production and dispatch, and every exception.
A link that is missing is said to be missing, never guessed.
