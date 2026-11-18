# Payment terms, catalogue, products, price lists

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**A payment term belongs to the customer, and the bill inherits it.** The term
is no longer agreed call by call — an order takes the customer's standing term,
or the configured default. It is still stored on the order, so a bill with no
due date of its own resolves one from that term, then from the customer's
standing term, then from the default. A customer on 45 days never quietly
becomes 30 because nobody typed a date onto the bill.

Orders taken before this change carry the term the telecaller agreed at the
time, and those values stand — the capture was removed, never the history.

**One aggregation answers "what do they buy".** The order form's frequent
container and the Information tab's product history are the same query in
`lib/services/product-service.ts`, ranked and trimmed by configuration. They
were two queries once and disagreed about the same customer, which a telecaller
notices and then stops trusting the screen. External order lines carry a
product NAME rather than an id, so they are matched back to the catalogue by
name — an unmatched name contributes nothing, because a product the catalogue
does not carry cannot be put on an order.

**Product search runs in Postgres, not in the browser.** Matching is trigram
similarity as well as substring, because a name typed mid-call is a name typed
badly: "thiner" has to find Thinner on the first attempt. The extension and its
GIN indexes live in `drizzle/0008_products_and_no_order_reasons.sql` and
`drizzle/0013_nostalgic_psynapse.sql`; Drizzle cannot express an operator-class
index, so they are not in `schema.ts`.

**The catalogue is four levels, and only the bottom one can be ordered.**
Formulation → brand line → finished good → SKU. A formulation is the liquid and
no customer hears its name; a brand line is what they ask for; a finished good
is brand plus pack size; a SKU is a finished good in one packing configuration
and is the ONLY level `interaction_product_lines` may point at. "Nano Thinner -
5 Liter (6 Can/Box)" and "… (Loose)" are two SKUs of one finished good, and
choosing between them IS the order. The three upper levels deactivate rather
than delete, because deleting one orphans everything beneath it.

**The catalogue is never shipped to the browser.** Two hundred SKUs is a
search box's job, not a list's, so the order form is handed only what is worth
offering unprompted — the customer's own frequent products and a short starter
list of best sellers (`products.starterListCount`) — and everything else
arrives a search at a time. The panel remembers every product it has seen, so a
line put on an order keeps its name after the search that found it is typed
over. Nothing is hardcoded anywhere: a product list in the CRM, the console or
the seed is a query against `products`, never a literal.

**Search reaches the formulation and the brand, not just the SKU name.** One
liquid sells as Nano, Astar Nano and M5x4 Thinner, so a telecaller told "M5x4"
must find the Nano SKUs or conclude we do not stock it. The formulation comes
back as a subtitle, which is the only thing separating "Astar Nano Thinner - 20
Liter (Loose)" from "Nano Thinner - 20 Liter (Loose)" on a list read mid-call.

**An empty product list means three different things, and says which.** Still
searching, nothing matched, and nothing offered yet are three different
sentences — mid-call, a list that means "wait" and one that means "we do not
sell that" must never look alike. Where `products.searchOnOrderForms` is off
the box is hidden rather than shown and made useless, because a search that
finds nothing reads as a broken catalogue rather than as a policy.

**A SKU's name is the join key, so a rename leaves the old name behind as an
alias.** Legacy orders and bills reference the description as TEXT, not by ID, so
`products.name` is the normalised name and it is unique across the catalogue. It
used to be never edited at all, because a bare rename would silently detach every
historical line carrying the old spelling. `renameSku` is what made it editable:
the old name is written to `product_aliases` in the same transaction, so every
reader that resolves a name — they all read aliases — keeps finding the row. The
catalogue import matches aliases too and leaves a renamed SKU's name alone, or a
re-run would revert the rename or create a second SKU under the old name. Never
`update products set name` anywhere else. Aliases are read on the way in and never
offered on an order form. The raw name is kept beside the normalised one for
reconciling against records that still hold the original string.

**Quantity is cans, and it is shown as cans, litres and boxes.** Cans are what the telecaller counts and what the customer
says, so cans are what is stored; litres and boxes are derived in
`lib/catalogue.ts` from the SKU's own packing. Storing litres would make "six"
unrecoverable the moment a pack size changed, and sizes here run 0.5 L to 210 L.
`packing_cost_paise` is the empty box or drum and is a COST — never a price, and
never a way to value an order. Weight is per BOX where there is a box and per
CAN where there is not, so `weightBasis` decides the multiplier and no caller
adds the two kinds together. A drum is not loose: it is a container that costs
something, which is what keeps the two costs apart.

**A name carried by two legacy Product IDs is held, never auto-picked.** The
import refuses, because order lines reference the name and choosing wrong
silently reassigns whatever history the losing ID carried. Those SKUs sit at
`needs_canonical_id`, are not orderable, and wait for a person in Admin Console
→ Catalogue → Duplicates. Choosing makes the losers aliases pointing at the
same SKU. A legacy row with packing but no sellable name is held the same way,
and packaging material is excluded outright — both stay listed rather than
dropped on the floor, because a row nobody can account for later is worse than
one that says why it is not a product.

**The Empty Drum turned out to be a product, and that is why the exclusion is
evidence-led.** The document excluded #152 as packaging; it is on 43 order
lines, because customers buy empty drums. So it is a SKU now, under its own
`Packaging` formulation, at 0 L — it holds no thinner, and a size borrowed from
a full drum would add two hundred litres to somebody's volume target for every
empty one sold. #76 and #77 were named "Plain Can" by the owner, and 234–236
are newer than the document. All six live in `ADDED` in
`scripts/parse-catalogue.mjs`, in the document's own columns and kept out of its
count checks, and the import CLOSES a held row whose Product ID the seed now
sells, so "Held & excluded" does not go on asking for a decision already made.

