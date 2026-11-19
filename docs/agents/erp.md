# The ERP (operations app)

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**The ERP is the client's AppSheet "Mahek Plus" rebuilt as a MahekOne app**
(`erp`, at `/erp`): purchase, testing, stock, production, transfers, orders,
dispatch, transport, credit notes, follow-up and petty cash. `docs/erp/` is
the whole of its scope — 01 the PRD, 02 the functional spec (every field,
formula and action of the source, with the anomalies and the decisions taken
on them in §14), 03/05 the design briefs, 04 the eight AI features. Nothing
outside those documents is in scope.

**One registry, three readers.** `lib/erp/registry.ts` lists every screen by
group. A screen becomes a module (`erp.<key>`) in `lib/modules.ts` only once it
is `built`, and the sidebar, the module guard and the Access screen all read
it. The dashboard and Settings are always open.

**A list that was only a filter is a TAB, not a screen.** Mahek Plus drew a
separate view for every filter of one table — Pending LR, Track LR and All
transport are one list three ways; each stock stage had an "available" view and
a "log" view — and the first build copied every one into its own sidebar entry,
module and grant: 54 screens. A screen's `views` in the registry are its tabs.
Each tab keeps its own server module under its own key (its rows and actions
are exactly what they were), is reached as `?view=<key>`, and is opened by
holding the SCREEN: `erpContext` adds every tab's key to the screens a holder
may use, so a check naming `pendingLr` answers as Transport. A tab is never a
module, so it can never be granted apart from its screen, and
`registry.test.ts` pins that. Link to a list with `erpLink(key)`, never by
pasting `?f=` onto `erpHref` — a tab's link already carries a query.
`0182_erp_screens_merged` moved every grant naming an old screen onto the
screen it became; `next.config.ts` redirects the old URLs.

**AN ERP LIST NEVER SCROLLS SIDEWAYS; it draws the columns that fit.** A
server module names every column a person's powers reveal — order details
names twenty-six — and drawn as they came the busiest lists were thousands of
pixels wider than their card. `app/erp/_ui/fit-columns.ts` (pure, tested) takes
the measured width and draws a prefix of the server's order, always keeping the
first column, the record's name, its first status and its flags; the table is
`table-fixed`, a long value ends in "…" with the whole of it on hover, and a
heading wraps rather than widening its column. The rest are FOLDED, not lost:
still searched, still exported, and in full in the record dialog a row opens.
The Columns menu lets a person choose their own set, remembered per browser per
list, and a column with no room at this width says so instead of being added.
So the ORDER of a screen's `cols` is now its priority: put what is read first,
first. HRMS draws the same list and gets the same behaviour. A panel was
written for a 600px drawer, so a panel table of more than four columns is still
drawn as a card per row.

**Its decisions are POWERS granted to people, not capabilities of a level.**
The source tied "verify a test", "see purchase money" and the rest to three
email addresses and an admin role; a hat (app, level) cannot say "the CEO"
without making every ERP manager the CEO. `lib/erp/powers.ts` names them,
`erp_user_powers` grants them, an ERP administrator holds all of them without a
row. They are handed out on the Admin Console's Access dialog, under the ERP
app's screens — one place decides what somebody's ERP lets them do — and
`setAccess` refuses a change to them from anybody who is not an ERP
administrator (or holds the directory power), because a manager may grant the
ERP and is still not the person who decides who verifies tests. Taking the ERP
away takes its powers with it, like its module rows. A
column a power reveals is removed on the SERVER (`visibleCols` /
`withoutHidden`) — the value never reaches the browser — and every write that
needs one re-checks it in the handler.

**A DESIGNATION IS THE JOB, and it is LINKED rather than stamped.** Owner /
CEO, Office / accounts, Quality tester, Godown / dispatch — the ten the ERP's
design previews access as — are rows in `erp_designations`, each a level, a set
of screens and a set of powers with a name on it, seeded by
`0218_erp_designations` from the design's own role table. The Access dialog
offers one first on the ERP's block: picking it sets the level, the screens and
the powers in one move. Editing a designation on Admin Console → ERP
designations moves EVERYBODY WHO STILL HOLDS EXACTLY IT, in the same
transaction, and tells them; a holder somebody changed by hand afterwards is
CUSTOMISED and is left alone, because that difference is a decision made about
one person that an edit to "Quality tester" says nothing about. The review page
names both lists before anything is written.

**Customised is DERIVED, never stored.** `lib/erp/designations.ts` compares
EFFECTIVE access — no module rows is the whole app, the always-open screens are
nobody's to grant, an administrator holds every power without a row — so two
people who can open exactly the same screens are never told apart by how their
rows happened to be saved. It is pure and client-safe because the dialog draws
"matches / customised" live from the same arithmetic the edit is applied by.
`all_screens` is the "no rows is the whole app" rule said once for a
designation, so Owner / CEO gains a screen built next month. Deleting a
designation never takes a screen away from anybody: its holders keep their
access and lose only the name. Taking the ERP away takes the designation with
it, like the powers. A test reads the seed migration and refuses a screen or a
power the ERP does not have.

**PURCHASE RUNS DEPARTMENT BY DEPARTMENT, and the department is the
designation's.** Mixing & Blending raises chemical requirements, tests each
chemical lot as it arrives and makes SFG; Refilling raises can (and drum)
requirements and fills FG; Packing raises empty-box and packing-stationery
requirements and makes packing batches; the Production Head does all of it.
`lib/erp/departments.ts` is the whole rule, pure: which categories each
department may ask for, and the steps in order. `erp_designations.department`
(`mixing`, `refilling`, `packing`, `head`) puts a job in one, `0226` seeds the
four designations, and `ErpContext.department` carries it — null for anybody
outside production and always for an administrator, so nothing that worked
before moved. Two rules, both in `saveRequirement` and not only in the form: a
requirement filed under a production department is for that department's
categories, whoever raises it; and somebody in a department raises for their
own only, sees only those requirements (and their own) on the list and in the
badge, and cannot cancel another's. **A requirement is raised for one of FOUR
teams and nothing else** — Mixing & Blending, Refilling, Packing and Production
Head (`REQUIREMENT_DEPARTMENTS`); the head asks for every category of the
three. The form used to offer the `department` reference list beside them
(Production, Godown / Store, Quality, Dispatch, Office, Maintenance), each of
which could ask for anything; `0233` retired that list and `saveRequirement`
refuses any other label, except that an edit leaving an older requirement's
label alone keeps it. A store re-order is raised under the team that asks for
its category (`departmentForCategory`). The requirement's `department` column
stays the LABEL it always was. The step-by-step **Departments** page
(`/erp/departments`) was taken out of the ERP; its steps live on in
`lib/erp/departments.ts` for the purchase flow, and a grant of `erp.departments`
left on a designation is ignored. Any list still opens its new form already
filled in from `?new=1&field=value` (only the form's own fields are taken).
Testing is recorded by the department; VERIFYING a test is still
the `verifyTest` power, which no departmental designation carries by default.

**PREVIEW ACCESS AS is the design's sidebar control, made real and made
read-only.** An ERP administrator can see the ERP exactly as a designation or as
one person sees it — the sidebar, the hidden columns, the narrowed lists — from
the foot of the sidebar or the designations page. `erpContext` carries `user`
(whose ERP is drawn) and `actor` (who is signed in), and `requireErpWrite`
refuses every write while `viewingAs` is set: acting with somebody else's access
is a different thing from looking at it, and would need a different record.
Loading a form is allowed, because it writes nothing and the fields are the
point; its submit is not. The cookie is honoured only while its holder is still
an ERP administrator, so taking that away ends the preview too. A designation
has nobody behind it, so lists that belong to a person answer for the
administrator, and the banner says so. `erpAudit` always records the actor.

**ONE HOME FOR EACH SHARED PIECE, and the map is in the docs.** The ERP
grew screen by screen and copies drifted: extra expenses had two writers (one
skipped the transport record), Logistics drew its own tab strip, the same
order column had three headings, the dashboard listed the stock-control
counts twice. ERP → Overview → Developer, "One home for each shared piece",
names the single home of every piece two screens share — page frame and
`QuickFind`, `screenTabs` and `erpNavCounts` (a tab's badge is the figure the
sidebar sums), `isPendingLine`/`isWorkingLine`, `ORDER_COL`, `godownField`,
`isErpManager`, `useAct`, `controlClass`, the link builders in
`trace-links.ts`, the type and colour tokens. Look there before writing
something a second time; never type an `/erp/…` URL, a hex brand colour, a
pixel font size or a time zone.

**A SCREEN SAYS A THING ONCE.** The generic list and record dialog drop what would
repeat: a flag whose words are the row's own status (`flagsBesideStatus` in
`_ui/badge.tsx`), the grouped-by column on grouped rows, the toolbar on a list
with no rows, and the status strip that only repeated the status tabs. In a
record a field with a column's label replaces that column, its first status is
said in the heading and not again under Details, and a panel
lists the column keys it already draws in `covers`. Write a screen's
`noDataLine` as a short first sentence (the heading) and an optional second
(the explanation); keep subtitles to one line; name buttons as verbs ("Accept",
"Add another", "Show the whole order"), never past tenses or "Do …".

**AN ERP SCREEN SAYS AS LITTLE AS IT CAN (Oct 2026).** A label says what to
type and nothing else: a red `*` for required, a small grey "optional" for the
rest (never a pill), a calculator icon on a worked-out field and a sparkle on
one AI read, coloured by how sure it was. A unit in the label's brackets moves
INTO the box ("Use quantity (litres)" draws "Use quantity" with an L inside;
`splitLabel` in `_ui/field-label.ts`), except on a select, which has nowhere
to put it. A field's `hint` sits behind an ⓘ that hover, focus and a TAP open —
the gate tablet has no hover — and only `hintShown` keeps one written under the
box, for a hint that changes what is typed. A list page has no subtitle; a form
keeps one only when it names the record, and a prompt or confirm keeps its
first sentence, which is what the button will do (`_ui/quiet-copy.ts`). The
filters are one Filter button; Group, Columns and Export are icons; an empty
list is its `noDataLine`'s first sentence and the New button. Errors are the
one thing still written out in full. `quiet-copy.test.ts` pins the rules and
refuses a page that draws its registry line under the title.

**EVERY ERP LIST HAS FIGURE CARDS AND ONE FILTERS BUTTON, AND BOTH ARE THE
SERVER'S (Nov 2026).** A `ListSpec` names its cards in `stats` (`StatSpec`:
count, distinct, sum or average of a column, narrowed by `where` to a value or a
flag) and its pop-up sections in `filters`; `pageOf` works both out
(`statsOf`, `panelSections` in `list-query.ts`) over every row the filters
reach and, beside it, every row the list read, so a filtered card says "of ₹4.82
L in all". A spec naming no cards gets Total and one per `agg`; naming no
filters gets sections found from the data (a column with a handful of values,
never a name per row, plus a from–to on what it adds up). A card on a column a
power withholds is dropped, never drawn as zero; a row without the figure is
counted and named. A card with a one-value `where` or a flag is a filter when
tapped (`ListQuery.flag`, URL `flg`, for a flag). The pop-up
(`_ui/filter-panel.tsx`) stages every choice until Apply, says what Apply would
leave (`erpListCount`), and writes the ordinary `cf` reading, honoured on any
drawn column — so export, Select all and the selection totals follow it. The
godown moved inside it; the period kept its own button. The list's status
values are one Breakdown card (`_ui/stat-row.tsx`). The Excel funnels on
column headings are gone — the Dispatch register's columns are sections now.
Hand-built pages (the dashboard, Logistics' desks, Petty Cash's transaction
tables, the Dispatch desk, Under Process, the Quotation manager) do not use the
generic list and have no cards from this.