**The import is idempotent, and it never unmakes a decision.** It matches on
the canonical name, reports created/updated/unchanged per field, and a dry run
shows exactly what a real run would change while writing nothing. Two things it
sets only on CREATE: `active`, because whether a SKU is offered is somebody's
decision and a re-import must not put every retired product back; and the
canonical ID, because a re-run must not reset a name somebody has already
settled. Both have a test saying so. Regenerate the seed from a new revision of
the document with `npm run catalogue:parse`, then `npm run catalogue:import`.

**A SKU CAN BE ADDED BY HAND, and the import is no longer the only door.**
Admin Console → Catalogue → All SKUs → Add SKU opens a four-page dialog
(`app/admin/new-sku-dialog.tsx`): where it sits (formulation, brand line,
finished good — each picked or named new), packing, costs and codes, review.
`createSku` in `lib/actions/catalogue.ts` writes any new level and the SKU and
its other names in ONE transaction, refuses a brand or finished good from
another branch, and refuses a name that matches any SKU name or alias by
`matchKey`, or a legacy Product ID another SKU carries. The suggested names
(`finishedGoodNameFor`, `skuNameFor`) are suggestions; `newSkuProblems` is the
one rule the dialog and the action both run. The ERP's can and box are still
set in ERP → Products.

**Order value is not computed from the catalogue until a price source is
confirmed.** The product master carries no prices at all, so
`products.priceSource` starts `unset` and `canValueOrders()` answers no. An
order is worth what the telecaller typed, and the screens that would derive a
value say so rather than showing a confident zero — reaching for the packing
cost because it is the only number on the row would put believable wrong
figures on every target screen. `pricelist` is refused by `checkConsistency`
until a customer price list actually exists.

**A PRICE LIST IS CHANGED AT TWO DESKS AND READ AT THREE.** `pricelist.manage`
is the Price Desk's (`PRICE_DESK` in `access-control.ts`), granted by name at
both levels of Accounts and of the Founder Dashboard, and nowhere else. It
shipped in `ACCOUNTS_OR_MANAGER`, which spread it into every CRM and Sales
Dashboard manager; Mahek's instruction was that the two apps that QUOTE prices
never set them. The screens enforce the other half by MOUNT —
`priceListDoorCanManage` answers false on `/crm/price-lists` whatever the
person holds, so a telecaller's screen never grows an edit button because
somebody also wears the Accounts hat. `price-desk-grant.test.ts` pins both.

**THE SALES DASHBOARD SHOWS NO PRICES, NO CATALOGUE AND NO PAY.** Mahek's
instruction: Catalogue & rates, Price lists and Salary were removed from it
outright — routes, sidebar, modules and the queries only they read. Prices
belong to the price desk (Accounts, Founder) and pay to HRMS; a sales manager
is the person whose number both move, which is the same reason `order.approve`
is kept off managers. Two consequences worth knowing. **Cost & return counts
field SPEND, never salary** — a cost column of salary plus expenses beside an
expense screen is a salary column with one subtraction in the way. And the
handset's own rate table and schemes (`mbos_price_list`, `mbos_schemes`) have
NO screen now: the Catalogue page was the only editor, so they are read by the
phone as they stand until a desk that owns prices is given one. The handset's
payslip stays — a salesman reading his own pay is HRMS's channel to him, not
a manager's view of it. `pricelist.read` is named on Accounts and
Founder too: it arrives with `BOOK_WORK`, which neither is given, and without
it the desk that uploads a PDF could not poll it being read.

**A LIST MADE HERE IS THE IMPORTER'S MIRROR IMAGE.** `lib/price-sheet.ts` holds
one `PriceSheet` model — header, pack columns, printed rows, clauses,
discounts — and the PDF (`price-sheet-pdf.ts`, pdf-lib, isomorphic), the HTML
print page, the CSV export and the editor's grid are all drawn from it. Every
label it writes is one `parsePackColumn` and `parseHeader` read back to the
same fact, and `price-sheet.test.ts` proves it by drawing a PDF and reading it
with `unpdf` and the real parser — including Mahek's own Odisha Paid list,
redrawn. Change a label or a figure format and that test goes red before a
shop receives an unreadable list.

**PUBLISHING STORES THE PAPER, READ BACK.** `savePriceSheet` publishes and
then draws the PDF, runs it through the import pipeline (`verifySheet`:
extract, parse, match, compare) and keeps it as the list's `document_id`, with
staged rows saying cell by cell whether the paper agrees. The editor's
Preview step runs the same read-back on demand. Nothing is stored for a
draft — a draft has not been issued. The PDF's dates are fixed at the epoch so
the same list always draws the same bytes, which is what the document table's
hash dedupe relies on.

**The editor never rewrites a published list.** Opening one makes a new
VERSION (`mode: "version"`) that supersedes it on publish and inherits its
scopes if it names none — the rule `price-lists.ts` already keeps. A draft is
replaced wholesale on each save, because the sheet IS the list: a row taken
off the grid is a rate taken off the list, which a merge cannot express.

**A duplicate does not copy who it applies to unless asked.** Two published
lists naming the same shops compete for them on a priority nobody set.

**Bulk import is one workbench.** The import modal reads files three at a
time, lets each be checked, corrected and approved in place, and "Approve all
ready" goes through `publishDocument` once per file — the same action and
checks as the review screen, never a looser batch path. "Ready" means read,
nothing held, a name and a date.