**THE CRM WEARS THE ERP'S LOOK AND ITS QUIET RULES (Oct 2026), and nothing on
it was taken away.** The look is one sheet, `src/styles/v4-theme.css` (it was
`app/erp/erp-theme.css`), answering to a `data-v4` marker on the shell: the
ERP's shell carries it, and the CRM's through `AppShell look="v4" app="crm"`.
Accounts shares `AppShell` and has not asked, so it is drawn as before. Every
selector names the marker (`quiet-crm.test.ts` refuses one that does not),
because a stylesheet a layout imported stays in the document after a client
navigation away. What the CRM gets beyond the ERP's look is keyed on
`data-v4-app="crm"`: its spaced-capital labels read in sentence case (table
heads stay capitals). The shared pieces carry the rules: `Field` takes
`required` (a red `*`), `optional` (small grey) and puts its `hint` behind an
ⓘ (`components/ui/hint-tip.tsx`) unless `hintShown`; `PageHeader` and the
console's `ScreenHeader` move a string subtitle behind an ⓘ by the title unless
`subtitleShown` (for a fact — a month, a record's name); `EmptyState` keeps its
title and puts the sentence behind the ⓘ. Each does this through classes the
sheet reads (`ui-field-label`, `ui-hint`, `ui-hint-tip`), so the apps without
the marker are unchanged. A list with many filters puts them behind one
`FilterPanelButton` (`components/ui/filter-panel.tsx`) with the chips of what is
on left on the bar — Customers' nine are there, and Payment follow-up's stage,
slow payers and month-end view. Never write "· required" or
"(optional)" into a CRM label; the test refuses it. The Tele CRM canvas
(claude.ai artifact "Tele CRM — ERP design system and less text") is the
board-by-board plan, and it lists, per screen, everything that was kept.

**THE SALES DASHBOARD WEARS IT TOO (Nov 2026).** Its own shell
(`app/sales/sales-shell.tsx`) is the ERP's frame — the sidebar the full height
under the Mahek mark with "Live now" at its foot, the lavender header beside it
with the switcher, the scope line, the search, Ask, the bell and the account
menu — and carries `data-v4 data-v4-app="sales"`; the layout imports the sheet
and Geist. The console's own parts (`components/console/parts.tsx`) are drawn
in the ERP's forms: `MetricRow` is figure cards, `Pill` is a sentence-case
`ui-badge`, `Button` carries the `ui-btn` markers, cards are `rounded-card`.
The sheet's sentence-case label rule answers to `sales` as it does to `crm`,
and a head cell with `aria-sort="none"` is no longer drawn as the sorted one.
Nothing about what any screen shows or does moved.

**AN ERP SCREEN DRAWS EACH PIECE ONE WAY, AND A TEST READS THE SOURCE.**
The screens had drifted into twenty-two spellings of the small uppercase
label, four heading sizes, three checkbox looks, ten text-link buttons and
money formatted by hand — each a class string copied from a neighbour and then
tweaked. `src/app/erp/_ui/look.tsx` is the ERP's kit: `SectionTitle` and
`SubTitle` for headings, `Eyebrow`/`eyebrowClass` (11px) and
`SectionLabel`/`labelClass` (12px) for labels, `LinkButton`/`linkClass` and
`IconButton` for the small controls, `popoverClass` and `insetClass` for
surfaces; `checkboxClass` sits in primitives beside `Checkbox`, and the
tokens `tracking-label` and `shadow-pop` in `globals.css`.
`erp-design.test.ts` fails on a hex colour, a `text-[Npx]`, a typed
`tracking-[…]` or popover shadow, a hand-drawn heading or uppercase label, a
bare checkbox or table cell, `toLocaleString`, and a typed `/erp/…` address,
anywhere under `src/app/erp` except the printed labels. Reach for the kit; if
it has no piece for what you need, add one there rather than typing the
string a second time.

**A PARTY CAN BE RENAMED, AND THE SHEETS STILL FIND IT.** The ERP's Sales
Party edit has a Party name field, and the CRM's customer form always had one.
The Sales Party, Taken Order and Order Details tabs name a party by TEXT, so a
rename used to be undone by the order projection within the half hour and to
cut every name-matched link (the party master's phone, seats and salesperson,
where an order was delivered, the back office handover). The first rename now
keeps the name the sheets use in `customers.sheet_name` (`0282`), and every
sheet matcher asks for either name — `sheetKeys` in `lib/customer-rename.ts`,
pure, is the one rule. Setting the name back to the sheet's exact spelling
clears it. A name another live party already carries is refused.

**A DROPDOWN OFFERS WHAT IS ALREADY IN USE, AND NEVER DROPS A SAVED VALUE.**
Segment, counter type, transporter and godown city were reference lists nobody
had filled, so the customer form said "Nothing available" over data the Sales
Party sheet had carried for years. `refOptions` (`lib/erp/refs.ts`) is the
configured list plus the values in use (and every Indian state); it feeds the
customer and godown forms, while `refValues` stays the configured list wherever
a rule checks against it. And a select whose list lacks a record's saved value
now offers it first (`withSaved` in `_ui/field.tsx`) — "Choose…" over a value
was a blank written on the next save.

**A LIST VALUE IS RENAMED ONLY WHILE NO RECORD CARRIES IT.** Records copy a
reference-list value as text — synced sheet rows, jsonb test results, arrays
of tags — so a rename either rewrites all of them (and the next sheet sync puts
the old spelling back) or strands them on a spelling the list no longer has.
`refRenameRefusal` (`lib/erp/refs.ts`) refuses a value any column in its
`STORED_IN` map carries, a spelling a rule reads (`REF_RULE_SPELLINGS`:
"Chemical", "Chemical Scrap", "Bank charges"…), and every value of a list the
map does not name. A new list that records copy needs its columns added there.

**Every write goes through five server actions** (`lib/actions/erp.ts`): run
an action, run a bulk action, run a header tool (a `ToolSpec` with no `href`,
answered by the module's `tools`), submit a form, load a form (which writes
nothing and is the one a preview may open). Each re-checks that
the person holds the SCREEN before the screen module's own handler checks any
power, because a server action is a URL and a hidden button is not a
permission. Screen modules live in `lib/erp/screens/`; a module is a loader
(rows, the columns a person's powers reveal, and each record's actions with
the reason one is not yet available) plus its handlers.

**The generic screens are ports of the design**, in `app/erp/_ui/`: the list
(search, godown filter, grouping with aggregates, chips, bulk bar, pager), the
record dialog, the form dialog (header plus lines for a multi-line document),
prompts, confirms and the toast. Rules are the server's; the client only
filters, sorts and pages what it was sent.

**A RECORD OR A FORM OPENS IN THE MIDDLE OF THE SCREEN, IN TABS OR PAGES,
NEVER IN A SIDE DRAWER — and that is a reversal (Oct 2026).** Every ERP record
and form was a 600–680px drawer at the right edge: a twenty-five-field purchase
was one column somebody scrolled and lost their place in, and a requirement's
purchase flow sat above forty labels. `app/erp/_ui/dialog.tsx` is the one
frame — `ErpDialog` (z-60, under the prompt and confirm at z-70), its header,
body and foot, `TabBar` and `StepBar`. A RECORD (`record-dialog.tsx`) is tabs:
the screen's own panel first, named for what it is (`PANEL_TAB` — "Purchase
flow", "Trace", "Test evidence"…), then Details three to a row; the actions sit in the foot on every tab, a
held-back one drawn with a lock, and pressing it says why in one line (there is
no "Not available yet" tab any more). A FORM (`FormDialog` in `erp-ui.tsx`) is pages, planned by
`form-pages.ts` (pure, tested): seven fields or fewer and no lines is one page;
longer forms are cut at the fields' `sec` headings, small sections packed up to
eight fields a page; a document's lines are a page of their own; more than one
page ends on Review, which says back every value with a Change link per page.
Next checks the page you are on; Save checks everything and lands on the first
page carrying an error, the server's included. So a long form gets its pages
from `sec` — give a new form's fields sections where they fall into groups, and
order its fields so each section is consecutive. The goods receipt
(`grn-dialog.tsx`) keeps its own item → PO → details flow inside the same
frame, and Logistics' transporter record and edit are tabbed the same way.

**The working location is chosen from the godowns a person is assigned to**
(`erp_godown_staff`), never typed; an administrator is assigned everywhere.
Nobody assigned means no working location, said in words in the header, not a
guessed default.

**THE WORKING GODOWN IS FOUND BY STANDING IN IT, where it can be.** Once per
tab, if the browser already holds location permission, the header takes a fix
and `erpLocateWorkingGodown` measures it against the pins of the godowns that
person is ASSIGNED to — on the server, so a crafted fix can only choose what the
menu would have offered. `erp.location.godownRadiusM` is the fence; where two
overlap the nearer pin wins, and a fix whose accuracy is wider than the fence
answers "too vague" rather than guessing, because a wrong godown pre-fills every
form. The browser's permission prompt is never raised unasked — a dialog on
every page load teaches people to press Block — so the locate button beside the
chip is how permission is first given. A godown picked by hand stays picked for
the rest of the tab. The fix itself is not stored: the audit row names the
godown and the distance from its pin, which answers "why did my location
change" without recording where anybody was. A godown with no pin cannot be
found this way, and asking says so.

**The ERP extends MahekOne's records rather than copying them** (PRD §8): a
Sales Party IS a `customers` row plus `erp_customer_profiles`; a product IS a
`products` row plus `erp_product_packing`; price lists are the Price Desk's,
read; employees are HRMS's, and the ERP no longer draws its own copy of them. "Deactive" is the customer's own
`status = deactivated`, so the CRM and the ERP cannot disagree about whether a
customer is closed. "Item Lost Record" is a reserved godown, so a write-off is
a movement into a real location rather than stock that simply vanished.

**Stock is read off ledgers, one inflow ledger per stage** (`erp_rm_entries`,
`erp_sfg_entries`, `erp_fg_entries`, `erp_pack_entries`), each entry written by
exactly one source document and following it through every edit. Outflows are
NEVER entries: `lib/erp/stock.ts` reads them from the documents that consume
stock (transfers out, SFG use, filling, packing lines, lot allocations to
orders), so deleting a consuming document gives the stock back on its own.
Every consuming save takes `lockLot` — an advisory lock on (stage, lot,
godown) — and reads the lot's stock INSIDE the same transaction before
refusing in the source's words. Reading it with the pool, outside the
transaction, is how two saves both spend the last litre.

**Automations run in the save that qualifies them** (spec §18): a rated
purchase posts to RM stock, a complete packing batch posts its one entry, a
line is billed and enters order details in one step, a bill's first verified
line opens its transport record (a unique index is the "once"), and an inward
line goes to testing or to the register AS IT IS SAVED — the item's testing
list already answered which, so the "Send to Testing / Send to Purchase" press
Mahek Plus asked for is gone, kept only as the way out for a line the register
refused (a lot number already taken). A purchase's bill and its status are one
progress line (`purchaseStage`: Arrived or Tested → Bill received → Matched →
Verified); recording the bill is the Invoice Received step, and a status past
Pending means the bill is in hand.

**ONE ORDER BOOK, and the ERP writes into it once it takes the orders.**
MahekOne's `orders` and `bills` are what targets, the Call Log, outstanding,
the buying cycle and the owner's KPIs read, and they were filled from the
Taken Order and Order Details sheets. An ERP keeping its orders to itself was
a second order book none of those could see. `erp.orders.live` is the
cut-over: off (the default) the ERP runs on its own and the sheet stays the
source; on, `lib/erp/book.ts` writes every ERP order NUMBER as one `orders`
row (`source = erp`, `ERP-<n>`) and, once dispatch-verified, one `bills` row
(`ERPBILL-<n>`, `stated`, under the Tally number or the sheet's fallback
chain) — the sheet projection writes no customer, order or bill, a Pending
customer's order waits in the Accounts approval queue instead of on "Approved
By Admin" (`afterBookDecision` tells the ERP lines the answer),
`recomputeOrderSystemHolds` reads the ERP's open lines instead of the Taken
Order tab, and `syncOne` asks the second-order rule (`convertIfNowQualified`)
of every booked order not cancelled or declined. The book copy is a PROJECTION rewritten whole after every ERP
order write (`syncBookOrders`), never edited in place, and its keys are its
own so the sheet can never overwrite it. `npm run jobs -- erp-book-sync`
rebuilds all of it on go-live day. Never turn the switch on while the team is
still typing orders into the sheet: every order would be counted twice.

**THE WORKBOOK IS RETIRED BY TWO SWITCHES, because its halves end on
different days.** `erp.orders.live` retires the ORDER tabs — Order Details,
Payment Status, Taken Order — and `erp.orders.partySheet` (default on)
retires the Sales Party tab, which goes on filling seats, deactivations and
blank phone/GST/credit/price-list fields until the office keeps those in
MahekOne. `lib/engines/sheet-retirement.ts` is the one answer: `runJob` asks
it before anything else and turns a retired read into a `job_runs` row whose
detail is the reason — the droplet cron keeps calling the modes and keeps
getting 200 — while `triggerJob`, `runBillImportAction`, the two import
screens, the freshness monitor and Integrations all say "Retired" with the
same sentence. No staging table is deleted. The Call Log hold has to be
REBUILT ON THE HOUR now (`recompute-order-holds`, last in `runHourly`):
its only scheduled writer used to be the Taken Order sync, the nightly never
called it whatever the docs said, and a retired tab would have frozen it on
the day of the cut-over. The hand-run cut-over steps are on the order-book
docs page.

**Billing is one step, and dates are dates.** Mahek Plus asked for "Done" and
then "Add To Order Details", because billing lived in another sheet; "Bill
it" is both, and "Undo billing" is the way back until dispatch-verification.
Today, Tomorrow and Delay were dates written as statuses — `dispatch_on` holds
the date and the lists say today, tomorrow or late from it. The order screens
are tabs of one Orders screen, order follow-up is the CRM's buying cycle rather
than a second prediction, and a customer's monthly target is the CRM's Monthly
Targets row, never a column of the ERP's own.

**A COMPLAINT IS A COMPLAINT, whichever app raised it.** The ERP's "customer
requests" were a second table with the CRM complaint's own fields, so a
salesman's complaint raised in the ERP never reached the telecaller on the
customer's next call, and credit notes were recorded in two places. The ERP's
Complaints & credit notes screen reads and writes `complaints`: raising goes
through `createComplaint` (`lib/services/complaint-create.ts`, which the CRM's
`logComplaint` also calls, so both get the SLA and the opening history line);
accepting and rejecting are the complaint's own status, decided by the ERP's
"decide requests" power; issuing a credit note is the Accounts service
(`issueCreditNote`), so it comes off the bill in the ledger and needs
`creditnote.issue`. "Pending CN" and its Credit Note Updater are gone — an
order line's margin reads the issued credit note where it is
(`issuedCreditNotes`). An ERP-only user opens a complaint's files through the
ERP's complaints screen (`canRead` falls back to it). 0184 carried every ERP
request across under the same id; `erp_requests` is retired, not dropped.

**BUT THE ERP SEES ONLY PRODUCT QUALITY COMPLAINTS (Oct 2026).** Every ERP
read of `complaints` — the screen's three tabs (`complaintRows`), its sidebar
badge, the dashboard tiles, the "credit note not issued" alert and the file
fallback in `canReadErpAttachment` — is narrowed to `category =
'product_quality'` (`ERP_COMPLAINT_CATEGORY`). The ERP raise form has no type
and always writes Product Quality; accept, reject, issue and resolve refuse any
other category; the AI helper suggests a summary only, never a type, because a
changed type would only take the complaint off the ERP's list. The CRM and
Accounts still see every category. A customer return's complaint of another
category (damaged, wrong product) is therefore issued from Accounts alone.

**THE PURCHASE FLOW IS Requirement → Purchase method → Vendor / Quotation →
Approval → PO → Receipt, and NO PURCHASE IS COMPLETED WITHOUT A PO.** Goods
inward (the GRN) names an approved PO and every line one of its items; a lot
entered by hand on the register does the same; neither takes a typed supplier
or item any more. `engines/purchase-flow.ts` is the rule, pure, and
`screens/purchase-flow.ts` the requirements and the Purchase orders screen. The receipt side stays in `screens/purchase.ts`.

**THE PO COMES BY THE ITEM'S PURCHASE RULE, AND NOTHING IS APPROVED — a
reversal (Oct 2026).** The flow is now Requirement → Purchase method → PO
number → Receipt (the blind count left it in Nov 2026, below); the vendor /
quotation step and PO approval in the paragraphs below are history. At the
purchase method the item's rule (`poRouteOf`) decides, and both happen inside
the requirement's record (`screens/requirement-po.ts`, the `purchaseFlow`
panel):

- **Quotation** — the rate is chosen and bought on the Quotation manager.
  Purchase it asks only for the drums: **the PO number is MADE by the server**
  from the ERP's own `po` series (`applyQuoteOps` mints `PO-n`; a typed one is
  ignored; editing keeps it; undoing gives it up). The requirement's tab has a
  PO NUMBER box (never a pop-up): what is typed is looked up on the sheet
  (`erpRequirementPoLookup`, a read) and shown, then **Link PO** keeps an ERP PO
  for it — `source = 'quotation_manager'`, `qm_po_no`, the same `po_number`
  where the sheet made it, status **Sent**, the cell's rate, drums and
  `erp.purchase.poGstPercent`. Several requirements on one number are one PO.
  **Unlink** is allowed while nothing has arrived; a PO left empty is cancelled
  and reused if linked again (the number is unique).
- **Direct purchase** — no quotation. **Create PO** opens a three-page modal
  (Vendor → Delivery → Review) OVER the requirement, which stays open. The rate is
  the item's `erp_raw_materials.price_paise` and is never read from the request;
  **no price is ₹0** (`0275` lets a PO line's rate be 0), and the register then
  holds that lot out of stock until the bill's rate is entered, like any lot
  with no rate. The PO is **Approved** on save, ready to send and receive.
- **Buyer decision** — either.

A new PO on the Purchase orders screen is Approved on save too. POs raised
before this that still say Pending approval keep their Approve / Send back
buttons, and the dashboard tile shows only while one is left. A new GRN starts
from the item (#829); the PO-in-header form ("Receive goods" on a PO, "Add
more") types its PO (`FieldSpec.typed`) and the receipt also accepts a bare
number. Every screen names a PO with `poName` (the sheet's number where it came
from there). The old decide / vendor / quotation handlers remain for records
already on that path; nothing on the requirement offers them.

**A REQUIREMENT CARRIES EVERY ITEM A DEPARTMENT NEEDS, under one number.**
It used to be one item per form, and a department's monthly list is a hundred.
Each item is still its own `erp_requisitions` row — its method, quotations,
vendor and PO line are decided per item, and everything after the raise reads
one item — and the rows raised together share `req_no` (`REQ-n`, series
`requirement`), written in ONE transaction so a requirement is never half
raised; a bad line refuses the whole save and names its row (`l3.item`).
Editing stays per item. The form is the `table` line layout
(`app/erp/_ui/line-table.tsx`): a header, then one row per item, added from a
search or by pasting a list ("Toluene, 200" a row, straight from Excel) that
`parsePastedLines` matches exactly or uniquely and never guesses. A header that
names one item itself and sends no lines is a requirement of one item, which is
what the re-order levels' "Raise requirement" still sends.

**THE GRN STARTS FROM THE ITEM THAT ARRIVED.** The gate knows what came off
the truck, not the PO number, so a new goods receipt is `flow: "grn"`
(`app/erp/_ui/grn-dialog.tsx`): search the item, pick one of the approved PO
lines still open for it (picked for you where there is one), then the ordinary
line fields. Every line carries its own `po`, so one GRN may span several POs —
of ONE vendor: "Add another item from this truck" searches only that vendor's
open lines, and `inward.new` refuses a second vendor. The pick is pure in
`engines/grn-pick.ts`; an item with no open line is listed as "Cannot receive",
never hidden. "Receive goods" on a PO and "Add another" on a PR keep the
PO-in-the-header form, and a line naming no PO takes the header's.

**The ITEM MASTER says how an item is bought** — `erp_raw_materials.purchase_method`:
`direct` (boxes, cans, stationery, routine chemicals: pick the vendor, raise
the PO), `quotation` (price-sensitive chemicals: bought on the Quotation
manager, whose PO number the requirement links) or `buyer` (the buyer decides per requirement, with the
`purchaseBuyer` power). `preferred_supplier_id` is the vendor a direct purchase
is offered. **The rule is COPIED onto the requirement when it is raised**
(`purchase_rule`, and the resolved `method`), so changing an item's rule never
re-routes a requirement already in flight. `0222` started every chemical on
quotation and everything else direct.

**A REQUIREMENT HAS NO QUOTATIONS TAB, and that is a reversal (Oct 2026).**
Quotations were collected, compared on landed cost and selected on the
requirement itself (a Quotations tab, `erp.purchase.minQuotations`, a PO that
refused any rate but the selected one's). Supplier rates are now kept on the
Quotation manager, and a quotation item links the PO number made there, so the
tab, its form and actions, the ranking engine and the setting are gone.
`erp_quotations` and the requisition's `quotation_id` and `selection_note` are
kept as the record they are and read by nothing. The Quotation manager's grid
lists its rows LATEST FIRST — newest date on top, the last entered first within
a date (`visibleRows` in `engines/quote-sheet.ts`).

**PURCHASE IT WRITES THE PURCHASE ORDER, not only its number.** The dialog asks
the requirement (or none, and one is raised with the purchase, remarked
`QM_RAISED_REMARK`), the quantity, the godown and the delivery date, and
`orderFromQuote` (`screens/requirement-po.ts`) writes a `Sent` PO
(`source = quotation_manager`, `qm_po_no`) with one line keyed on the cell, in
the cell's own transaction. Changing the drums syncs the line; undoing withdraws
it (`withdrawQuotePo`), refused once goods arrived. It happens only when the op
carries `order`, so an older page still just mints the number and the
requirement still links it.

**WHO MAY ACT IN PURCHASE IS SET IN THE ADMIN CONSOLE, and only there.**
Raising a requirement, raising a PO and recording a lot test follow the screen
grant; approving a PO is the `approvePurchaseOrder` power. A per-material
"Who does what" layer (#690) once narrowed those per raw material, and for
approval it overrode the power in both directions — a named person approved
without it, a power holder not named could not. Two places answering "who
approves this PO" is one too many, so it was removed and
`0271_material_duties_removed` dropped its table. The department rule
(`lib/erp/departments.ts`) still applies: it rides on the designation, which
is itself set in the Admin Console.

**A requirement's STAGE is derived, never typed** (`requirementStage`): Waiting for PO number (quotation), Create PO (direct), Create or link PO
(buyer), PO awaiting approval (an old PO only), Waiting for goods, Partly
received, Received, Closed short, Cancelled. `erp_requisitions.status` is written by the flow (Pending → Order
Placed on approval → Received) and the old "Change status" button is gone,
because a status somebody types can say Received with nothing in the gate.

**A PO is raised FOR APPROVAL and approved by somebody else.**
`approvePurchaseOrder` approves or sends back; whoever raised a PO cannot
approve it unless they are an ERP administrator. Only an approved PO is shared
(see below) or printed at `/erp/po/<id>`, and only an approved PO is received
against.
Sent back or cancelled, its requirements return to Ready for PO with their
vendor; a PO with goods against it is CLOSED SHORT with a reason instead.

**A PO IS SHARED FROM ITS ⋯ MENU — WhatsApp, email or a copied link — and every
person it reaches is a row.** "Share…" (an action carrying a `ShareSpec`, drawn
by `_ui/share-dialog.tsx`) replaced "Send to vendor", which only recorded how a
PO went. It offers the vendor (ticked) and the receiving godown from their own
records, plus anybody typed in, checked by `readShare` (`engines/po-share.ts`)
— a number WhatsApp cannot reach is refused by name, never dropped.
`sharePo` (`lib/erp/po-share.ts`) sends WhatsApp through Wati only where the
founder's switch, a key and `erp.purchase.poWatiTemplate` (an approved template
asking only for `PO_WATI_PARAMS`) all hold, and otherwise hands back a wa.me
link per person; email goes from MahekOne with the PDF attached
(`renderPoPdf`, pdf-lib, the printed PO's figures) where a mail provider is
set, otherwise a mailto link. Every message carries `/po/<share_token>`, the
PDF with no sign-in, minted on the first share and answering only while the PO
is one a vendor may act on. `erp_po_shares` keeps each person, address,
message and outcome (Wati ticks via the `eposh_` id); the first share moves an
Approved PO to Sent. The PDF has rates, so sharing needs `viewPurchaseMoney`.

**What has been received against a PO line is READ, never stored**
(`receivedByLine`: inward lines plus hand-entered register lots), and
`refreshPurchaseOrder` rewrites the PO's receiving status and its
requirements' status inside the receipt's own transaction.

**A RECEIPT IS NEVER REFUSED FOR ITS QUANTITY; IT CORRECTS THE PO (Nov 2026, a
reversal).** It used to refuse anything past the PO plus a tolerance, and a
shortfall waited for somebody to close the PO short. Weights and counts at the
gate never match the PO, so whatever arrives is received and the person making
the GRN corrects the PO there: a row in `erp_po_corrections` (0357) under the
PO line, signed — `extra` (+, unless they chose "Leave the PO as it is") or
`short` (−, only where they said nothing more is coming) — at the LINE'S OWN
rate and GST, copied. The line itself is never edited. A line now EXPECTS its
quantity plus its live corrections (`expectedOf`), and every status, pending
figure, total (`pricedLines`), the print, the PDF and Share read that. A wrong
correction is cancelled with a reason and stays struck through; only an ERP
administrator changes a correction's rate (`original_rate_paise` keeps the
old one). Each of the three moves `erp_purchase_orders.revision` ("Rev n").
`erp.purchase.receiptTolerancePercent` (now 10) only FLAGS a line that ends that
far from its original quantity ("Quantity differs from PO"); it stops nothing.
A PO received in full in the last 30 days still takes a late truck, as an
extra. The GRN line's questions are drawn by `when: { calc }` from
`inward.isMore` / `inward.isLess`. Rules: `receiptGap`, `correctionFor` and
`quantityDifferenceNote` in `engines/purchase-flow.ts`.

**A lot is registered at the PO line's rate and GST**, so goods received
against a PO reach stock without anybody typing a rate. The supplier's bill
still moves the register's rate; a rate that no longer matches the PO is
flagged "Rate differs from PO". Rows from before POs carry no PO and say so
("Before POs"); nothing back-fills one.

**`app_id` enum literals cannot appear in a migration that runs on a fresh
database** in the same transaction that added the value — drizzle-kit applies
every pending migration in one. `0222` compares `app::text` and copies the
value from an existing row for exactly that reason.

**What filling and packing use comes out of stock** (spec §14 A-30). Mahek
Plus subtracted empty cans and boxes only on the re-order screen, so the lot
stock counted every can ever bought. `rmLots` now takes the cans a filling
record used and the empty boxes a packing batch used from the item's lots at
that godown, OLDEST FIRST (neither document names a lot), leaving any excess on
the newest lot as a visible negative. `rmLevelAvailable` reads that stock as it
stands — subtracting again would count every can twice — and a packing batch is
refused on its first line when its empty boxes are not at the godown.

**UNDER PROCESS IS THE DAY'S PLAN ON PAPER, AND IT MOVES NO STOCK.**
Sales → Under Process (`erp.underProcess`, beside Orders and the Dispatch desk; carried by the Production Head
designation) is one plan per day (`erp_production_plans.plan_date` is unique)
of SFG manufacturing, loose cans and packing, printed on A5 for the floor, who
never log in. Each line saves on its own; a deleted line is marked, never
removed. Every print is a row with the lines as printed
(`erp_production_plan_prints`), and `engines/production-plan.ts` reads each line
against the last one: given, new, edited or removed — the screen's colours and
the reprint's underline, "was" and "Removed since last print" box are that one
rule. Current available is read at the plan's godown from `sfgLots`, `fgLots`
and `packLots`. The work itself is still recorded on SFG batches, FG filling and
Packing batches. **And the orders under process come in by themselves.**
Every order line Orders → Production lists as Under Process (`isWorkingLine`'s
rule, less empty drums) is one plan line per product (`orderDemand`, pure): a
loose SKU as loose cans of its finished good, a boxed SKU as packing — in boxes,
or in cans where the orders do not make whole boxes, never rounded. Those lines
are `source = 'order'`, keyed `category:item` (`source_key`, a partial unique
index), carry their order numbers (`order_refs`), and are written only by
`syncPlanFromOrders` — on opening, creating and printing a plan dated today or
later; a past plan is the record of its day. A product whose orders all leave
Under Process is marked deleted, so a sheet that carried it says Removed. They
cannot be edited or deleted on the plan: the order is where they change. SFG is
not derived; the Production Head types it.

**A REMARKED ORDER IS ITS OWN ROW (Nov 2026).** The floor could not tell
which cans a remark was for when every order's remark was joined onto the
product's one line. `orderDemand` now keys an order line with a remark
`category:item:o<orderNo>` (`productKey` names the product, `orderNo` the
order), and `buildBoard` takes that demand: the product's row is the confirmed
cans LESS the remarked ones, each remarked order is a ticked row after it, and
stock and verdict stay on the product's row (on the first remarked row when
every order has a remark, and no empty product row is drawn). A remarked row
matches only its own `source_key` line, never a typed line for the product.
`planBoard` reads an order row's remarks from the live orders, not from the
stored line — a line printed before the split carried every order's remark.

**AND THE PLAN IS ONE PAGE: TICK ROWS, PRINT (Nov 2026).** The plan screen
is one table (`engines/plan-board.ts`, `buildBoard`, pure), built on every open
from the order demand, the expected work and the lines already on the plan:
a row per product and per base, with Confirmed, Waiting (MRP check / Accounts,
or Expected litres for a base, read by `planExpected` and
`engines/expected-plan.ts`), In stock, If all approved, an editable Make today
and its Unit, filtered per column (`facetValues`). Confirmed rows start
ticked; waiting rows start unticked and, ticked, print as an ordinary line.
Nothing is written until Print plan: `printPicks` writes each ticked row as a
line (update, revive by `source_key`, or insert), soft-deletes every other
live line, then `recordPlanPrint`. A row printing more than its confirmed need
on something still waiting is stored `for_expected` (`beyondConfirmed`); on
paper it is ordinary. The A5 sheet is unchanged and new prints carry no
expected box (old prints keep theirs). Typed lines (Add a line) are their own
ticked rows.

**A recipe is expected, never a gate.** `erp_recipes` holds what one batch of an
SFG product takes. "Start a batch" opens the SFG form with the recipe's lines, and so does picking the product on a blank New SFG batch (`linesFrom` on the form: lines nobody has touched are replaced at once, typed-into ones only after a confirm),
and a batch line that used more than `erp.production.recipeTolerancePercent`
above it is flagged on the batches list; nothing is refused. A new below-level
alert tells whoever works at that godown and can raise requisitions, once, as it
is raised.

**The AI features draft and a person decides** (`docs/erp/04`). Everything a
rule can do is ordinary code: the alert rules (`engines/alerts.ts`, run hourly
and nightly by `runErpAlerts`, deduplicated by a partial unique index and
resolved AUTOMATICALLY when their condition clears), the batch trace
(`lib/erp/trace.ts`), complaint clusters and suggested levels. Every AI switch
and threshold is `erp.ai.*` configuration. A money or cost alert carries its
power and is shown only to its holders — an AI surface never shows what the
normal screen would not.

**A reading is a pending suggestion until a person saves its review.** Bills,
LRs, test photos, order messages and complaint descriptions are read by a model
into `erp_ai_suggestions` (`lib/erp/ai.ts`: switch, key and monthly cap first);
the matching and flagging after the read is rules (`engines/match.ts`); the
review is the ordinary form, prefilled, with the source beside it, and saving
goes through the ordinary save — so every base rule still applies — and logs
accepted or edited. Each feature splits `read…` (the model) from `record…`
(the rules) so the rules are tested without a model. Ask the ERP answers only
through its tools, and each tool calls the SCREEN'S OWN LOADER as the person
asking, so an answer can never hold a row or column their screen would not.

**The ERP drops the desktop floor** (`AppFrame floor={false}`) — it is used on
a tablet at the godown gate — and every other app keeps it. It was lost once
in a header refactor and every ERP page sat at 1100px; below 1280px the ERP
header draws Feedback and the account chip as icons so it fits a tablet.
