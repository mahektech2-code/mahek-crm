<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# MahekOne

Mahek Marketing India's connected workspace. One database, one design system,
many apps. The CRM is the first — built for the telecaller team and their
managers. Dispatch, inventory and accounts join later on the same schema.

## Stack

- **Next.js 16** (App Router, React 19, Server Components + Server Actions)
- **Postgres** in a container beside the app on a DigitalOcean droplet, not
  addressable from the internet — see DEPLOY.md. It was Neon behind Vercel
  until August 2026, which is why several comments still explain themselves in
  terms of a database running in GMT: that was true and the rule it produced
  (never cast a stored timestamp without naming the zone) outlives the move,
  because a local Postgres set to Asia/Kolkata hides the bug rather than fixing
  it.
- **Drizzle ORM** — schema in `src/db/schema.ts`
- **Tailwind v4** — design tokens in `src/app/globals.css` under `@theme`
- **Auth** — email + password, admin-created, scrypt hashes, DB-backed sessions

## Commands

```bash
npm run dev          # localhost:3000
npm run build        # production build (runs tsc)
npm run test         # engine tests — pure, no database
npm run test:db      # (re)create mahekone_test from the migrations
npm run test:integration   # the six §11 journeys, end to end
npm run test:performance   # salesman targets and the score, on their own
npm run test:owner         # the owner's five KPIs, on their own
npm run db:generate  # write a migration after editing src/db/schema.ts
npm run db:migrate   # apply migrations locally
npm run db:seed      # wipe and reseed with demo data (also clears sessions)
npm run db:studio    # Drizzle Studio
npm run jobs -- nightly    # run a scheduled task by hand
npm run jobs -- sheet-payments             # pull the Payment Status tab
npm run jobs -- taken-order-sync           # pull the Taken Order tab, then
                           # rebuild who is held back from order chasing
npm run jobs -- taken-order-reparse        # re-read what is stored — the one
                           # to run when the RULE changed, not the sheet
npm run jobs -- project-sheet --owner=vikram@mahek.in --bills
                           # staged rows -> customers, orders and bills
npm run jobs -- revert-sheet-paid --dry-run
                           # what a default-settled run wrote over the Payment
                           # Status tab's word, and what undoing it gives back
npm run jobs -- revert-sheet-paid          # undo it, then rebuild the caches
npm run jobs -- customer-master-sync        # the EMP 2.0 shop master -> staging
npm run jobs -- customer-master-project --dry-run
                           # what the shop master would create, writing nothing
npm run jobs -- customer-master-project    # publish it into customers
npm run jobs:prod:sheets -- customer-master-sync
                           # the same against prod: .env.local FIRST for the
                           # Google credentials, .env.prod.local SECOND so its
                           # DATABASE_URL wins. Reversed, a "prod" job writes
                           # to the local database and reports success.
npm run hrms:sync    # pull the employee sheet now
npm run app:grant -- hrms vikram@mahek.in   # give somebody an app
npm run catalogue:parse    # regenerate the product master from the document
npm run catalogue:import -- --dry-run   # what the import would change
npm run catalogue:import   # apply it — idempotent, re-runnable
npm run check:links  # crawl the running app for broken links
                     # scripts/perf-audit.sql — what the hot screens cost, on
                     # the real book. Read-only, no meta-commands, runs in the
                     # droplet's Postgres container. See its own header.
npx eslint src       # lint, including the React Compiler rules
```

Development runs against your own local Postgres — `npm run db:setup` gets a
fresh clone from nothing to running. Only `DATABASE_URL` is required.

## Seeded accounts

Password for all of them: `mahek1234`

Sign in with the email **or** the work number.

| Email | Work number | Role | Apps | Lands on |
|---|---|---|---|---|
| `priya@mahek.in` | 9820011001 | telecaller | CRM | straight into the CRM |
| `rakesh@mahek.in` | 9820011002 | telecaller | CRM | straight into the CRM |
| `anjali@mahek.in` | 9820011003 | telecaller | CRM | straight into the CRM |
| `suresh@mahek.in` | 9820011004 | telecaller | CRM | straight into the CRM |
| `neha@mahek.in` | 9820011005 | telecaller | CRM, Reports | the launcher |
| `vikram@mahek.in` | 9820011006 | manager | CRM, Accounts, Reports, People, HRMS, Admin | the launcher |
| `mahesh@mahek.in` | 9820011007 | field salesman | Salesman App | signs in on the web to `/apps`, which says there is nothing for him there — his app is MBOS, the mobile handset, not a browser |
| `deepa@mahek.in` | 9820011008 | accounts | Accounts | straight into order approvals |

## How sign-in works

**One sign-in for all of MahekOne** — there is no per-app login. `/login` takes
a work number *or* an email, because telecallers know their phone and office
staff know their email.

Where you land depends on what you can open:

- **one app** → straight into it, no launcher (a single option is not a choice)
- **several** → `/apps`, the launcher
- **none** → `/apps`, which says so plainly instead of showing a blank screen

`app_access` is a row per user per app. It is checked in each app's layout, not
just used to hide launcher tiles — a bookmarked `/accounts` must not open for
somebody who was never given it.

**One app on that list opens no browser tab at all.** `field` is MBOS, the
handset a field salesman signs into over its own API — granting it is granting
mobile access and nothing else. It stayed a real `APPS` entry (so `app_access`
has an id to grant and the Admin Console has something to tick) with a genuine
web route behind it, `/field`, that only ever showed "not built yet" — because
every other app on this list follows "grant it, get a launcher tile, screens
arrive later," and `field` was given the same treatment on the assumption its
turn would come. It will not: there is no web screen coming, ever, so the tile
was not a preview of anything. `mobileOnly: true` on its `AppDefinition` and
`webApps()` — one function, read by the launcher, every switcher and the
straight-into-it redirect above — leave it out of all of them, so granting it
gives a phone a way in and gives the browser nothing to show for it.

**An app is not the smallest thing that can be granted.** `app_module_access`
narrows a grant to particular screens, and a module is a destination in an
app's navigation — that is the whole rule: if it has a place in the sidebar or
the header it can be withheld, and if it does not, it is part of the screen its
link belongs to. The registry is `lib/modules.ts`, pure and client-safe, so the
review table on the access screen renders the same list `requireModule` enforces
on the route. Withholding is enforced twice: the sidebar draws only what
somebody holds, and each module folder has a layout that redirects a bookmark
past it to the first module they do hold.

**No module rows for an app means every module of it.** That is why adding this
moved nothing: every grant that already existed carried on meaning exactly what
it meant, on every screen, for everybody, and a grant narrows only once somebody
unticks something. It is also what keeps `npm run app:grant` and the
provisioning endpoint honest — neither knows modules exist, and an app granted
from a terminal has to open whole rather than open empty. A grant with every
module ticked stores no rows at all, so a fifteenth CRM screen reaches everybody
holding the whole app and nobody who was deliberately narrowed.

**Revoking an app takes its module rows with it.** Left behind, they would
silently narrow the app the day somebody granted it back — four screens of
fourteen, with nothing on any screen saying why.

**THE HANDSET MAP IS OLA MAPS, the same supplier the console uses.** Two map
suppliers is two bills, two outages and two answers to "why does this shop sit
in the wrong lane". `sales/ola-maps.tsx` records the style quirks the web hit;
the handset uses the same style URL and the same key, which now travels in the
sync payload.

**That key is the SECOND named exception in `lib/secrets.ts`, and the caveat is
not the same as the first.** A tile key has to reach whoever asks for tiles — a
key that never left the server could not load a street — and the browser's
mitigation is to restrict it to a domain. A phone has no domain, and Ola's
console offers no package-name or signing-certificate restriction of the kind
Google Maps has. So a key in an APK is extractable, and the honest mitigations
are a SEPARATE Ola key for the handset, revocable without taking the console's
maps down, and a spend cap on it. It is sent only to a device already
authenticated as a bound handset, which is the most the server side can do.

**A PIN IS ONLY DRAWN WHERE THERE IS A FIX, and what could not be drawn is said
in words.** Half this book has never been pinned. Spacing those shops out to
fill the screen is the one thing a map of where things are must not do, and a
map that silently omits a third of the book is one somebody plans a day from and
is wrong. NO MAP is an answer too: with no key configured the screen says so
rather than drawing a grey rectangle, which is the rule the microphone already
follows.

**The tap means a different thing on each SCREEN, not in the component.** On the
customers list it opens the record; on the journey picker it picks a stop. The
map takes a handler, so neither screen has to know the other exists — and MapLibre
React Native's `LngLatBounds` is `[west, south, east, north]`, which is GeoJSON's
order and NOT the `ne`/`sw` pair the web's MapLibre GL takes. Two libraries, two
orders, and getting it wrong opens the map on the wrong hemisphere rather than
failing.

**A LEAD IS A ROW IN BOTH HANDSET TABLES, so the book's view asks an EXISTS.**
The office collapsed leads and customers into one `customers` row long ago, and
the wire still sends leads down their own channel into `leads` keyed on the same
id — so "is this a lead" on the handset is a correlated subquery against that
table, never a column read. `archived = 0` is part of it: an archived lead is
one filed out of the way, and letting it remove a shop from the Customers view
too would leave that shop on no screen at all.

The Everything / Customers / Leads chips are a VIEW and not a scope. All three
show only his own book, already narrowed to the territory he works, and nothing
there reaches another salesman's. They sit beside the origin chips rather than
inside the filter sheet because they change what the list IS, and a list whose
subject is hidden behind a menu is one people misread.

**A TERRITORY NARROWS A BOOK. IT IS NOT A PERMISSION.**
`mbos_user_territories` — renamed from `mbos_manager_territories`, because it is
no longer only a manager's — says which geography a person works, with a `kind`
of state, region, city or beat. A salesman allocated Nagpur sees HIS customers
and HIS leads in Nagpur, never another salesman's: `ASSIGNED_TO_SQL` and the two
seats beside it remain the whole of who may see what, and the territory clause
can only remove rows from what they already allow.

The distinction is worth stating because the two look alike from a distance, and
a reader who mistakes this for the security boundary might delete a real check
believing it redundant.

**NO TERRITORY NOW MEANS NO BOOK, and that is a REVERSAL.** It meant no
narrowing until this landed, and the old reasoning is still true rather than
wrong: allocating cities to eight people and forgetting the ninth empties her
handset, and an empty screen is the one outcome nobody debugs, because it looks
like having no work. That failure is already on record here — reading one seat
instead of two gave Seema Roy "queue cleared" on a day she had 195 accounts to
work. What changed is that the other side of the trade turned out to cost more:
an unallocated salesman carried the WHOLE book, which on this book is 2,587
shops on one phone, and nothing anywhere said he should not have them.

So `territoryClause` answers a FALSE condition where nothing is allocated,
never `undefined` — an absent clause and a false one look alike in a type
signature and are opposite answers to "what may this person see", and the
dangerous one should be the loud one. `customerIdsInScope` short-circuits
before the query is asked.

**What pays for the reversal is that the emptiness is NAMED at both ends.**
"Nothing in your book yet" sends a salesman to ask why nobody has given him
shops; it is the wrong sentence when the answer is that nobody has allocated
him an area, and it is what makes an unallocated handset look like a broken
sync for a fortnight. `mbosTerritoryState` rides on the bootstrap AND on every
delta — territory is changed at a desk in the middle of a working day and the
shops leave the phone on the next pull — so the Customers tab says "no area set
for you yet", prints the area where the count is, and the team screen counts
the handsets the office has switched off. A handset with no area is a support
call; one that does not say so is a fortnight of silence.

**Managers and admins are carved out, and only they.** A field salesman works a
beat somebody allocates him. A manager on a handset is not walking one — his
scope has already answered the question — and emptying his phone for want of an
allocation nobody would think to make reads as a broken sync rather than as a
rule.

**A TERRITORY IS A HIERARCHY, picked from the top.** A city belongs to a state
and a beat to a city, so `mbos_user_territories.parent` says what a row was
picked UNDER and `PARENT_KIND` is the one statement of the shape — the dialog
reads it to decide what opens what, the action reads it to refuse a city
arriving without its state, and the clause reads it to know which column a
parent compares against. Empty means not stated, which is every row written
before the column and is read as "this place wherever it is": a city allocated
last month must not silently stop matching because a column arrived.

Down a branch it is AND, across branches OR. Maharashtra plus Pune inside it
means PUNE — so **the narrowest pick in a branch is the allocation** and the
wider ones above it are the path to it rather than a second grant. Stored as
both, the clause would OR them and hand him the whole state, which is the
opposite of what picking a city meant and invisible on every screen afterwards,
because "Maharashtra, Pune" reads like a narrowing either way. `setSalesmanTerritories`
prunes to the leaves, on the server, because a server action is a URL and the
dialog is not the only thing that can post to it.

**The picker is a tree because a flat list was unusable.** `customers.city`
holds whatever the sheet typed, and on the real book that is several hundred
values most of which are whole postal addresses — "06, MAHADEV TOWERS CO-OP HSG
SOC, LTD, LBS MARG, HARINIWAS CIRCLE, Thane, Maharashtra, 400602" offered as a
city. Nesting does not clean that and cannot; it makes it REACHABLE, because a
state's worth of it is a list somebody can search and the country's is not.
`knownPlaces` returns the tree with a shop count on every node, biggest first,
so the city somebody means is at the top and the long tail of addresses is
below it. Shops naming no state are counted and said out loud: no territory can
reach them, which is a real consequence of switching the default off.

**Changing where somebody works TOMBSTONES the shops that leave.** A pull says
what exists and only a tombstone says what stopped, so without this a salesman
moved from Maharashtra to Gujarat keeps every Maharashtra shop on the phone for
ever — and walks to one of them with nothing anywhere looking wrong. The
difference is taken over HIS OWN book rather than over `customers`, or a
reallocation would tombstone thousands of shops that were never on the phone.
An empty BEFORE is read as everything he can see, which is the deploy: a handset
that synced under the old rule holds shops `territoryClause([])` now says it
never had, and diffing against an empty before would leave every one of them
there.

That is also what forced `deletionsSince` to hold the cursor back on a full
page. The cursor moves to `now` at the top of a pull, so a tombstone past the
2,000-row limit fell behind it and was never read again; a book of 2,587 shops
moving to somebody else is 2,587 tombstones from one click.

**One table, and each consumer asks for the kinds it means.** `managerScope`
reads `kind = 'region'` and the handset's book reads the rest, so allocating a
salesman a city cannot narrow a manager's console to it. Two tables would be two
places for "Vidarbha" to be spelled differently.

**THE AGREED CITY IS A HARD FILTER on the pick list, and that overruled us.**
It used to rise to the top without filtering, on the reasoning that a man going
to Nagpur often has one call to make on the way. Mahek's answer is that a day is
a city; the call on the road is added from the customers list or made unplanned
with a deviation reason, which is what that field exists for. The sort is
NEAREST rather than longest-unseen for the same kind of reason — a man filling a
Tuesday morning in one town is choosing a walking order.

**WHAT "NEAREST" IS MEASURED FROM is the part that had to be got right.**
`pickOrigin`: for TODAY it is where he is standing; for any other day it is the
CENTROID of our shops in that city. He picks tomorrow's doors at home, so his
fix is his sofa — and sorting Wardha by distance from a sofa in Nagpur puts the
list very nearly upside down. The centroid needs no geocoding service, no
connection and no city-centre table, and is the better answer anyway: the middle
of our business in that town rather than the middle of the town. With neither a
fix nor a pinned shop it returns null and the caller keeps the old ordering — a
list sorted around an invented origin looks right and is wrong.

**A shop with no pin sorts LAST rather than being dropped**, the same rule the
route engine follows and for the same reason: a shop missing from the day's list
is a shop nobody visits and nobody ever finds out why.

**"WHAT IS NEAR ME" IS ORDERED BY WHAT IS WORTH DOING, not by distance.**
The mapping brief says so in as many words, and `engines/nearby.ts` is the one
place that rule lives: distance is a COST subtracted from what a stop is worth,
never the sort key. A shop with NO reason is dropped rather than listed —
"nearby" is a list of what to do, and the whole book is a different screen
answering a different question. Proximity decides exactly one thing: which of
two shops with the same reason to go to first.

It is deliberately NOT a second copy of the Call Log's ranking. That engine
weighs a promise against a debt against a stock check to order four hundred
names for a telecaller working down a list; this answers "of the eleven shops
within three kilometres, which one now". Re-deriving the first here would be a
scoring system drifting from a scoring system, invisible until two screens
disagree about one shop. **Next Best Visit is the HEAD of that list**, not a
second sum, so the button and the list can never recommend different shops.

**And it needs no map.** Every coordinate, cycle, debt and open task is already
on the handset, so this works with one bar in a market lane — which is the only
moment anybody asks. The map itself stays blocked on a native dependency and a
new APK; the ANSWER was never blocked on either.

**Navigate is a deep link, and that is the whole feature.** No dependency, no
key, no bill, no tile ever fetched. `engines/route.ts` orders a day by
straight-line distance and says in its own header that it is not a routing
service — real turn-by-turn needs a road network, a directions API and a
connection, and the phone that most needs directions has one bar. An app that
has already downloaded the roads beats all of that, free.

**A POTENTIAL IS A JUDGEMENT and is stored with its author and its date.**
`products.priceSource` is still `unset`, so nothing here can derive what a shop
could spend. `potential_monthly_paise` is somebody's estimate, and an estimate
with no date on it is one a reader cannot weigh. The ANNUAL figure and CURRENT
SALES are derived and never stored: the first is twelve times the month and the
second comes from orders, and a stored second copy is one that can disagree.
**The gap is never negative** — a shop buying more than somebody guessed is an
estimate that has been overtaken, and "-₹40,000 opportunity" invites the reader
to see a decline. **No estimate is not a gap of zero**, which would read as "no
opportunity here": null says the true thing, that nobody has judged it.

**EVERY TIMELINE KIND IS A CONSTANT, never a literal at the call site.**
`CRM_EVENT` and `MBOS_EVENT` in `lib/timeline.ts` are the whole vocabulary. The
natural key is (app, kind, source row), so a literal that drifts by one
character produces a stream that can never deduplicate against itself — a
retried sync writes a second copy and the record reads as the salesman having
visited twice. `timeline-coverage.test.ts` reads the source and fails on a bare
string, and on any kind DECLARED and never written, which is the other half:
that one reads on a customer record as a gap in their history rather than as an
unbuilt feature. It found two the moment it was written.

**Where one record produces several events, the STAGE goes in the source id.**
A sample is dispatched, received and reviewed, and all three name the same row —
so `sourceRecordId` is `<id>:dispatched`, `<id>:received`, `<id>:review`. Left
as the bare id the natural key would collapse them onto one row, the first
written would win, and the receipt would never appear.

**QUOTATION IS ABSENT, and that is the honest answer.** §R asks for it; there is
no quotation record in MahekOne to project FROM, and a timeline row with no
source is not a projection — it is a sentence somebody typed, in a table whose
entire discipline is that every row points back at the record that is the actual
truth. A test asserts its absence, so building the record is what deletes the
test rather than the gap being forgotten.

**An internal note's BODY never reaches the timeline.** `visibleToRoles` decides
who may read a note and the timeline has no such gate, so copying the words in
would route a restricted note straight around its own restriction. The entry
records that one was written; the note stays where the rule about reading it
lives.

**"DID WE SELL ANYTHING" IS DERIVED FROM ONE LIST, not restated in SQL.**
`orderCountsSql` used to spell the three counting statuses out as a literal
beside `PURCHASE_STATUSES`, which held the same three — two definitions waiting
to disagree. Adding §N's `in_transit` and `delivered` is precisely the change
that would have split them, and the half that drifts is the SQL: it is read by
the eight money queries and checked by nothing. It is built from the array now,
and `order-status.test.ts` pins the pair against the ENUM as well, so a status
in neither list fails the build rather than silently not counting.

Goods on a lorry are goods sold. An order that reached the customer must not
stop counting towards EOD value, the buying cycle, the product history and
outstanding merely because somebody recorded that it arrived.

**AN ORDER CARRIES THREE PARTIES' WORDS TOO.** `status` is OURS — accounts
accepted it, the godown sent it, the lorry has it. `customer_confirmed_at` is
the SHOP agreeing to what was written down; `delivery_confirmed_at` is the shop
saying the goods came. They are routinely days apart and either confirmation can
come first, so no one column could carry them. `delivery_discrepancy` null means
nobody REPORTED a mismatch, which is not the same as "it was correct" — nobody
was asked.

**A discrepancy notifies and does NOT raise a complaint.** A complaint is the
customer's, with a category and photographs, and inventing one on their behalf
from a delivery note would put words in their mouth on a record they can
dispute.

**A DECLINED ORDER CANNOT BE DELIVERED, whatever a stale handset believes.** The
phone may still be showing an order accounts turned down ten minutes ago —
rejections reach it on the next pull — and marking that delivered would
resurrect a refused sale into every figure `PURCHASE_STATUSES` feeds.

**THE REORDER DUE IS DERIVED ON THE PHONE, from the customer's own cycle.**
There is no reorder channel on the pull and no connection in a market lane, so
`reorderState` reads `lastOrderDate` and `cycleDays`, which every customer row
already carries. It deliberately does NOT restate the Call Log's ranking: that
engine weighs a reorder against a promise, a debt and a stock check to decide
who to ring first out of four hundred, and this answers one question about one
shop the salesman is already outside. The nightly `raiseReorderFollowUps` raises
a task ONCE — the standing open task is the guard — because thirty rows for one
quiet shop is a list people stop reading. Measured cycles only: a default is a
guess, and chasing on a guess rings a quarterly buyer every month.

**A SAMPLE HAS THREE DATES BECAUSE THREE PARTIES ASSERT THREE THINGS.**
`dispatched_at` is us saying it went. `delivered_at` is the carrier, or our own
man, saying it arrived. `received_at` is the SHOP saying it is in their hands.
No two of those are the same fact, and §J turns entirely on the third — "sample
received Yes/No; if No the follow-up remains pending" — which a single delivery
date could never answer. It is the same discipline `payment_receipts` keeps for
money, one module over, and `received_at` is NEVER defaulted from
`delivered_at`: a default would quietly assert something nobody asked the
customer.

**The review call is dated from CONFIRMED RECEIPT.** Not from dispatch, which is
the whole reason the third date exists: a review timed from the day we posted it
rings a customer still waiting for the parcel, and that call teaches them we do
not know where our own stock is. `mbos.samples.reviewAfterDays` is the window,
and the task is raised once, on the transition, so a re-sent confirmation cannot
stack a second one on somebody's list.

**Trial STARTED and trial COMPLETED are two columns, and the gap is the point.**
A trial started and never finished is the commonest way a sample goes quiet, and
it is invisible where the only column is an outcome.

**A REJECTED SAMPLE HAS TO SAY WHY.** The same rule as a lost lead and an On
Hold, for the same reason: the next sample goes out exactly the same otherwise.
Enforced in the handler and stated on the screen before the button is pressed,
because being refused after the fact loses the sentence somebody had in mind.

**AN APPROVED SAMPLE OPENS NEGOTIATION, and that is what unlocks the order.**
§L follows §K deliberately: the sample review is what authorises a commercial
conversation, not the salesman deciding he is ready for one. `afterSampleVerdict`
moves the lead to `negotiation`, which is the stage `handleOrder` requires — so
the gate and the thing that opens it are one mechanism rather than two.

**QUALIFYING A LEAD IS WHAT STARTS THE WORKFLOW.** `qualifyLead` fills the Lead
Manager seat from the ORG CHART — the same `managerNameByEmployeeName` that
`recomputeSalesManagers` reads nightly, asked about one person, so the seat a
qualification assigns and the sales manager the nightly pass writes cannot
disagree about who reports to whom. It notifies, and it raises a validation call
for the NEXT WORKING DAY, holidays included, from the same working-week
configuration the forecast reads. It is IDEMPOTENT — the seat itself is the
guard — because a sync endpoint retries and a second pass must not put a second
call on somebody's list. It does NOT set `lead_manager_decided_at`: nobody
decided this, the org chart did, and stamping it would freeze the seat against
every future org change as a side effect of a lead being qualified.

**It fires from BOTH doors.** A lead qualified from the lead screen and one
qualified by answering a visit's own decision start the same workflow. A
workflow that fires on one of two paths is a workflow salesmen learn not to
rely on.

**THE VALIDATION CALL'S ANSWERS ARE NOT WRITTEN OVER THE LEAD'S.**
`lead_requirement` is what the salesman was told standing in the shop;
`mbos_lead_validations.confirmed_requirement` is what the office was told on the
phone. The two disagreeing is the single most useful thing this call produces —
it is how anybody finds out the report and the shop did not match — and
collapsing them would overwrite the first reading with the second and destroy
exactly that. It is a TABLE and not columns for the same reason: a lead is
routinely validated twice, and the first call is usually the one that matters.

**The requirement VISIT does overwrite them, and that is not a contradiction.**
It is the same person asking the same question better informed, not a second
party's account of it.

**The script is CONFIGURATION.** `mbos.leads.validationScript` holds the
headings and lines the caller reads out, because it is content: it will be
argued about, improved after a bad call and eventually translated, and none of
that should need a deploy — or, on the handset, an APK nobody can recall.

**NO COMMERCIAL COMMITMENT BEFORE NEGOTIATION.** §G says the requirement visit
carries no price, service or quality promise, and an order is the most
commercial commitment there is — so `handleOrder` refuses one against a lead
below `negotiation`. This one IS a refusal, unlike the visit cap, and the
difference is what is lost: refusing a visit loses a record of work that really
happened, while refusing an order loses nothing, because the order was never
agreed with anybody who could agree it. The message names the way forward.

**A SUSPECT CANNOT BE VISITED FOR EVER, and the cap ASKS rather than refuses.**
§B of the brief wants a maximum of three visits "enforced", and enforced as a
block is the one shape this app must not use: `engines/geo.ts` states the
principle the whole field product rests on — a reading is evidence, never a
gate — because a salesman whose visit is refused stops recording visits, and the
company loses the GPS, the competitor note and the reason in order to stop a
number reaching four. What §B actually wants is that nobody keeps visiting a
shop nobody has decided about, and that is bought by demanding an ANSWER.

So there are three states and none of them blocks the visit being made:
`mbos.leads.visitsBeforeDecision` starts the warning, `mbos.leads.maxSuspectVisits`
makes the Prospect-or-not answer mandatory before the visit can be CLOSED, and
past it the manager is notified instead. Keeping it a Suspect asks why. Only
`new` and `contacted` are capped — a qualified prospect visited a fourth time is
a negotiation, not a stall, and must never be asked to justify itself.

**The rule lives in two runtimes and shares its NUMBERS, not a module.**
`visitCapState` is pure and on the handset; `handleVisit` checks the same thing
server-side, because a sync endpoint accepts payloads from a device somebody
owns and a form is not a rule. They cannot import from each other — one is an
Expo package — so what is shared is the two configured thresholds, which reach
the handset on every pull with the rest of the `mbos.*` keys. The comparison is
one line at each end deliberately: a rule small enough to be obvious cannot
drift the way a re-derived one does.

**The decision is written in the VISIT's transaction.** A visit that saved and
a decision that failed a moment later would leave the lead where it was with the
salesman believing he had answered — and the next visit would demand the same
answer again. The count behind it is `count(*)` over `mbos_visits`, not a cached
column: a cache needs a recompute path, an invalidation on every visit write, and
a way to be wrong. On the handset it is the office's count plus whatever is still
in the outbox, because a salesman who made visit two with no signal must still
be asked on visit three.

**ON HOLD IS NOT LOST, and both ask for a reason.** `on_hold` is a live prospect
that is not moving — a plant shutdown, a budget quarter, a decision maker
abroad — and folding it into `lost` made every stalled lead look dead, which is
how a real prospect gets archived by the staleness sweep. It stays ON the
handset for the same reason. Lost asks for a reason because nobody will look
again; this one asks because somebody will, and "back after Diwali" is what
tells them when. `lead_hold_reason` is one column for both that question and
"why is this still a Suspect", because they are the same question.

**A LEAD'S CONSUMPTION IS IN LITRES, and it is the one place cans do not win.**
Every other quantity in MahekOne is cans, because cans are what the customer
says when ordering and litres are derived from the SKU's own packing. There is
no SKU at capture: a prospect says "about two hundred litres a month" long
before anybody knows what pack they will buy it in, so cans would be a unit
nobody has agreed the size of. `lead_monthly_volume_litres` is that number, and
`lead_requirement` is what they want in their own words — free text rather than
a product id, because resolving "thinner for a spray booth" to a SKU at capture
is the salesman guessing on the customer's behalf.

**GST IS ASKED AT THE QUALIFY TRANSITION, and never on the column.** Making a
prospect real means we could invoice them, and that is what the number is for —
so `handleLead` refuses `stage = 'qualified'` without one, reading what is
already stored as well as what arrived so a lead given its number last week
qualifies today without retyping. NOT NULL on `customers.gstin` would refuse the
entire imported book: 5,292 shops came from the EMP 2.0 master with no GSTIN
between them. The constraint belongs on the moment somebody asserts this is a
business we can bill, not on the record.

**A PHOTOGRAPH IS BOUND WHEN ITS PARENT IS WRITTEN, by `bindMbosMedia`.** Media
syncs AFTER its parent — that is the whole point of a separate queue — so the
handset uploads naming `parentId: 'pending'`, because at the moment the camera
closed the record did not exist. Something has to go back and say what it was,
and nothing did: the attachment kept the literal string `pending` for ever, so
`canRead` looked for a record with that id and refused the file to everybody.
It is called after the record is safe and cannot fail the write — a lead is
never lost to a photograph.

**A LEAD HAS TWO SEATS, and only one of them is the book.** The office asks that
the sales manager over a salesman picks up a lead once it is qualified, while
the salesman goes on making the visits — two people on one record, so two
columns. `customers.lead_manager_id` is the coordinating seat. It is read by
`scopedToUsers` and by `assertCustomerInScope`, which answer who may SEE and
WORK a record; it is deliberately NOT read by `ASSIGNED_TO_SQL`, which answers
whose book it is. Moving the owner instead would have been the obvious
implementation and it takes the lead off the handset of the person who was just
told to keep visiting the shop — a lead's owner IS its MBOS scope. It is the
same split `back_office_am_id` already lives under, with the same consequence:
one record legitimately appears on two lists. `lead_manager_decided_at` is the
usual mark that a person chose, so an override survives the next org-chart pass.

**A PERSON WEARS SEVERAL HATS, and the grant is where each one is worn.**
`app_access.role` is the role an app is held under: Vikram is a manager in the
CRM and a clerk in Accounts, which are different powers over different data
rather than one power applied twice. Before it, `users.role` held one value and
decided three separate things — what somebody may do, how much they may see,
and which controls are drawn — so whoever set up the account of a person with
four jobs picked the most powerful and everything else came with it silently.
A grant with NO role means the account's own, which is what every grant meant
before the column existed and what `npm run app:grant` still writes: a terminal
that knows nothing about roles has to go on granting an app that works.

**What you may DO is the union; what you may SEE is resolved PER APP.**
Hold a capability under any hat and you hold it — `canAny`, and
`requireCapability` checks the union. Scope is the other half and it is no
longer one answer for the whole person: `src/proxy.ts` names the app on the
request from its URL prefix, and `resolveScope` reads `app_access.role` for THAT
app. Vikram is a manager on the Sales Dashboard and a telecaller in the CRM, and
the CRM now shows him his own book.

`users.role` stays derived — the widest role held anywhere — because two things
still want "is this person a manager at all": `isManager`, on thirty-one screens
deciding whether to DRAW a control, and the fallback where there is no app to
ask about. That fallback is what makes this safe to have landed at all: a job, a
test, a cron route and the MBOS API reach `resolveScope` with no app route
behind them and get exactly the answer they got before.

**And it can only ever NARROW.** The derived role is the widest of the hats, so
a per-app hat is by construction no wider. Resolving per app can lose reach and
cannot gain it — which is why 73 call sites of `resolveScope` did not have to be
audited one at a time. The header is stripped off the incoming request before
the proxy writes it, so a client cannot post its own `x-mahek-app: admin`.

**The audit records WHICH HAT allowed it.** With one role per person, "was he
allowed to do this" was answerable from the person; with four it is not. The
log said Vikram approved an order and nobody could tell whether he did it as
the accounts clerk — ordinary — or because a manager hat carried it, which it
does not and must not. `requireCapability` returns the granting role and every
audited action writes it into `audit_log.actor_role`. It asks for the NARROWEST
hat that carries the capability, not the most powerful: admin holds everything,
so asking admin first would stamp "admin" on every action anybody senior took
and the column would stop distinguishing the clerk doing their job from the
administrator reaching past a rule. Null means not recorded, never "no role".

**Two hats that should not meet are named, never refused.** The matrix keeps
`order.approve` away from managers on purpose — the person chasing a target
must not sign off the orders that hit it — and a union of roles can put both on
one person. At nine people that is sometimes the only way the work gets done,
and a system that refuses it is defeated in a minute by granting admin instead,
which grants far more and records no reason. So the combination is allowed, the
review page says in words what it lets them do, and every action taken under it
carries the hat that authorised it. The rules are in `lib/role-conflicts.ts`,
pure and client-safe because the review page is a client component and a second
copy typed into the screen would drift — and the half that drifts is always the
half somebody reads.

**Access is granted to a person, and the people are in HRMS.** The console's
People section is one screen, Access, and its dialog reads the employee master
rather than the accounts table. Somebody with no MahekOne account gets one
created in the same breath — no password is typed into the dialog, because that is a password
somebody reads out over a phone; the account is created unusable and a
single-use reset link is what makes it usable. **The employee must be ACTIVE in
HRMS**, checked in the action and not only in the picker. A leaver is listed
with the reason rather than hidden, because a person missing from a search box
reads as a broken search box.

**One dialog per person, and it holds every app at once.** Granting an app,
narrowing one, widening one and taking one away are the same act — somebody
deciding what this person's MahekOne looks like — so they are one page and one
write. Doing them an app at a time meant opening the same dialog four times to
set up one telecaller, with no screen ever showing the whole answer. The middle
page IS the whole answer: every app with a checkbox, every module of a ticked
app beneath it. The page after it is the review, which names in words what is
granted, narrowed, widened and taken away before anything is written — revoking
happens by unticking a box, which is a small gesture for a large consequence.

**An app is granted if and only if at least one of its modules is ticked.**
That removes the one invalid state the screen could otherwise express — an app
held with nothing inside it, whose every route redirects somewhere else —
rather than drawing it and refusing it at the save. `setAccess` takes the whole
desired picture and works out the difference itself, so what was reviewed is
what is written.

**Disabling a sign-in is not revoking access, and the screen says which it is.**
Whether somebody can sign in and what they would find if they did are two
questions, and the Access screen answers both in the same row — Enabled or
Disabled beside the person, the apps beside that. A disabled account KEEPS its
apps: somebody away for a month comes back to the book they left, and a
leaver's grants are still the record of what they could reach. Conflating the
two would silently destroy that record on a click meant to stop a login.
`getCurrentUser` already refused an inactive account, so this was enforced
before it was reachable; what disabling adds is deleting the sessions, because
a row good for thirty days is a thing somebody has to reason about later and
disabling should leave nothing to reason about. Manage access is refused on a
disabled account rather than half-working, and says why.

**There is ONE place an app is granted.** The user record's Access tab used to
carry its own checkboxes, which made two ways to do it — and only one of them
knew about modules, so revoking and re-granting from there quietly widened a
narrowed grant back to the whole app. That tab is read-only now.

**Signing in writes a sign-in log, and that is NOT attendance.** One row per
person per day in `attendance` — a table whose name is a misnomer kept until
the real thing takes it. A sign-in says somebody opened MahekOne, from home,
on a phone, at 2am; `signedOutAt` fills in only for the few who press Sign out
rather than closing the tab, so hours cannot be derived from a pair of these.
Two screens used to say "attendance recorded for today" and "signing in opens
your attendance", and both have been corrected — no screen may present this as
a record of who was at work. **Attendance is a check-in system with its own
screens, and it is not built yet.** A second sign-in the same day reopens the
same row, so a lunch break does not read as two sessions.

**A forgotten password is the person's own problem to solve.** `/login/forgot`
mails a link to the work email on the account; `/login/reset` spends it. Only
the SHA-256 of the token is stored, it works once, it expires in 30 minutes,
asking for a new one kills the old one, and using it deletes every session that
account had. The reply is the same whether or not the address has an account —
this form is not a staff directory. Without `RESEND_API_KEY` and `MAIL_FROM`
the mail is written to the server log rather than sent, and the screen says so
rather than claiming it went.

## Layout

```
src/
  app/
    login/                 the global sign-in
      forgot/  reset/      ask for a reset link, and spend it
    apps/                  the launcher, 1–9 opens an app — `field` is never
                           one of the 1–9: it is `mobileOnly` in lib/apps.ts,
                           MBOS's own handset, and has no route here at all
    reports/               the Reports app — the owner's five KPIs, and the
                           three screens behind them: leads & conversion,
                           bill size & frequency, customer health
    accounts/              the Accounts app — today, order approvals, payments
                           to confirm, credit notes, record a payment,
                           outstanding, bills, customer account, on account,
                           sheet import, audit, sales targets, customer targets
                           (was `orders/`; /orders still redirects here)
    people/ reports/ admin/
                           admin/access-section.tsx — the People section, which
                           is now one screen: who opens what, and how far in
    crm/                   the CRM — header, sidebar, toasts
      dashboard/           telecaller day + manager team overview
      queue/               the calling queue, j/k/Enter driven
      reminders/  history/
      payments/  outstanding/  bills/  inactive/
      customers/  customers/[id]  customers/import
                           the record carries the full message history
      complaints/  targets/  eod/  whatsapp/
      help/  settings/     SOPs and the manager configuration screen
    hrms/employees/        HRMS — the employee master, one module
    api/search/            global search endpoint
    api/payments/          search and open bills, for the accounts capture form
    api/sheets/sync/       order, payment + taken-order sync, on demand, ?mode=
    api/hrms/sync/         employee sync, on demand — no schedule, see below
    api/dictate/           whether to draw a microphone, and the two calls
                           behind it: transcribe/ and refine/
    admin/components/      the live design system, a console section rather
                           than a CRM screen (components-section.tsx)
    admin/feedback/        the console section where the team's reports are
                           read and answered (feedback-section.tsx)
    feedback/              the other end of it — where the person who reported
                           something reads the reply and answers back
  components/
    customers/customers-screen.tsx
                           the customer list, shared by the CRM and Accounts
    customers/monthly-targets-screen.tsx
                           the per-customer target screen, shared the same way
    feedback/              the thread, rendered the same for both sides
    ui/                    primitives + modal + overlays + toasts +
                           attachment-strip
                           dictate.tsx — the microphone, its modal, and
                           VoiceTextarea, the box that carries one
    shell/                 header, sidebar, icons, search, wordmark,
                           app chip, app placeholder, brand panel,
                           feedback-button.tsx — the Tell us dialog, in the
                           header of every app
    crm/call-panel.tsx     the call drawer, used by four screens
    crm/next-step-dialog.tsx
                           saved, and what happens next with this customer
    crm/payment-mode-fields.tsx
                           how the money came, asked once for three screens
    crm/sales-manager-dialog.tsx
                           the third seat — who the salesperson answers to,
                           set on a tick-list or on a whole filtered book
    crm/distributor-picker.tsx
                           the searchable list of accounts we bill — the only
                           thing that may be named as a distributor
    crm/third-party-dialog.tsx
                           converting a lead, which is the mark AND who bills it
    crm/distributor-panel.tsx
                           the arrangement on the record: add, edit, remove
  db/                      schema, client, seed
    catalogue-seed.ts      the product master, GENERATED from the document
  lib/
    apps.ts                the MahekOne app registry
    account-types.ts       direct customer / lead / third-party customer, their
                           filter and their labels — PURE, read by both lists
                           and both list pages
    config/                registry.ts (every setting + validation) and
                           store.ts (cached reads, audited writes)
    lead-labels.ts         the funnel's whole vocabulary — the three sales
                           types, every rung's two names, the four coded reason
                           lists, §8's twelve questions, §16's seven feedback
                           fields, §13's fifteen nurture rows, §14's eleven
                           buttons and §18's eight. PURE and client-safe,
                           because the forms that write these run in a browser
                           and on a handset while the services that read them
                           are `server-only`
    engines/               the derived-state engines — PURE, no I/O:
                           lead-ladder — the three ladders, which rung follows
                           which, and the four funnel bands every new rung maps
                           onto; lead-gates — §28 itself, what each rung
                           demands and which of it is missing; lead-nurture —
                           an event in, the manager's tasks out,
                           buying-cycle, queue, escalation, inactivity,
                           targets, eod, payment-followup, allocation,
                           next-step — when this customer comes back, and why,
                           performance — the six weights, the mix bands, the
                           month-end forecast and the price-rise alert,
                           owner-kpis — new leads, cohort conversion, bill
                           size, purchase frequency and retention movement,
                           receipt-match — is this money we already know about
                           + engines.test.ts, allocation.test.ts,
                           next-step.test.ts
    services/              engines wired to data — one file per module
    access-control.ts      scope resolution + capabilities (§8)
    modules.ts             what a person can open INSIDE an app — PURE, and
                           read by both the review table and the route guard
    sales-attribution.ts   whose number a customer's is — the fall-through to
                           the back office, and the ONE place it is written
    services/owner-dashboard-service.ts
                           the owner's five, read off the book, and the nightly
                           customer-health snapshot behind the movement report
    services/performance-service.ts
                           the six actuals, wired to the ledger, and the
                           rebuild of the score cache
    services/sales-target-service.ts
                           who can be given a target, and what they have
                           actually been doing, for the screen that sets one
    actions/sales-targets.ts
                           saving a target, publishing it, and revising a
                           published one with its reason
    services/access-service.ts
                           who opens what, and who there is to grant to
    actions/access.ts      setAccess — one person's whole access, in one write
    services/distributor-service.ts
                           who bills a shop, which shops an account bills for,
                           and who may be named as a distributor at all
    actions/third-party.ts converting a lead, and the arrangement's own CRUD
    recompute.ts           the rebuild path for every cached derived value
    business-date.ts       Asia/Kolkata, configurable day boundary
    catalogue.ts           name normalisation + cans/litres/boxes — PURE
    sheets.ts              the one place a Google Sheet is read — read-only
    sheet-parse.ts         the order tab's cells → typed values — PURE
    hr-parse.ts            the employee tab's cells → typed values — PURE
    taken-order-parse.ts   the Taken Order tab's cells → typed values, and
                           the open/dispatched rule itself — PURE
    password-reset.ts      reset tokens: minted, hashed, read back
    feedback-labels.ts     the four kinds and four statuses, and their
                           sentences — PURE, because the form is a client
    services/feedback-access.ts
                           who may read and answer a thread — its own file so
                           attachments can ask without importing the service
    mailer.ts              the one place mail leaves MahekOne
    dictation.ts           the one place speech becomes text — transcribe,
                           render into English, tighten, rewrite
    dictation-requests.ts  the same feature as a REQUEST — readiness, the two
                           calls, and the ONE copy of the six refusals. Two
                           doors read it: the CRM's session-authenticated
                           api/dictate/*, and the handset's token-authenticated
                           api/mbos/dictate/*
    jobs.ts                scheduled work, idempotent and hand-triggerable
    result.ts              the Result type every action returns
    queries.ts             every scope-aware read
    actions/               every write
    actions/sales-manager.ts
                           assignSalesManager — the third seat, by ids or by
                           the filters the list is showing
    journeys.test.ts       the six §11 journeys, end to end
    format.ts merge.ts csv.ts scope.ts auth.ts
  app/admin/               the console — platform sections (platform-real.tsx,
                           from admin-platform-service), the CRM's schema, and
                           the Catalogue section (catalogue-section.tsx)
  scripts/parse-catalogue.mjs
                           document → src/db/catalogue-seed.ts, by hand
  scripts/grant-app.ts     give somebody an app, by hand
```

## Rules that keep the data honest

**Nothing business-critical is a constant.** Every threshold lives in
`lib/config/registry.ts` and is stored in `app_settings`. If you find yourself
typing a number that a manager might one day want to change, it belongs there
instead. Reads go through `getConfig()`, which caches for 30 seconds.

**The engines are pure.** Everything in `lib/engines/` takes configuration and
the business date as arguments and performs no I/O. That is what makes the
rules testable without a database — keep it that way, and put the data
fetching in `lib/services/` instead.

**Derived values are never hand-edited.** Buying cycles, outstanding, follow-up
stages, slow-payer flags and last-contact dates are all caches. If one is
wrong, the fix is to re-run the matching function in `lib/recompute.ts`, never
to update the row.

**Money is paise.** Integers everywhere; formatted only in `lib/format.ts` on
the way to the screen. Never store rupees.

**Reads live in `lib/queries.ts`; writes live in `lib/actions/`.** A number on
the dashboard and the same number on its own screen come from the same
function, so they cannot drift apart.

**Outstanding is derived, never typed.** `recomputeOutstanding()` rebuilds it
from bills after anything that touches a bill or a payment.

**The zone is named once, in `APP_TIMEZONE`.** `workingDay.timezone` stays the
configurable authority for anything that reads configuration; the constant
exists for the two places that cannot — client components, which have no async
config, and SQL, which needs a literal. Nothing else spells the zone out.

**Never cast a stored timestamp to a date without naming the zone.** Postgres
casts a timestamptz in the SESSION zone, and Neon runs in GMT, so a bare
`ordered_at::date` puts a 1am IST call on the previous day. Local Postgres runs
in Asia/Kolkata and hides it completely. Two tests guard it: one forces the
session to GMT and asserts the difference, and one greps `lib/` for bare casts,
because the rule is invisible at runtime on a database that happens to agree.

**The working day is Asia/Kolkata, and where it starts is configuration.**
`today()` in `lib/recompute.ts` applies `workingDay.dayBoundaryHour`, which is
now 0 — the day changes when the date does, which is what everybody outside
the building means by the word. It shipped as 5, and a dashboard opened at 2am
showed the previous day's figures with nothing on the screen saying why.
Raising it again is a real option for a team that logs calls after midnight;
it is a decision somebody makes on the Settings screen, not a default.
`0042_day_boundary_midnight` moved the stored value on deployments already
carrying the old one, matching on `updated_by_id is null` so a value somebody
had actually chosen was left alone. Day windows in SQL carry an explicit
`+05:30` — without it Postgres reads them in the server's timezone and a 9am
call falls outside "today". The sync `today()` in `lib/format.ts` is for
client components only.

**A span of days is one window, not a loop over days.** The dashboard reads
today, yesterday, this week or this month, and every figure comes from
`eodMetricsForRange` — the same twenty subqueries a single day uses, over a
wider window, so a day and a one-day range cannot answer differently and a
month costs what a day costs. `periodRange` and `previousRange` are pure and
live in `lib/business-date.ts`. A span is measured against the equally long
one immediately before it, never against a whole previous month: a
month-to-date of twelve days beside a full month reads as a collapse every
time. Yesterday means the previous WORKING day, and the screen prints the
dates rather than implying them. What does NOT follow the span is the queue,
the reminders and the "needs you today" list — those are work waiting now, and
a month's worth of it is not a thing.

**Scope, not roles, filters lists.** `getScope()` returns `mine` or `team`.
Telecallers are pinned to `mine`; the cookie cannot widen it. Managers default
to `team` because their own book is usually empty.

**And there is ONE resolution of it, `scopeForUser`.** The My book / Team
switch is drawn for anybody `isManager` lets through, which includes an admin
— and the admin branch returned `all` before the preference was ever read, so
the highlight moved and every list stayed team-wide. Two definitions: the
cookie one relabelled the header while this one filtered the data. Accounts
are deliberately outside the narrowing, because `getScope` answers "mine" for
every non-manager and reading it for them would scope the approval queue to a
clerk's own book, which is empty.

**A team list says whose call each row is.** Not the owner: whose book a
record sits in is `ASSIGNED_TO_SQL`, so naming the owner puts a call against
somebody it was reassigned away from. Unassigned is said in words rather than
left blank — a call nobody owns is the one a manager most needs to see.

**Manager-only actions are checked server-side** in the action, not just
disabled in the UI. Disabled buttons always carry a `title` saying why.

**Saving a call is one transaction** — the interaction, any order, reminder or
complaint it produced, the queue row and the customer's rolled-up figures.
Half-saved calls are how telecaller data goes wrong.

**A WhatsApp message is only sent when a human confirms it.** Until then it
sits as `copied`, and only a *confirmed* send sets
`lastConfirmedWhatsappDate` or suppresses the customer from the queue. A
copied-but-unconfirmed message is a customer who may or may not have been
contacted, and it is shown as exactly that rather than assumed either way.
There is a test for each half of this; do not collapse them.

**A customer reached two ways is two pieces of work.** `both` is a standing
instruction on a *customer*, never on a message: a message goes to exactly one
place, so a both-ways customer produces two rows and `prepareLegs` splits them,
personal leg first. The group can be pasted and confirmed while the personal
message is still sitting copied, and neither leg may borrow the other's
confirmation. One confirmed leg *does* set `lastConfirmedWhatsappDate` —
waiting for the second would chase somebody who has already heard from us.
`dest_kind` is shared with `wa_messages`, so read that column as
personal-or-group only; nothing writes `both` to it.

**A customer record is a FIXED-LENGTH page, however old the account is.** Every
panel on it is the same height and scrolls inside itself, and the reads behind
them are capped — the timeline at ten entries a page (`TIMELINE_PAGE`, one
constant so the first read, the Load older button and the sentence counting
them cannot disagree), the messages at fifty, the rest at two hundred. COLOUR CAMP is why: 3,504 timeline entries were serialised
into the page and rendered into the DOM, so the orders, the bills, the payments
and the arrangement sat a hundred screens below the fold. The accounts with the
most history are the ones somebody most needs to read before ringing, and they
were the ones whose record you could reach the least of.

**A capped list says what it is a slice of, and the count comes from SQL.** The
timeline's filter pills used to count what had been loaded, which is exactly
why the page loaded everything: a capped read would have printed "Bill 34"
against an account with 1,060 and nothing on the screen would have said so.
`customerTimelineCounts` is seven `count(*)`s on indexed columns; the pills read
those, "Load older" pages with a KEYSET rather than an offset, and picking a
kind asks the server for that kind's newest page rather than filtering the fifty
rows the browser happens to hold. Filtering in the browser would answer "the
bills among the newest fifty entries" and call it the bill history.

**And a stored DATE is not an instant until something names the midnight.**
The third spelling of the zone rule, and the one that only shows up under load:
`bills.bill_date` and `payment_receipts.received_at` are dates, and a bare
`::timestamptz` on either is evaluated in the SESSION's zone. The session's zone
is not a property of the row — one pooled connection left in Asia/Kolkata by an
earlier query returned a bill as 18:30Z while the rest returned it as 00:00Z, in
one process. A timeline cursor taken from one page then excluded nothing on the
next, and five rows came back twice. It is
`::timestamp at time zone ${APP_TIMEZONE}` now, and a third grep test guards the
direction: the two beside it watch timestamps becoming dates, this one watches
dates becoming timestamps. Local Postgres runs in Asia/Kolkata and agreed with
itself, so it passed here and failed in CI — which is the same trap the rule was
written for, arriving from the other end.

**A paged read needs a tiebreaker in its sort.** A thousand bills share a
handful of midnight timestamps, so `order by at desc` alone leaves their order
to the planner — invisible until it is paged, and then it is a row appearing on
two pages while another appears on none. The sort is `at desc, id desc` and the
cursor is `(at, id) < (…)`. There is a test that pages a book of 55 bills seven
to a day and asserts it sees all 55 exactly once; the seven is chosen not to
divide the page size, because at twenty a day with pages of twenty every page
ended on a date boundary and the broken cursor passed.

**A THIRD-PARTY CUSTOMER is a shop we deliver to and do not bill.** A
distributor buys from us, is invoiced, and sells the goods on; the shop is
where the drums actually go. Most of what this CRM called a lead is one of
these, and a lead with no orders is a prospect — so the largest single category
of work on the calling list was ringing shops for a first order they are in no
position to give. `customers.third_party` is the mark, and it is deliberately
NOT a third value of `kind`: `kind` is exclusive and this is not, since we may
bill one of these directly and an account we invoiced last month is plainly
still a shop we deliver to. What the mark means is narrow — a marked account is
never PROSPECTED, and that is all. Its own orders, its debts and a promise
somebody made all still reach the Call Log, so a shop that starts buying
directly comes back without anybody remembering to lift the mark.

**And it names WHO BILLS IT, in the same transaction.** A mark that could not
say who the distributor is took a record off the calling list and left nobody
to ask about it. `customer_distributors` is that answer, one row per shop per
distributor, and `convertToThirdParty` writes the mark and at least one link
together — a converted shop with nobody billing it is not a state that exists.
It is a LIST rather than a column, because a shop on a territory boundary is
served by two distributors and storing one of them would make the other
unrecordable, which is wrong for exactly the accounts that most need it
recorded. `is_primary` is who serves it usually, at most one, kept true by a
partial unique index rather than by a rule in a service the next writer will
not know about.

**Only a LEAD is converted, and anything may stop being one.** A direct
customer is an account we invoice, so saying it does not bill with us is a
contradiction — the option is absent from its row menu and its record, and
`convertToThirdParty` refuses it rather than trusting the menu. The other
direction is offered on anything carrying the mark: a shop that starts buying
from us is a good day, and undoing must never be harder than doing. Reverting
KEEPS the links — who used to bill this shop is a fact about it, and deleting
them would destroy the only record of how it was served. Reverting is also the
nearest thing MahekOne has to "converting a customer back to a lead" — nothing
does that literally, because a lead's entire definition is an account that has
never ordered, and a real customer's order history would make the label false
the moment it was applied.

**`customer.classify` is held by managers AND by accounts.** Manager-only from
the day it shipped, on the reasoning that marking a shop decides who gets
CALLED, which is a manager's team's work — and that reasoning did not go away,
it stopped being the whole reasoning. A converted shop is also who bills it,
which is exactly the kind of account fact accounts already maintain when they
change a customer's account manager, so the capability sits in
`ACCOUNTS_OR_MANAGER` now, added rather than moved for the same reason
`target.set` was: a manager coaching a telecaller through which shops are
worth marking still needs to act on it directly. It reaches the Accounts
customer list for free — `canClassify` was already threaded through the
shared `CustomersScreen` component both apps render, so widening the
capability is the whole change.

**A distributor is an unmarked DIRECT CUSTOMER.** Somebody has to be holding
the invoice at the end of the chain, and a shop we deliver to is not holding
one; a lead has never ordered and cannot bill anybody. The picker offers only
`kind = 'customer' and not third_party`, and the action checks the same thing,
because a picker is not a permission. The last distributor cannot be removed
from a marked account — the refusal names the way out, which is another
distributor or no longer being a third-party customer.

**The arrangement and the evidence are ONE list, and every row says which it
is.** They were two panels — what somebody recorded, and under a title of its
own every shop `orders.delivery_customer_id` shows goods going to. On a real
distributor that drew four rows beside eighty-six, two counts, one question,
and nothing on the screen saying how they differed; the honest reading was that
the page showed the same list twice. A shop the sheet has seen and nobody has
recorded is not a second subject, it is the unfinished part of the first one —
so it sits in the same list marked "from the order sheet", with the button that
records it, and the list moves into its recorded half as the work is done. That
is what makes it a worklist rather than a report. `recorded` is never inferred
from the order count: a recorded arrangement with no deliveries behind it and
two hundred deliveries nobody has recorded are both real, and both worth
seeing.

**One tap records it, and what that tap DOES depends on what the shop is.** A
lead is converted with this account as its distributor; an account already
marked gains another distributor; an account we invoice ourselves has the
arrangement recorded and is NOT converted, because we bill it and calling it a
shop somebody else bills would be false. The decision is in
`recordDeliveryAddress` rather than on the screen, since it is the same rule
the convert dialog obeys.

**A one-line summary names only what somebody recorded.** "Billed by X" on the
Account card reads as a fact somebody stands behind, so a distributor the sheet
merely shows must not appear in it — the panel underneath is where a row can
say what it is.

**One question, three answers, and `lib/account-types.ts` is where they live.**
Direct customer, Lead, Third-party customer — the mark wins over the kind on a
list, because "Lead · Third party" is two facts fighting over one glance on
four hundred rows. The type filter carries two options that are not types: the
evidence list, and third parties with nobody billing them, which should be
empty and is not on a book converted before distributors were recorded. A row
nobody can account for is worse than one that says why it is there.

**A LEAD CLIMBS A LADDER, AND WHICH LADDER IS THE FIRST THING ASKED.** Mahek
sells three ways and they are not the same job: a direct customer is worked
towards a first order, a distributor towards an appointment, and a third-party
shop towards an order somebody else invoices. `customers.lead_sales_type` picks
between them and is chosen before anything else is typed, because it decides
which questions the rest of the form asks. `lib/engines/lead-ladder.ts` holds
the three, and no screen writes a stage list out.

**NULL is the fourth answer, and it is what let this ship.** A lead raised
before the funnel existed carries no sales type and climbs the six rungs this
product shipped with — `new · contacted · qualified · negotiation · won · lost`,
kept whole and kept first in the enum. Nothing backfills one. Guessing which of
three ladders somebody was on is a decision dressed up as a migration, and the
ladder decides which GATES apply, so a wrong guess would not merely mislabel a
record: it would block the salesman working it.

**`bandOf` is why seventeen new rungs moved no figure.** The console funnel
draws four bands and the owner's cohort conversion counts by them, both reading
`lead_stage`. Adding rungs without mapping them would have dropped every lead on
a new one out of the bands entirely — a pipeline that silently shrinks as the
team works it, which is the worst possible direction for that bug. The map is in
the ladder engine and there is a test that walks every enum value through it, so
a twenty-fourth rung added without a band fails the build rather than a report.

**§28 IS THE WHOLE POINT: no lead moves forward because somebody pressed a
button.** `lib/engines/lead-gates.ts` answers whether a rung may be entered and,
where it may not, WHICH conditions are missing — because a refusal that does not
say what it wants teaches a salesman to press the button again rather than to do
the work. Three callers, one answer: the handset draws the next rung disabled
with the missing list underneath, the server action refuses on the same function
before it writes, and the console shows a manager what a lead is stuck behind. A
second copy typed into a screen would drift inside one release, and the half that
drifts is the half somebody is reading.

**The gate engine is pure because it has to run with no signal.** The salesman
deciding whether he can request a sample is standing in a shop, and a rule that
only exists on the server is a rule he finds out about on the drive home. It
takes configuration and its inputs as arguments and performs no I/O, like every
engine here, and the handset compiles the same file.

**A tick is not an answer where a column exists.** Four of the twelve
qualification conditions — the monthly requirement, the potential, the product
and the competitor — are satisfied by the VALUE and not by the checkbox beside
it. A ticked box beside an empty field is precisely the state the gates exist to
prevent, and a checklist that can be completed without answering anything is a
checklist people learn to complete.

**The map and the toll are two files on purpose.** `lead-ladder.ts` answers
"what comes next"; `lead-gates.ts` answers "may we". Folding them together would
put the reason a lead is stuck inside the function that draws its progress, and
the console needs the second without the first.

**§22 SAYS CUSTOMER AT THE SECOND ORDER AND THIS CODEBASE SAYS OTHERWISE, so
the two words are separated rather than reconciled.** A lead here IS an account
that has never ordered, and about thirty places read `customers.kind` on exactly
that understanding — the Call Log's prospect cadence, sales attribution, the
buying cycle, the owner's funnel. Honouring §22 literally would leave an account
with one order, one bill and one confirmed payment sitting at `kind = 'lead'`,
and every one of those readers would get it wrong. So `kind` flips at the FIRST
order — `promotesToCustomerAt` is the one place that is decided — and the ladder
keeps its own `second_order` and `customer` rungs, which are the funnel's
statement about the relationship rather than the ledger's about the account.

**A working lead is held back from the Call Log, and SHOWN.** A lead that stays
a lead through eleven rungs would otherwise sit on the telecaller's prospect
cadence for months, so the office rings a shop a salesman is actively working to
ask for a first order — two people chasing one customer, neither knowing about
the other. A lead carrying a sales type is suppressed from the prospect reason,
and suppression is a return value rather than a filter, so it appears in the
held-back strip with the reason said in words. A lead with no sales type is
untouched.

**§24: an active lead may not sit with nothing owed by anybody.** The action,
the day, the person and what that person is expected to come back with — four
answers, not a date. A date alone is what this had, and a date alone is how a
lead sits for six weeks with everybody assuming somebody else is holding it. It
is enforced on every upward move by the gate engine rather than by a required
field on one form, and legacy leads are exempt: demanding a next action to move
a four-year-old lead would freeze the book the rule exists to unstick.

**§4 pushes rather than holds.** Two visits to decide whether a Suspect is worth
anything, three at the outside — and past the cap nothing is refused, a decision
is DEMANDED. The lead turns into one question, Prospect or Not Prospect, and
both answers are moves the engine allows. How many visits a suspect has had is
counted from `mbos_visits` and is deliberately not a column: a counter would
drift the first time a visit arrived late from a handset.

**A REASON IS A CODE, NEVER A LABEL.** Why a Suspect became a Prospect (§5), why
the customer wants a trial (§10), why a lead was lost (§26) and why a manager
overrode a gate — four lists, all in `lib/config/registry.ts` because a manager
should be able to reword one without a deploy, and all stored as codes because a
stored label stops resolving the moment they do. It is also what makes "how many
did we lose on credit terms this quarter" a question somebody can ask rather
than a grep over free text.

**The override exists so the rule survives contact with a Tuesday.** A system
that refuses everything is defeated in a week by people recording the work after
the event, and the record then says the process was followed when it was not —
which is worse than the gate being open. So a manager may pass a shut gate, it
demands a reason, and `lead_stage_transitions.overridden_conditions` stores
exactly what was still missing. `leads.allowManagerOverride` turns it off for a
team that would rather be stuck.

**Every move is a row, and the row is the timeline.** `lead_stage_transitions`
is append-only: a transition recorded wrongly is corrected by a further
transition, never by an edit, for the same reason `calls.next_step_*` is never
rebuilt — it records what somebody decided on a day, and a rewrite destroys the
question rather than answering it. §25's timeline is that table joined to the
manager's calls, the samples, the orders and the receipts, and every lead write
also lands a `timeline_events` row so the story reaches the customer record it
becomes.

**§8 stores the ANSWERS, not the verdict.** The sales manager rings the customer
to establish that the visit happened, that Mahek was explained and that the
opportunity is real. A verdict on its own would be worth very little a month
later; the value is the twelve answers, because "whose product did he say he was
using" is exactly what somebody needs before the negotiation call. Two of the
twelve are about the salesman rather than the sale, and they are why the call
exists at all — no amount of GPS proves that Mahek was explained properly.

**§13's fifteen tasks are a table, not fifteen conditionals.**
`NURTURE_SEQUENCE` in `lib/lead-labels.ts` names the trigger, the delay, the
owner and the sentence; `lib/engines/lead-nurture.ts` turns an event into the
tasks that should exist, keyed on `mbos_tasks.sourceType`/`sourceId` so a second
pass raises nothing twice. `owner` matters: the salesman and the manager are
chased for different things about the same lead, and one list would read as one
person being nagged twice.

**§16 does not stop.** A sample review is chased on day 2, then 4, then 6 — and
the LAST interval repeats until there is an answer, because a trial nobody
reviewed is stock given away for nothing. `mbos_samples.review_chase_count` is
what lets a screen say "asked three times", which is the number that tells a
manager to pick up the phone themselves.

**A sample's STATE and its VERDICT are different questions.**
`mbos_samples.state` is the journey — requested, approved, dispatched, received,
tried, reviewed — and `trial_outcome` is what the customer thought. With one
column, a sample approved three weeks ago and never dispatched looked identical
to one under evaluation; it is stock nobody gave away and an opportunity nobody
took. `more_testing` is a real third verdict rather than a shrug: "they want to
try it again on a different substrate" is neither approval nor rejection, and
recording it as pending loses the fact that a trial happened at all.

**§16's feedback is seven answers because "good" cannot be read back.** Quality,
performance, application, drying, the comparison, price, and one open box. The
whole point of a trial is the comparison, and a note field cannot later be read
as "better drying than the incumbent, price is the problem".

**§12: a salesman may never appoint a distributor, and a manager may not do it
alone.** It routes through `mbos_approvals` — the same table and the same
two-step chain every other MBOS decision uses — with `stepIndex` 0 the sales
manager and 1 management, which is the `distributor.approve` capability and
admin's alone. What forces the second step is named rather than judged:
exclusivity always, a discount above
`leads.distributorDiscountApprovalPercent`, a credit limit above
`leads.distributorCreditLimitApprovalPaise`. The person carrying the target must
not be the person allowing the discount that hits it — the same reasoning that
keeps `order.approve` away from managers entirely.

**The distributor's own salesman is a name, not an account.** Rahul, in §23's
example, works for the distributor, has no MahekOne login and never will.
`distributor_salesmen` is that fact, and `customer_distributors` points at it, so
the chain Mahek → distributor → his salesman → the shop is recorded from the
first visit rather than reconstructed at conversion. Giving him a `users` row
would put him in every person picker in the product.

**§20 is RENDERED, never re-implemented.** Order Received → Confirmed →
Dispatched → In Transit → Delivered is a second status ladder for a row whose
status already comes from the Order Details tab and from accounts' approval. A
parallel one would be overwritten every thirty minutes by the sheet projection
or would fight it into `sync_conflicts`. The lead page shows the orders and the
receipts that exist; it writes neither.

**§21 already existed and is called rather than rebuilt.** The reorder cycle is
`engines/buying-cycle.ts`, measured from real approved orders and discounted by
`cycle_confidence`. The repeat-order call is a nurture task dated from it.

**The Call Log chases orders, not contact.** A customer with a measured buying
cycle gets a stock-check call at a percentage of their own cycle — 70% of 30
days is day 21 — and is chased from their due date onwards. Underneath it sits
a quiet window: no order is chased inside 15 days of the last one, because
somebody who ordered days ago is serving themselves. Customers who have never
ordered are prospects, worked on their own short cadence.

**The quiet window NEVER outlasts the customer's own due date.** It is a flat
fifteen days and cycles are not, so on anybody who reorders faster than that it
used to run past the day their order was actually due — a seven-day buyer was
held until day 15, a whole cycle missed, and the call that finally came was
eight days late. The people ordering most often were the ones chased last,
which is backwards, and the orders it lost were real. It is capped at the cycle
now, so every customer follows one rule: quiet until their order is due, chased
from the day it is. Only a MEASURED cycle caps it — a guess is not a due date,
and shrinking a real window on the strength of a number nobody measured would
chase people on the strength of a default.

**What a short cycle costs is the stock check, and nothing else.** At or below
`queue.routineMinCycleDays` (15) there is no call before the order is due. That
call asks what is left on the shelf and somebody buying every week already
knows; their order is still chased on their own due date exactly like a
thirty-day customer's.

**The weekly check-in goes to one group: customers whose cycle cannot be
measured yet.** There is no cycle to time a call from, so a steady cadence is
all there is. Everybody else is called from their own cycle.

Customers reordering FASTER than the quiet window used to get it too, on the
reasoning that going silent on your best customers loses them. They no longer
do: a customer buying every seven days is in contact constantly through the
orders themselves, and a weekly call on top is noise on both sides of the
phone. Their own cycle is what calls them, and it calls them sooner than any
weekly cadence would. A customer with a measured cycle of 15 days or more never
had the check-in either: their cycle already says when to call, and a weekly
one on top would ring a 60-day buyer eight times before their order was due.

**The quiet window silences order chasing, not the customer.** The order
reasons are stripped rather than the whole customer suppressed, so a telecaller
with a reminder against them still sees the call they are actually making
rather than one about an order. A customer left with nothing at all is shown
in the held-back strip with the reason, never dropped silently.

**A reminder outranks the quiet window, the no-order cooldown, the inactive
watch and the WhatsApp cooldown.** A callback the customer asked for is not
chasing, and not making it is worse than any wasted call. The WhatsApp cooldown
was the one that did not bend, so a marketing message sent on Tuesday silently
cancelled a call promised for Wednesday — a broken promise caused by something
we chose to do, which is the worst kind. It does not outrank do-not-contact, it
does not outrank having already called them today, and it does not outrank the
external order system: the first is a standing instruction and the other two
mean the contact has already happened.

**Asking for an order and being told no buys quiet.** Without the cooldown, a
customer past their call day returns to the top of the list every single day
until they order, which punishes the telecaller for working it.

**Saving a call says what happens next, and it is not a second copy of the
rules.** `lib/engines/next-step.ts` asks `buildQueue` the question it already
answers — is this customer on the list — once for today and once for each day
after, and reports the first day the answer is yes. Re-deriving the cycle, the
quiet window, the cooldowns and the no-answer ladder would produce a copy that
drifts within a release, and the sentence a telecaller reads out on a phone
call would be the copy that was wrong. Pure, like every other engine, and
`nextStepForCustomer` is the one place it is wired to data.

**A prediction and a promise are drawn differently, and the BADGE is what
draws them.** `booked` is a callback the customer asked for; `scheduled` is a
date the rules produce, and it does move the moment they order, pay or ask for
a callback. That used to be said in a sentence under the date — and the
sentence took the confirmation back in the same breath, which is the one thing
this screen cannot afford: a telecaller cannot act on a date the screen is
already apologising for, and the caveat was true of every scheduled date ever
shown, so it carried no information at the moment it was read. The badge says
which kind it is without arguing with the line above it. `decide` and `none`
carry NO date at all — a customer nobody can reach and one marked
do-not-contact will not be brought back by anything, and putting a date on
either would be an invention the telecaller has no way to check.

**The headline is one fixed form of words, and it names the screen.** "Comes
back to your Call Log on Mon 1 Sep — 13 days away", the same shape for every
reason, with what to do and why on the line beneath: "Ask for the order — they
are due to reorder." It said "Back on your list" before, which was true and
answered a question nobody asked — a telecaller does not hold a mental model
of "the list", they open the Call Log. A confirmation read sixty times a day
works by being recognised rather than read, so the part that VARIES is the
reason underneath, which is the only half worth reading twice.

**And it is READ where the work is chosen, not only where the call was made.**
The dialog says it once, at the moment of saving, and then it was gone: to find
out when a customer comes back you opened their record, one at a time. The two
screens somebody actually decides from now carry it — the Call history, where
each row shows what THAT call said would happen next, and the customers list,
which shows the last thing anybody was told, between Outstanding and City.

**It is the stored answer, and it says when it was said.** These columns are
what the screen told the person who logged the call, on the day they logged it,
and a customer who has ordered since has a different next call now — so a date
already past is drawn muted rather than sitting in a column of future dates
looking like a commitment, and the day it was said is on the hover. Deriving it
live for twenty-five rows would mean running the queue engine twenty-five
times per page, and the answer would no longer be a record of anything.

**An empty cell means nobody has called them.** Which is most of a fresh book,
and it is the honest answer: nothing has been promised because nobody has
spoken to them. `decide` and `none` are the opposite case and carry no date by
design, so they print their word — a blank cell where the answer is "nobody can
reach them" reads as missing data.

**The three screens share one vocabulary**, in `lib/next-step-labels.ts`, with
a long word for the dialog and a short one for a table cell: "You owe them this
call" in a 90px column is a sentence nobody finishes.

**And it is shown by every path that logs a call, not just the calling
queue.** The collections follow-up panel on `/crm/payments` saved and advanced
straight to the next overdue account for as long as it existed — so the
telecaller who had just agreed a promise date with a customer had nowhere to
be told when that customer comes back, on the screen where the question is
asked hardest. `logPaymentFollowUp` calls the same `nextStepForCustomer` after
its recompute, stores the six columns on the `calls` row it already writes,
and `PaymentPanel` renders the same dialog. A confirmation that appears on one
of two save paths is one telecallers learn not to rely on.

**The headline is the EARLIEST day they come back, and the promise is named
beside it.** On a prospect or an overdue account the cadence often lands before
the callback somebody committed to, so answering with the promise alone would
be wrong about when the name reappears — and answering with the cadence alone
would be a confirmation screen that never mentioned the promise the telecaller
had just made. Both are true and both are said.

**A verdict about today cannot be rolled forward.** `paymentCallDue` on a queue
candidate means collections wants a call NOW; carried into the search unchanged
it fires on every future day, so every customer with a debt would be told
"chase them tomorrow" for the rest of the year. `paymentCadenceFor` asks the
collections engine for a DATE instead — `nextCallOn`, pushed out by a live
promise and by reported money exactly as the worklist pushes it — and `held`
accounts get no date at all, because somebody is arguing about that bill.
`calledToday` and a same-day skip are cleared for future days for the same
reason.

**What the telecaller was TOLD is stored on the call, and it is not a cache.**
Six columns on `calls`, written once, after every recompute the save triggers —
read a moment earlier and they would describe the world before the call that
just happened. `lib/recompute.ts` does not touch them and must not learn to: a
cache answers "when is the next call" and is rebuilt when the answer changes,
while these answer "what did we tell the person who logged this call, on the
day they logged it", and a rebuild does not correct that question, it destroys
it. It is the same kind of mark as `orders.approvedAt` and
`bills.paymentDecidedAt`. The current next step is derived on read, from live
data, and the two are MEANT to be able to differ — that difference is the
record of what changed since. A duplicate save returns the stored sentence
rather than a fresh reading, so a double-click cannot show a second answer.

**Working it out never fails the save.** The call is in the ledger before any
of this runs; the sentence is a courtesy on top of a completed write, so a
failure leaves the columns null and the screen says plainly that it could not
work it out. Calls logged before this existed have no sentence and nothing
reconstructs one — a reconstruction would be today's answer wearing an old
call's date.

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

**A SKU's name is the join key, so it is never edited.** Legacy orders and bills
reference the description as TEXT, not by ID, so `products.name` is the
normalised name and it is unique across the catalogue. A rename would silently
detach every historical line carrying the old spelling — a name that has to
change becomes a new SKU plus an alias. `product_aliases` is what makes an old
spelling keep resolving; aliases are read on the way in and never offered on an
order form. The raw name is kept beside the normalised one for reconciling
against records that still hold the original string.

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

**The import is idempotent, and it never unmakes a decision.** It matches on
the canonical name, reports created/updated/unchanged per field, and a dry run
shows exactly what a real run would change while writing nothing. Two things it
sets only on CREATE: `active`, because whether a SKU is offered is somebody's
decision and a re-import must not put every retired product back; and the
canonical ID, because a re-run must not reset a name somebody has already
settled. Both have a test saying so. Regenerate the seed from a new revision of
the document with `npm run catalogue:parse`, then `npm run catalogue:import`.

**Order value is not computed from the catalogue until a price source is
confirmed.** The product master carries no prices at all, so
`products.priceSource` starts `unset` and `canValueOrders()` answers no. An
order is worth what the telecaller typed, and the screens that would derive a
value say so rather than showing a confident zero — reaching for the packing
cost because it is the only number on the row would put believable wrong
figures on every target screen. `pricelist` is refused by `checkConsistency`
until a customer price list actually exists.

**How many quick notes an outcome takes is configuration, not a column.**
`interactions.singleSelectOutcomes` names the outcomes that take exactly one —
No Order today. Putting it on each `quick_notes` row would let two rows for the
same outcome disagree. A second pick replaces the first in the stored
identifier AND in the note text, so the note can never read "Stock sufficient
Price issue" and mean neither.

**Retired quick notes are deactivated, never deleted.** Historical
interactions hold their identifiers in `quick_note_ids`, and those references
must keep resolving to something a human can read. The save path deliberately
does not check `active`, so an old reference is never rejected on read.

**Attachment bytes live in Postgres by default, and in Blob only if a token
says so.** No second service, no token, and the bytes sit in the same backup
and the same point-in-time restore as the row that refers to them — which for a
few complaint photographs a week is simpler in every way that matters. Setting
`BLOB_READ_WRITE_TOKEN` switches the backend and nothing else changes, because
Postgres stops being right at volume: bytes in the database are bytes in every
backup, every restore and every replica, billed as database storage. They live
in `attachment_bytes`, never as a column on `attachments`, or every listing
would drag megabytes through the pool to display a filename.

**A file is validated on its bytes, never on its name.** `.jpg` is three
characters anyone can type. `sniffContentType` reads the signature and that is
what decides — an extension and the browser's declared MIME both come from the
same untrusted place. Permitted types are configuration, so removing one takes
effect immediately without touching code.

**An attachment is created before its parent exists.** The upload starts when
the file is chosen, not when the form saves, so a row begins life unparented
and is bound when the parent is written. That is what makes orphans possible,
which is why the nightly sweep is part of the subsystem rather than a tidy-up
somebody remembers. A form abandoned mid-call keeps its files for the
configured window first.

**A save is never blocked by an attachment.** Attachments are optional
everywhere. A failed upload leaves the complaint, call or follow-up intact and
the message says how many files made it — never all-or-nothing, and never a
lost call because a photograph did not upload.

**THE ATTENDANCE SELFIE IS THE ONE EXCEPTION, and it is not an attachment.**
Every MBOS check-in and every check-out takes a front-facing photograph inside
the app, there is no path through `src/data/attendance.ts` that writes a
session end without one, and the camera screen's only two exits are the
photograph and abandoning the action. That reverses the rule above for exactly
one file, on the reasoning the rule itself rests on: everything else here is a
photograph OF something attached to a record that stands without it, and this
one IS the record. An attendance mark on its own is a claim that somebody was
somewhere at a time; the photograph is the only part of it that is evidence.
Skippable — which is how it shipped, under a button reading "Start the day
without a photo" — the two kinds of day were indistinguishable afterwards:
some proved something, some proved nothing, and nothing on the record said
which. The GPS fix is still never required, still recorded as missing when it
is missing, and the day still starts outside the geofence with the reason
asked for afterwards. A refused camera permission is therefore a real dead
end, and the screen says so in words rather than working around itself.

**A selfie is required PER SESSION, at BOTH ends.** A day is
`[{ inAt, outAt }]` — a salesman breaks for lunch or comes out again in the
evening — so "a selfie at check-in" would have meant one photograph covering
three separate arrivals. `resumeDay` passed `selfieMediaId: null` and
check-out took no photograph at all, so a day proved that somebody arrived
once and proved nothing whatever about when they stopped, which is the half
that decides the hours. Both are now required BY THE TYPE rather than by the
screen: `checkIn` and `checkOut` take a non-nullable id, because a screen that
forgets to ask is a screen and a parameter that cannot be omitted is the rule.
Each session carries `inSelfieId` and `outSelfieId`, and the day-level
`check_in_selfie_id`/`check_out_selfie_id` are the first-in and last-out
mirrors, exactly as `check_in_at` and `check_out_at` already are.

**THE SERVER HAD NO SESSIONS, so a day of three arrived as one pair.** The
handset has modelled a day as a list since its own v2 migration and
`mbos_attendance_days` kept two timestamps — so 9-to-1 plus 2-to-6 reached the
office as nine hours on the record that feeds a payslip, with the break
invisible. It is a `jsonb` column now, stored as the handset reports it and
NOT a cache: rebuilding it from the two marks is precisely the loss it exists
to prevent. It is also the only place N photographs can live, since a day with
two breaks carries six.

**A check-in is never refused because a photograph is still uploading.** Media
is a separate queue that syncs AFTER its parent — that is the whole point of
it — so an attendance row routinely names a file whose bytes are still on the
phone, and the two selfie columns are foreign keys onto `attachments`. A key
does not care about the reason: it would reject the check-in over a file in
transit. So the id is written to those columns only once the attachment row
exists, the handset re-sends as its media queue drains, and the `sessions`
list holds every id from the first pass regardless — the mark is never lost to
the ordering of an upload.

**EVERY FIELD PHOTOGRAPH WAS BEING DELETED BY THE NIGHTLY JOB.** The worst bug
in the subsystem and the quietest: `storeMbosMedia` never wrote `parent_type`
or `parent_id`. The handset has sent both on every upload since it was
written; the route read an `entityId` nothing sends, and the action dropped
even that. So every selfie, cheque, bill and shop front landed in
`attachments` with a null parent — and `sweepOrphans`, which runs nightly,
selects exactly that (`parent_id is null` past
`attachments.orphanCleanupHours`, 24 by default), removes the bytes from
storage and marks the row removed. A photograph taken on Monday was gone on
Tuesday. Until then it was readable by its uploader alone, because `canRead`
falls back to "unbound and still the uploader's own" — so no manager had ever
been able to open one either. The enum values (`mbos_visit`,
`mbos_attendance`, …) had been declared a migration early with a comment
saying they were used by nothing "yet"; nothing ever went back for them.
`MBOS_PARENTS` is the mapping, an unrecognised name parents nothing rather
than guessing, and the sweep still removes what genuinely belongs to nothing.

**An attendance selfie has no customer behind it, and answered 404 to
everybody.** The second half of the same story. `customerBehind` falls through
to `calls` for any parent type it does not name, so an attendance id was
looked up among calls, found nothing, and every read was refused — to the
salesman in the photograph and to the manager it exists for. Who may open one
is asked in `canReadAttendanceSelfie`: the person in it, and whoever can see
his attendance, which is `managerScope` — the Sales Dashboard's own narrowing
rather than a second opinion about it. Not "anybody holding the field app": a
salesman must not be able to fetch a colleague's photograph by id, and these
ids travel in payloads.

**AND THAT LAST SENTENCE WAS A PROMISE THE CODE DID NOT KEEP.**
`managerScope` narrows a REGIONAL manager and is vacuous for everybody else: it
answers `salesmanIds: null`, meaning everybody, for anyone with no `region` row
in `mbos_user_territories` — three separate returns in it do so — and a plain
field salesman has none. Which is nearly all of them. So the ordinary
colleague, holding only the field app, got the national answer and could open
anybody's check-in photograph by id. It failed OPEN, the dangerous direction,
and lasted because nothing looked broken: everything worked. The test that
should have caught it gave its colleague a territory row on purpose, "so he is
scoped rather than national", and stepped around the only case that leaked.

**So the `sales` GRANT is asked first, and the narrowing sits behind it.**
"Whoever can see his attendance" means whoever can open `/sales/attendance`,
and that layout redirects anybody without the grant whatever their role —
`listUserApps` reads `app_access` and nothing else, so there is no implicit
access for an admin. A manager who was never given the Sales Dashboard has no
screen on which to see anybody's attendance, and a photograph is not a back
door to one. Every OTHER caller of `managerScope` is a list inside `/sales/*`
and is already behind that layout; the two in `attachment-service.ts` are
reached from `/api/attachments/[id]`, which has no gate but a signed-in
session, which is why the check belongs in them.
`canReadTravelLegPhoto` is the same rule for the same reason.

**AND IT IS THE ONE FILE HERE WITH A CLOCK ON IT.** Everything else in this
subsystem is a photograph OF something — a damaged can, a cheque, a shop
front — attached to a record that stands without it, and it is kept as long as
the record is. A check-in selfie is not that. It is evidence that the person
who marked the day is the person who worked it, and that question is asked
within a day or two of the day or it is never asked at all. Held beyond that it
stops being verification and becomes a standing collection of photographs of
employees: worse to hold, worse to leak, and nothing anybody asked for.
`mbos.attendance.selfieRetentionHours` is the window — 72 hours — and
`sweepAttendanceSelfies` is what enforces it.

**HOURLY, not nightly, because the number is on a screen.** Swept once a night,
"72 hours" would mean up to ninety-six for everybody who checked in during the
morning, and the gap between what a setting says and what it does is the kind
of thing nobody notices until it is the subject of an argument about somebody's
pay. It rides `mbosHourly` beside the escalations.

**Measured from when it ARRIVED, never from when it was taken.** A salesman in
a district with no signal photographs himself on Monday and syncs on Wednesday;
anchored to the check-in, that file would be swept within hours of landing and
the manager would never once have been able to open it. The window is a promise
about how long somebody has to LOOK, so it runs from the first moment there was
anything to look at. The consequence is that the screen and the window can
honestly differ — a photograph on an old day may still be there — so the screen
shows what EXISTS rather than computing a window of its own. One number, one
enforcer.

**What goes is the image and nothing else.** The attachment row stays, the day
keeps its `check_in_selfie_id`, and every `sessions` entry keeps the ids it was
written with. "A photograph was taken at 09:04 and has since been deleted" and
"no photograph was taken" are different facts about somebody's attendance, and
the second is the one that reads as a person cutting a corner. A sweep that
nulled the columns would rewrite the first into the second, months later,
silently, on the record a payslip is read against. There is a test for it.

**The manager sees them on the Attendance screen, ONE PER MARK.** A day is a
list of arrivals and departures — a salesman breaks for lunch and comes out
again in the evening — so both ends of every session carry a photograph and all
of them are drawn. Showing the day's first selfie alone would verify that he
arrived in the morning and assert nothing whatever about the two marks that
decide the hours. Three things are drawn differently and they are three
different facts: a photograph you can open, one that was taken and has since
been deleted, and a mark with no photograph against it at all. `canRead` is
still what gates every image, so a manager sees his own team's and nobody
else's.

**A swept file answers 410, not 502.** `/api/attachments/[id]` used to reach
storage for a `removed` row, find nothing and report a read failure — which
reads as a broken backend and sends somebody looking for a fault that is not
there. The row is deliberately kept, so "it existed and is gone" is a thing the
endpoint can actually say.

**Removing an attachment is a status, not a delete.** It detaches from the
parent and moves to `removed`; the bytes go only when retention says so. A
payment proof outlives whoever tidied it off a screen.

**Attachments are read through `/api/attachments/[id]`, never a stored URL.**
Access follows the parent record's scope, so anyone who can see the complaint
can see its photographs and nobody else can. A file the caller may not see and
a file that does not exist answer identically, or the endpoint becomes a way to
enumerate customers.

**A retired outcome is readable, never writable.** "Part payment promised" is
gone from the follow-up form but stays in `PAY_OUTCOMES` marked `retired`, so
attempts already recorded against it still resolve to a label. The screen reads
`offeredPayOutcomes()`; the save schema simply does not accept it. Hiding it in
the interface alone would leave it reachable.

**A credit note amount without a request is refused.** A figure sitting on a
complaint nobody asked a credit note for reads as an approved amount to whoever
opens it next. Requests have nowhere to go yet — there is no Accounts app — so
they surface on a manager's pending list rather than sitting invisible. That is
interim, and a credit note has financial consequences.

**A credit-note request is a yes, and nothing more.** The telecaller answers
whether the customer asked for one; which bill it is against and what it is
worth are accounts' work, because they hold the ledger. Asking mid-call for the
bill produced either the wrong one or no request at all — the form was three
fields deep behind a radio button, and the person on the phone was waiting.
`bill_id` and `goods_description` stay on the row and are still stored when
something supplies them; nothing on a telecaller's screen asks. The pending
list left-joins the bill, so a request that names none still reaches accounts.

**An attachment nobody can open is an attachment nobody uploaded.** Photographs
were write-only for as long as they have existed: no screen displayed one, and
`canRead` handed a raw snake_case row to `assertCustomerInScope`, which reads
camelCase — with `as never` silencing the compiler. `kind` was absent and
`ownerId` undefined, so the owner was refused their own file and every read
answered 404. It failed SHUT, which is the safe direction and exactly why it
survived: there was no screen to notice it on. A cast that quiets a type error
across a naming boundary is the bug, not the fix.

**A stored enum is not a label.** `packaging_damage` was reaching the screen
unchanged. The categories a person picks from are configuration and several
fold onto one enum value, so the way back cannot be derived from that list —
`lib/complaint-labels.ts` holds it, pure and client-safe.

**A photo picker adds, counts and lets one go.** Complaint photographs are
taken one at a time, so a second visit to the file dialog must not discard the
first; the limit — `attachments.maxPerComplaint`, six — is shown and refused at
the picker rather than silently truncated by `bindAttachments` after the save;
and a wrong photograph comes out on its own. One component, `crm/image-picker`,
because the complaints dialog and the call drawer ask the same question and had
drifted into two answers. Its accept list is `ACCEPTED_IMAGE_TYPES` and never a
literal: both screens offered WebP for months while `sniffContentType` refused
it, so the picker took a file the save would not.

**The microphone is tinted, small, and inside the box.** It shipped as a
muted grey glyph in the bottom corner, the same weight as the resize grip and
overlapping it — and the two read as one piece of furniture. Nobody presses
furniture, least of all the telecaller who is not confident with computers and
is exactly who it was built for. What fixed it was not size: it is that the
control is coloured, so it registers as something offered rather than
something structural, and that it is nudged clear of the grip it used to sit
on. Its words — "speak instead of typing, say it in any language" — ride on
`title` for hover and for screen readers, not in the layout, because twenty
prose fields each carrying a sentence of guidance is clutter, not help.

**No screen names a language.** Not the button, not the modal. A list of four
reads as the set of allowed answers, and somebody whose language is missing
from it stops before they start — which is the exact fear the sentence exists
to remove. "Any language" says more by naming none.

**Dictation shows what it heard before it writes anything.** A telecaller
thinks in Hindi, Marathi or Gujarati and types in English slowly with the
customer waiting, so the note that gets written is the short version of what
was actually said — a loss nobody can see later, because "will pay" reads
exactly like a sentence that never named a date or an amount. The microphone
on every prose box is there to close that gap, and it opens a modal rather
than writing into the box: the person reads the English, edits it, and decides
to import it. Nothing arrives in a field unseen.

**The English it shows first is faithful, not a summary.** Transcription and
translation are two passes and the second is instructed to drop nothing —
numbers, bill numbers, product names and commitments all survive. Tightening
is a THIRD pass somebody asks for by pressing a button, having read the long
version, and Undo puts it back. A summariser on the way in would quietly lose
the bill number, and the note it produced would look exactly like an honest
one. The original-language transcript is a click away, because the only way to
know a translation went wrong is to read the sentence it came from.

**A held recording captures nothing, and the screen has to look like it.**
Pause is `MediaRecorder.pause()`, so the held seconds are ABSENT from the blob
rather than recorded as silence — what comes back is what was said before and
after, joined. The audio track is disabled alongside it, which takes the
microphone out of the loop as well as the container. The timer stops, so
`elapsed` counts recorded seconds and not wall-clock ones: that is the number
the recording ceiling has to be measured in — a five-minute interruption must
not eat somebody's limit — and it is the number the server routes on, since
Sarvam's 30-second refusal is about the length of the audio and not how long
the modal was open. The pulse ring stops, the level meter goes STILL rather
than falling back to its idle loop, and the sentence says nothing is being
recorded. A meter travelling under the word "Held" is the screen claiming it
can still hear you. The button is not drawn at all where the browser cannot
pause — Safari only learned in 14.1 — for the same reason the microphone is
not drawn where it cannot record. Closing the modal from a pause has to
release the microphone too: the cleanup tests `state !== "inactive"`, because
a held recorder is neither recording nor inactive and `=== "recording"` left
it running.

**The audio is never stored.** It is read from the request, sent to the model
and dropped: no `attachments` row, no blob key, no retention window and no id
to fetch it back by. A recording of a customer conversation is a different
thing to hold than a photograph of a damaged can, and nothing here has asked
to hold it. That is also why dictation is a route handler rather than a server
action — two minutes of Opus is past the 1MB action body limit, and raising
that ceiling for every action in the app to carry one feature's audio is the
wrong trade.

**A microphone that fails when pressed is worse than one never offered.** It
draws nothing at all when `voice.enabled` is off, when there is no key, or
when the browser cannot record — and the setting is checked in the route as
well as in the interface, because a hidden box is not a disabled feature.

**Sarvam is asked first, and OpenAI catches what it cannot take.** `saaras`
is built for Indian languages and code-mixed speech — Hindi with English words
dropped in mid-sentence is what it is FOR rather than something it copes with,
which is how a telecaller actually talks. Its synchronous endpoint refuses
audio over 30 seconds, and rather than cap every recording at half a minute,
anything longer goes to OpenAI instead, as does anything Sarvam fails on. The
recording is never lost to a provider's ceiling, and `checkConsistency`
refuses a recording limit above 30 seconds only when the fallback is off —
otherwise the limit and the ceiling are allowed to differ, because the routing
is what reconciles them.

**OpenAI is the floor; Sarvam is an improvement on it.** A deployment with
only an OpenAI key runs the whole feature — hearing, writing, tightening — at
the full recording limit, whatever the provider and fallback settings say.
Sarvam is what makes the short recordings better, not what makes dictation
work. The fallback switch exists to honour the opposite deployment, one that
HAS a Sarvam key and wants audio kept inside India at the cost of the
30-second ceiling; with no Sarvam key there is no such deployment to honour,
and the switch used to refuse OpenAI on behalf of a provider nothing was going
to ask — a configured account sitting unused behind a microphone nobody was
shown. Both `resolveReadiness` and the guard in `transcribeSpeech` now require
a Sarvam key to be present before the switch means anything, and the tests
sweep every provider/fallback combination against a missing Sarvam key to say
so.

**The duration comes from the browser, and being wrong about it is cheap.**
The recorder already counted the seconds for the timer on screen, so the
client sends them and the server routes on that. Decoding the audio
server-side would ship a decoder to answer a question the recorder had already
answered; a tampered value costs one refused Sarvam call and a fallback, which
is what would have happened anyway. A missing value reads as long, which is
the safe direction.

**Sarvam is asked twice, in parallel, on the same audio.** `transcribe` gives
what was said in the language it was said in; `translate` gives the English.
Both are needed because the "show what was heard" panel is the only way anyone
catches a translation that went wrong, and they run together so the person
waits for the slower rather than the sum. Where OpenAI serves instead, the
English is a second, text-only pass over the transcript — same two answers,
different shape.

**Claude could not have been the ear.** Its inputs are text, images and
documents, with no audio modality at all, so an Anthropic key buys the writing
half and none of the hearing half. Transcription is the half that decides
whether a microphone can do anything, which is why it is not offered there.

**Hearing and WRITING are two jobs, and only one of them needs a particular
provider.** The bytes can only go where the audio is sent, but turning what
was heard into English is a text call any chat model can make, so
`lib/writing-model.ts` tries OpenAI and then Sarvam and the note gets written
either way. Welding both jobs to one account is what produced a deployment
whose Sarvam key worked perfectly and whose notes were raw machine
translation, with Tighten and Rewrite hidden and nothing saying why. OpenAI is
asked first because English prose is what it is best at; Sarvam second because
a plainer sentence beats no sentence. A permanent refusal — no credit, revoked
key — moves straight to the next provider rather than being reported, because
the person is mid-call and does not care whose billing failed.

**Every path runs the written pass, including Sarvam's.** Sarvam's `translate`
is a translation and reads like one: correct in substance, rough in grammar,
unpunctuated where speech was. It was going to the telecaller verbatim, which
made them the proofreader mid-call — most of what dictation was supposed to
give back. The writing model is handed BOTH the original-language transcript
and Sarvam's English, because the two disagree usefully: the transcript holds
what was said, the draft holds a reading of it by a model built for these
languages. Rendering from the transcript alone throws away the better half of
the evidence for a name or a number.

**Correct English is a rule of the prompt, not a hope.** `RENDER_SYSTEM` makes
grammar, tense, agreement, articles, prepositions, word order and awkward
machine-translation phrasing all the model's to fix — and says in the same
breath that fixing the English is not licence to change a fact. A note somebody
has to decode is a note they stop trusting; a note that reads well and quietly
lost the bill number is worse than both.

**Tighten and Rewrite are left out rather than shown broken.** They are a text
call, so `/api/dictate` answers `canRefine` and the modal omits the buttons
when it is false — but that is now false only when NEITHER provider has a key.
Requiring OpenAI hid both buttons on a deployment that could have run them,
which is the microphone mistake one level down: a capability withheld because
of who was asked rather than because of what could be done.

**The keys are set from a screen, because a terminal is not a fallback.** On a
deploy nobody has shell access to, an environment variable is a door somebody
else has to open, and the feature stays off until they do with nothing saying
why — the same lesson the sheet import already learned. `app_secrets` is
DELIBERATELY not `app_settings`: settings are rendered on screens, exported as
JSON, and audited with their before and after values, so a key kept there
would be readable in four places and one of them is a log nobody prunes.
`readSecret` is the only function that selects the value and it is called by
the request about to spend it; screens call `secretStatuses`, which selects
the last four characters and nothing else. The audit row records who changed
which credential and when, never what to. The console wins over the
environment where both are set, and the environment still works alone, so a
deploy that already has variables needs no migration.

**A key is stored as written, and the screen says so.** There is nowhere to
keep an encryption key that MahekOne can read and a database backup cannot —
one in the environment puts us back to needing shell access, which is the
problem the table exists to solve. Pretending otherwise on the screen would be
worse than the storage itself, so the screen states the trade and says to
rotate at the provider if a dump ever leaves your hands.

**Dictated text is added, never substituted, unless somebody says otherwise.**
Where the box already has words, Add and Replace are two buttons and Add is
the default one. `VoiceTextarea` decides the joining and the `maxLength`
ceiling in one place rather than at twenty call sites that would each get one
of them slightly wrong — `maxLength` stops typing but not a programmatic set,
so the box would otherwise accept more than the field will save.

**THE SALESMAN GETS THE SAME MICROPHONE, and he needed it more than the
telecaller did.** A telecaller types slowly with a customer on the line; a
salesman types on a phone, one-handed, standing in a shop, in a language he
does not write. MBOS had a microphone on exactly one box — a "Hold to talk"
recorder on the visit screen — and the other seven prose fields on the app
(the lead note, the leave reason, the expense note, the tour purpose, the
complaint's "in their words", the sample's "why he wants it") had none. That
recorder had also never been reachable: nothing on any path called
`requestMicrophone`, so `RECORD_AUDIO` was never asked for and preparing
threw, and the screen reported a broken handset rather than a dialog nobody
put up. `VoiceField` is `VoiceTextarea`'s counterpart and every one of those
boxes is one now.

**It is the SAME hearing, through the same functions, behind a different
door.** `lib/dictation-requests.ts` holds what used to be inside
`/api/dictate/*`: read the configuration, ask `transcribeSpeech`, and turn
each of the six ways it can fail into a status and a sentence. Only the
authentication differs between the two doors — a browser session for the CRM,
a device token for `/api/mbos/dictate/*` — and three of those six sentences
are specific and hard-won ("record it in two shorter goes" is not "the service
is down", and neither is "tell your manager, this one will not fix itself"), so
a second copy of that ladder would drift within a release. The half that
drifts is always the half somebody reads at the worst moment.

**A handset cannot ASK whether it may draw a microphone.** The CRM's mic hits
`/api/dictate` as it renders, which is right for a browser and useless in a
godown with no bars — a screen that had to reach a server before offering a
button would offer none exactly where speaking beats typing most. The answer
rides down on the pull instead, as `mbos.ai.dictation`, and is read from the
local cache. What crosses is the ANSWER and never the question: no `voice.*`
setting goes down that wire and no key behind one, because nothing on a phone
calls a transcription provider — the audio goes to MahekOne and MahekOne spends
the credential. Two tests in `mbos-wire.test.ts` pin both halves, because the
two sides are joined only by a spelling and getting it wrong FAILS SILENTLY:
`getConfig` falls back to `{ available: false }` and every screen simply draws
nothing, on a deployment that paid for the feature and switched it on.

**No signal is a different refusal from no provider, and they are drawn
differently.** No provider — dictation off, or no key — is permanent, so
nothing is drawn at all, which is the rule the CRM already follows. No signal
is temporary and changes minute to minute, so the mic stays where it is and
goes dim; a control that appeared and vanished while somebody looked at the
screen is one they learn is not there.

**And one field has an answer to no signal rather than an apology.** The visit
note is where the recording is a record of what a customer said rather than a
keyboard, and a visit has somewhere to keep audio — so `keepAudio` there means
the mic still works offline: it records, the file joins the media queue, and
the office writes it out on the far side through the transcript channel that
already existed. That is what the old "Hold to talk" recorder claimed to do.
Everywhere else the audio is dropped the moment the words come back, exactly
as the CRM's is, because a recording of a customer conversation is not a thing
to hold without a reason.

**A visit keeps the recording even when it was dictated.** The words in the box
are somebody's reading of what was said; the audio is what was said. Handing it
to the queue happens BEFORE the transcription is attempted, so a provider that
does not answer costs the note and never the recording — and saying it again
discards the superseded file rather than shipping every attempt.

**Speech is not music, and the preset was for a band.**
`RecordingPresets.HIGH_QUALITY` is 128 kbps of stereo at 44.1 kHz — about a
megabyte a minute, crawling up a 2G link while somebody waits for their own
words, or sitting in the media queue ahead of the payment behind it. None of it
buys accuracy: every model this audio can reach downmixes to mono and resamples
to 16 kHz first. 24 kHz mono at 32 kbps is a seventh of the size and still
comfortably above what they use. `LOW_QUALITY` is the wrong floor in the other
direction — AMR narrowband on Android is a telephone line, and a telephone line
is where transcription of Indian-language speech starts losing names and
numbers.

**The bytes are sniffed here too, and for the second reason rather than the
first.** The handset labels its own recordings `audio/m4a`, which names no
container Sarvam recognises — and the extension there is the one place a media
type is genuinely load bearing, since the service refuses the part before it
reads a byte. The bytes say `audio/mp4`, which is both the truth and what
Sarvam can take.

**An order taken on a call is the customer saying yes, not the business.**
Accounts check who they are and what they already owe before it is accepted,
so a new order sits at `pending_approval` until they decide. Two different
questions get asked of the same row and they have different answers: "did the
customer order" is true from the moment it is logged, and drives the calling
queue; "did we sell anything" is true only once approved, and drives EOD value,
targets, the buying cycle, the product history and outstanding. The second
question is asked in eight places and they all read `lib/order-status.ts` —
before that existed they said `status <> 'cancelled'`, which would have counted
every pending and declined order.

**`lastOrderDate` moves on capture, not on approval.** It is the signal that
stops the queue chasing somebody who ordered this morning, and a telecaller
must not ring them because approval is slow. A declined order drops out of it,
so the customer returns to the list on their own cycle. The buying cycle uses
approved orders only, which is why `writeCycle` takes the placed date
separately — computing both from the same rows put them in conflict.

**Approving is accounts' and nobody else's.** Not a manager by seniority: the
person chasing the target must not sign off the orders that hit it. Declining
requires a reason, and it lands on the customer timeline, because the telecaller
has to ring back and say something.

**AND THE PERSON WHO TOOK IT IS TOLD, which for a long time they were not.**
The sentence above was the whole of it: the reason landed on the timeline and
stopped there, so the telecaller who had promised a customer their order found
out by opening that customer's record — which nobody does unprompted. In
practice the customer rang first. Every other write in this app that changes
somebody else's work already tells them: a reassignment tells both sides, a
feedback reply tells the reporter, a target revision tells whoever it was set
for. `lib/notify.ts` says in as many words that a decision nobody receives is
not a decision, and `lib/actions/sales.ts` says it about MBOS approvals — an
order decision was the one path in the app that never said it.

**The reason travels IN the message, not behind a link.** It is the entire
content of a decline — they have to ring the customer and say something — and a
notification that makes somebody open a screen to find out what to say is one
they read later. The decline is `kind: "warn"`, which is a kind the bell
actually colours: it reads `warn` and `danger`, and the several existing callers
writing `warning` are silently drawn as ordinary.

**And it carries NO `mbosHref`, deliberately.** The obvious guess is
`/rejections`, since that is where a field salesman reads what the office
refused — and it would be wrong. That screen renders `listRejections` from the
handset's own OUTBOX: records refused before they were ever stored. An order
declined here synced perfectly well days ago, so it is not in that queue and
never will be, and the tap would land on a screen that does not contain it. A
null falls through to `/notifications`, which carries the reason in the body —
the honest default `notify.ts` names, and better than a deep link that is
confidently pointed at nothing.

**Whose number it is, is `orders.userId` — never whoever owns the account
today.** The person who has to ring back is the one who made the promise, and a
reassignment since does not move that. Two people are deliberately not told: an
order the SHEET wrote carries no `user_id`, because nobody in MahekOne took it,
and an approver who is also the taker does not need telling what they just did —
the same discipline as a reassignment that changes nothing notifying nobody.

**It runs after the transaction and can never fail the decision.** The order is
decided, audited and recomputed before the courtesy runs, exactly as the
next-step sentence is a courtesy on top of a completed call. A bell that could
not be written must not undo an order decision already standing in the ledger.

**Money the customer says has arrived is not money the business has seen.** A
payment reported by a telecaller sits at `reported` until accounts find it in
the bank, and `bills.paidAmount` — and therefore outstanding, aging, the
slow-payer flag and the collections worklist — counts CONFIRMED receipts only.
Before this, a telecaller's word reduced outstanding on the spot, so a transfer
that never landed erased real debt from every screen with nobody's name against
the decision. `recomputeBillPaid` rebuilds the figure from confirmed lines
rather than incrementing it, which is what makes confirming, rejecting and
re-confirming all land on the same answer.

**What a reported payment DOES do is stop the chasing.** The customer is held
back from collections with the reason said plainly, never silently dropped, and
the quiet expires after `payments.reportedQuietDays` — an unexpiring one would
let a customer take themselves off the list by saying they had paid, and the
account would simply stop appearing. Reported money outranks a promise, because
it is the better news; do-not-contact still outranks it.

**Reversing is not rejecting, and the difference is what the statement says.**
Rejecting means accounts looked for the money and never found it: it never
counted, and the customer's statement reads "never arrived". Reversing means it
counted and then failed — a cheque that cleared and bounced, the same transfer
entered twice, a receipt applied to the wrong customer. Telling a customer who
genuinely paid that their money was never seen is wrong on the one document
they might dispute a balance against, so `reversed` is its own status.
`reverseReceipt` takes the same capability as confirming, because taking money
off an account is the same kind of decision as putting it on; it refuses a
`reported` receipt outright, since nothing has counted yet and rejection is the
honest answer. Nothing else had to be taught about it — every money path keys
on `confirmed`, so a receipt that stops being confirmed stops counting
everywhere at once. It is offered on the customer account statement, on the
line itself, because reversing a payment begins with finding it and that is the
screen somebody is already on.

**Rejecting is not deleting.** The receipt keeps its row and its reason, gives
the balance back to the bills it named, and returns the customer to the worklist
with their stage floor intact. It lands on the timeline because somebody has to
ring back and say something. A rejected receipt stays on the customer's
statement too — a transfer that never arrived is a fact about the account, and
dropping it leaves the next person wondering why the balance never moved.

**Holding is a pause, and it is a fourth status rather than a shade of
`reported`.** `reported` means nobody has looked at the claim yet, and the quiet
it buys the customer EXPIRES — otherwise anybody could take themselves off the
collections list for good by saying they had paid. `held` is a named person in
accounts saying "I am looking for this in the bank statement, leave them alone
until I have", and its quiet does NOT expire: chasing somebody while we are
part-way through establishing that they paid is worse than any call not made.
What replaces the expiry is visibility — the hold ages in plain sight on
accounts' own list, `payments.holdStaleDays` flags it there, and only a person
ends it. It touches no money, because every money path keys on `confirmed`, so
nothing else had to be taught about it.

**A hold silences BOTH channels, and the customer is told why through the
telecaller.** No calls and no reminder messages, which falls out of
`blockingReason` gating both. The reason is required by the action, not just by
the form: a telecaller whose customer has gone quiet has to be able to answer
when that customer rings and asks why nobody has been in touch. Rejecting a
hold puts them straight back on the worklist; confirming takes them off it for
the right reason.

**A held payment is not a neglected one, and no screen counts them together.**
"Waiting more than 24 hours" on a reported payment means the customer's quiet
is about to lapse and they will be chased for money nobody has looked for; on a
hold none of that sentence is true. They get separate banners, separate
ageing — `payments.holdStaleDays` — and the statement gives a hold its own pill
rather than "with accounts", because somebody has looked at this one. The
running balance counts confirmed money only, so a hold moves nothing.

**Re-pointing is offered even where NOTHING is open.** That is not a dead end,
it is the most stuck case: the bill the money was reported against has been
settled by something else, so confirming as it stands is refused and there is
no other bill to name. Re-allocating with no open bills puts the whole amount
on account, which is the honest answer — the money arrived and there is nothing
left for it to pay. Hiding the control exactly there would make the only way
out invisible.

**Confirming can re-point the money, and that is also the way out of a dead
end.** `confirmReceipt` takes an optional allocation and runs the SAME pure
`allocate` the record form runs, so the preview in the review drawer is the
arithmetic that gets written. Before this, a bill named at report time that had
since been settled refused the confirmation outright and left
reject-and-re-record as the only path — which throws away the claim, its date
and its reference to fix something that was only ever about which bill.

**A reported payment does not make a bill look settled.** A bill offers its
whole unconfirmed balance; money somebody has merely reported against it is
SHOWN on the row and never subtracted from it. Subtracting was the old guard
against two people writing down one transfer, and it made a fully-claimed bill
read as zero available — so accounts holding the bank statement could not record
the very money they were looking at, while the ledger still said the customer
owed it. The duplicate is now caught where it happens: `matchesForEntry` asks a
person a question they can answer, instead of silently making a bill
unavailable and leaving them to work out why.

**And the rule holds on the screen, not only in the service.** The entry form
kept subtracting `paid + reported` from what it offered for months after
`recordReceipt` stopped — so the preview and the save disagreed about the same
bill, and the preview was the half people were working from. A bill somebody
had claimed read ₹0 available, ticking it answered "no longer open", and the
only way to record money accounts could see in the statement was to reject the
claim first. What the row shows instead is a pill: the amount claimed, said as
a hold. The same mark is on the bill line of the customer statement, because a
bill still standing at its full amount after the customer said they paid it is
exactly the row somebody needs an explanation on. The telecaller's collections
path had the same subtraction, where it pushed the next payment past a claimed
bill onto the following one or onto account — money filed against the wrong
bill to work around a balance that was never real.

**One payment written down twice is the ordinary failure, and it is caught at
the point of entry.** A telecaller records what a customer said days before the
transfer reaches a statement. `lib/engines/receipt-match.ts` is pure and offers
candidates strongest-first: a normalised reference beats an equal amount —
because a UTR names one transfer and where the amounts then disagree that is
exactly what somebody needs to see — and a near amount is a question rather than
an answer. Two receipts with no reference match on nothing, or every
unreferenced receipt would match every other. Only `reported` and `held` are
ever candidates: offering confirmed money invites confirming one payment twice.

**Recognising it CONFIRMS the existing receipt rather than writing a second.**
That is the whole point — one payment, one row, the customer credited once —
and accounts' reference and date are written onto it on the way past. The
amount is not: a different amount is a different payment. The typed
confirmation is checked in `confirmAsMatch` as well as in the dialog, because
merging two records of money is not a thing to do on a stray click and a check
that lives only in an interface is not a check. A genuine second payment of the
same amount is still recordable — made deliberate, never refused, or people
learn to work around the screen.

**The match is a SUGGESTION, and it never stands in the way.** It used to: a
near-certain candidate blocked the save until somebody ticked "this is a
different payment". But the screen is guessing from an amount and a date, and
two customers paying ₹50,000 in the same week is an ordinary Tuesday — a gate
in front of the ordinary case is a gate people learn to click through. It
appears as the amount is typed, it is answered with "Yes, this is the one" or
"No — this is a different payment", and either answer takes it off the screen.
Editing the entry asks again, because a changed entry is a changed question.
Nothing is weakened by this: yes still opens the merge dialog, still needs the
amount typed back, and `confirmAsMatch` still checks it on the server.

**A cheque has two dates and they answer different questions.** `received_at`
is when we got it; `instrument_date` is what is written on it, and a cheque
handed over on the 3rd dated the 20th cannot be banked until the 20th however
firmly it is in our hands. Which modes carry one is `payments.datedModes`,
because the mode list is itself configuration and hardcoding "Cheque" would put
the two out of step the day somebody adds a demand draft. Past and future are
both ordinary and neither is bounded.

**The date is asked of everybody, unlike the reference.** The reasoning that
spares a telecaller a UTR does not carry across: a customer who says they have
paid by cheque is holding the cheque, and "what date is on it" is a question
that can be asked on the same call. Without it accounts cannot tell a cheque due
to be banked this morning from one dated next month.

**A post-dated cheque buys quiet until it can be banked.** The reported window
is a few days and a cheque can be dated a month out, so measured from when it
was written down the quiet lapses long before the money is even reachable — and
the customer is chased for a cheque sitting in our own drawer, which is the most
annoying call it is possible to make and one where they are entirely right. Once
the date passes, the ordinary window runs from THERE rather than from the day
somebody wrote it down. Accounts see the mirror of it: a cheque dated today or
earlier is flagged as something to go and find, and a post-dated one is
deliberately calm, because marking what is not yet asking for anything is how
people learn to ignore the marking.

**One component asks how the money came, because it was three.** The
collections worklist, the bills ledger and the call panel each carried their
own copy of Mode and Reference, each with the mode list written out as a
literal — so `Credit note` reached the accounts app and none of them, and the
cheque date would have had to be got right three times.
`components/crm/payment-mode-fields.tsx` is the one answer, and it reads
`payments.modes`. A list of modes typed into a screen is the same mistake as a
product list typed into a screen.

**A validation message goes under the field it names.** These dialogs pinned
whatever the server said to the amount box, so "a cheque needs the date written
on it" appeared under Amount received — pointing at the one field that was
correct. The field errors carry their `field` through and are rendered against
it; a message under the wrong field is worse than no message, because it sends
somebody to fix what is not broken.

**`Adjustment` and `Credit note` are payment modes, and neither is money
arriving.** One settles a bill against something already on the account, the
other against goods returned or a claim allowed. Both close a bill exactly the
way a transfer does, and leaving them off the list is how they get recorded as
cash nobody can find in the statement afterwards. `0051` appends `Credit note`
to deployments carrying the old default, matching on `updated_by_id is null`
AND the stored value still being the previous default — a team that curated its
own list, including one that deliberately removed a mode, is left alone.

**A receipt is one arrival of money; `payments` rows are where it went.** Which
bills a transfer settles is a second question with a second answer, so a
₹50,000 payment across three bills is one receipt and three allocation lines.
Fusing the two — which is what a payment pinned to a single bill was — makes
part payment, a transfer covering several bills, and money received in advance
all impossible to record honestly. A line with a null `billId` is money on
account, and a remainder becomes one rather than being refused at the door:
refusing it is how a receipt gets recorded for the wrong amount to make the
screen accept it.

**Allocation is pure, and the screen runs the same function the server does.**
`lib/engines/allocation.ts` takes bills, an amount and one of four
instructions — oldest first, newest first, settle these, split it myself — and
returns lines. Accounts are deciding where the money goes, so a preview that
disagreed with the save would be worse than no preview. What a bill offers is
its whole unconfirmed balance: money merely reported against it is shown beside
it and never subtracted, and the duplicate is caught at the point of entry
instead.

**Only the automatic spread has a direction.** Oldest first is the default and
the ordinary answer — the oldest debt is the one aging, and clearing it is what
takes a customer off the collections list. Newest first is for the customer
paying against the invoice in front of them, where spreading from the oldest
end settles a bill from March and leaves the one they were talking about
standing. Ticking bills or typing amounts has already said which bills, so
`order` means nothing there and is ignored rather than offered.

**A reference is asked for, and no longer demanded.** Accounts match a receipt
against the bank statement by that string, so one recorded without it is money
somebody has to go looking for — worth asking, and never worth refusing a save
over. `payments.referenceRequiredModes` is EMPTY by default now. The rule it
enforced was aimed at whoever asserts the money arrived, which is exactly the
person sitting with the statement open, having already found the payment they
were entering: the entry is itself the cross-check the field was standing in
for, and the red line under the box stopped them recording money they could
see. It was never asked of a telecaller repeating what a customer said — they
rarely have the UTR, and refusing that save would lose the claim rather than
improve it. Naming a mode in the setting brings the rule back for it, and
`0052` moves deployments that never curated the list.

**Confirming is checked server-side, and a stale allocation is refused rather
than moved.** If a bill a pending receipt names has been settled by something
else since, confirming fails and says so — silently re-allocating money is not
a decision code should take on its own.

**A collections call is logged in one place, and it is one transaction.** The
follow-up panel opens over the worklist and never navigates away — a
telecaller working a list of twelve should not lose their place to look at a
bill. One outcome can produce a promise, its reminder, a payment spread over
the oldest bills first, a billing complaint and a raised stage floor; a
half-saved one leaves the account describing something that never happened.
The seven outcomes and what each requires are declared once, in
`lib/services/payment-followup-service.ts`, and the screen reads that list —
so the form and the action cannot disagree about which fields are mandatory.

**The stage is derived, but it has a floor.** A customer who refuses to commit
or cannot be reached has told you something their bill dates have not, so that
outcome raises `manualStageFloor`. `recomputeFollowUpState` takes the higher of
the derived stage and the floor: the stage still rises with the age of the
debt, and never reads below what the refusal earned. The floor leaves with the
row when nothing is overdue, because it described a debt that no longer exists.
A floor a recompute erases is not a floor, and there is a test saying so.

**The slow-payer flag has a grace period, and the grace is on the due date.**
A payment landing a day or two past its term is ordinary business — a cheque in
the post, a bank holiday, an accounts department that pays on Fridays — and
counting those flagged customers who pay perfectly reliably, just not to the
calendar. `escalation.slowPayerGraceDays` (7) is what a payment has to exceed
before it counts as late at all; `slowPayerLateCount` still decides how many
late ones earn the flag. Forgiving the count instead would let a customer who
is genuinely a fortnight late three times over pass as reliable. The flag is
read as "be careful with this one", so it has to mean it, and it is a derived
cache — changing the grace and re-running `recomputeSlowPayers` reclassifies
the whole book without touching a row.

**A late bill is messaged before it is called.** For the quiet window — 15 days
past the due date — the customer gets a reminder message every four days and no
call at all, because a bill a few days late is usually paperwork rather than
refusal. Calls open the day the window closes, and from then the customer rests
three days after each logged call. Messages do not stop when calling starts.
The window and the stage-2 threshold are two statements of the same fact, so
`checkConsistency` refuses to let them drift: if the list offered a call on a
day `isAttemptAllowed` still called stage 1, saving it would be rejected.

**The list is ordered by WHY, then by what that reason is worth.** The tier
weight decides the order of reasons and does not move: a promise beats an order
due, which beats a stock check. Within a reason it was "who owes the most
money", which is a collections answer given to a sales question — among twenty
customers all due to order, the one who owes most is not the one to ring first,
and a telecaller working top-down spent the morning in the wrong half of the
book. `callValuePaise` asks the question the reason is about: a collections call
is worth the debt, a sales call is worth the order. The order figure is the
MEDIAN of the customer's own recent approved orders, never a figure derived from
the catalogue — there are no prices in the product master and a confident wrong
number would be worse than none.

**A prediction is discounted by how sure we are of it.** `cycleConfidence` was
computed, stored, banded and displayed, and nothing acted on it. Two customers
averaging thirty days are not alike if one orders every 29, 30, 31 and the other
after 15, 45, 22, 60 — so where the reason is a PREDICTION (order due, overdue,
stock check) the order value is multiplied by it. A lakh at a coin toss is worth
less than sixty thousand like clockwork. Reminders, prospects and check-ins are
facts rather than predictions and carry their value whole. A NULL confidence
discounts nothing: every cycle computed before the column existed carries one,
and halving them would be a uniform penalty dressed up as a judgement — missing
information must never demote anybody.

**Confidence also moves the stock-check day.** The call lands at
`queue.routineCallPercent` of the cycle, swung by `queue.routineConfidenceSwing`
— a perfectly regular customer is called LATER, closer to the day they actually
order, and an erratic one earlier, because the honest answer to a guess is a
wider net. Fifty is neutral, so a swing of zero is exactly the old flat
behaviour. It moves the day and never creates a call the cycle length says
should not exist — a short cycle still gets no stock check.

**Suppression is a return value, not a filter.** `buildQueue()` returns held-
back customers alongside the queue, and the screen shows them. A telecaller
must always be able to find out why somebody they expected is missing.

**An import of order history never sets `activeInOrderSystem`.** That flag
means live activity in the external order system, and the queue holds such a
customer back — `queue.excludeActiveInOrderSystem` is on by default. The
projection set it on every row it touched, which muted the whole book the first
time production filled itself: a full database and an empty Call Log, with the
cause living in a column no screen shows. `0021` clears what it wrote.

**What DOES set it is the Taken Order tab, and only through a full reconcile.**
That tab is where an order lands first — typed as the customer gives it, hours
or days before it is dispatched, billed, or written to the Order Details tab.
While any line of an order is still open the customer has already ordered, and
the Call Log must stop asking them to; `recomputeOrderSystemHolds()` is the one
thing that writes the flag and it rewrites every customer on every pass. A pass
that only ever SET it is how the book goes quiet for good: nothing would lift a
hold, and an order that shipped in August would still be muting its customer in
March.

**Two cells decide it, and the rule is asymmetric.** `Status` (column L) at
`Ready` AND `Entry status` (column R) at `Done` releases the customer; either
one falling short holds them — a Ready order the office has not finished with
is still open, and four of them are. Everything else holds too, because the
vocabulary is not closed: an unrecognised value must never read as dispatched,
and the cost of holding wrongly is one early call, shown in the held-back strip
with its reason.

**`Cancel` is the exception, and it has to be.** It releases on its own,
whatever the entry status says. Every other status eventually becomes `Ready`;
a cancelled row never changes again, so holding it is a mute with no event left
that could lift it — and the customer behind a cancelled order has not ordered
anything, which makes them exactly who should be rung. Reading it as "unknown,
therefore held" muted 294 rows' worth of customers permanently, which is how
the carve-out was found.

**A hash-driven sync needs a reparse, or a changed rule never lands.** Nothing
was rewritten when `Cancel` changed meaning: not one of those 294 rows differed
by a character, every hash matched, and the customers stayed muted on the
strength of a decision already reversed in the code. `npm run jobs --
taken-order-reparse` re-reads what is stored, touches Google not at all, and is
the command to run whenever the READING of a row changes rather than the row.

**An order is contact, and the check-in dates from the LATER of the two.**
Somebody spoke to the customer to take that order, so an order that arrived
through the sheet counts as much as a logged call. Preferring the call and
falling back to the order only where there was none — which is what `??` did —
rang a customer who ordered on Tuesday to ask how they were getting on, on the
strength of a call three weeks old. Below both sits the record's creation date:
reading that first dates a customer of four years from the afternoon their row
was written, so an imported book sits off the queue for a week. Prospects still
fall back to it, having no order to be dated from.

**A date derived from a timestamp names its zone in JavaScript too.**
`createdAt.toISOString().slice(0, 10)` is a bare `::date` in different clothes —
it answers in UTC, so a row written at 2am IST is dated to the previous day.
`calendarDate()` is the way. This one hides better than the SQL spelling, which
at least behaves differently on a database running in GMT: `toISOString()` is
wrong on every machine equally, so it never looks like a timezone bug. It had
reached ten places, and the one that mattered was `writeCycle` — those dates
become the INTERVALS the buying cycle is the median of, so a 2am order
shortened one gap and lengthened its neighbour, and the cycle is what decides
when the entire book is called. A second grep test now guards `src/` for it,
beside the one that guards `lib/` for the SQL spelling. A full ISO timestamp is
left alone: an instant carries its own zone, and only truncating it to a day
loses one.

**And a stored instant is not a wall clock until a zone is named.** The third
spelling of the same rule, and the one that reached a screen. `getHours()` and
`getDate()` answer in the zone of whichever machine is asking — a `page.tsx`
formats on the server, the server is Vercel and Vercel is UTC — so every
timestamp rendered server-side came out five and a half hours early. An order
taken at 9am read "3:30 am", which looks like a machine writing rows in the
night rather than a person on a call, and it was reported as exactly that
suspicion. Like both of its siblings it is correct on a laptop set to IST, so
it was right in development and wrong only in production. `stamp`, `stampDate`
and `clock` name `APP_TIMEZONE`, and a third grep test in §11 keeps every
local-zone getter out of `src/`. `getUTC*` is exempt: it names a zone, and
`longDate` uses it deliberately on a date-only value.

**A time nobody chose is not shown as a time.** A CRM order is stamped 09:00 on
the date it is FOR — the telecaller may state a past date, because an order
often arrives before anybody logs it — so the clock part is filler the capture
path writes and says nothing about the call. Printed beside a real name it read
as "Poonam took this at nine in the morning", which nobody could have known.
Order approvals shows the date alone; how long it has been waiting is its own
column, measured from the real `created_at`.

**A salesperson is a name, not an account.** The Sales Party tab's `Sales
Person` is who sells to a customer, and most of those people have never signed
in — several are not people at all ("Western Line Sale", "Company Own",
"JAIPUR"). `salesAmId` can only hold a `users` row, so the projection linked
the handful that matched and dropped the rest, and every screen fell through
to the owner: all 557 customers showed a telecaller as their salesperson.
`customers.salesPersonName` holds the name itself, the screens read it first
and the linked account only where the sheet is silent, and
`recomputeSalesPeople()` rebuilds it from what is already stored — the command
to run when the reading changed rather than the row.

**Changing an account manager is accounts' and admin's, and not a manager's.**
Whose book an account is in decides who is credited for its orders and whose
targets it counts toward, so a manager reassigning accounts is a manager moving
numbers between their own people, including themselves — the same conflict
`order.approve` exists to avoid, one level up. `customer.reassign` sits in
`ACCOUNTS_ONLY` and is checked in the action, not by hiding the button.

**An account has a THIRD seat above the sales one, and it drives nothing.**
The sales manager is who the salesperson answers to — the person a regional
review starts from, and the person whose departure moves a hundred accounts at
once. `ASSIGNED_TO_SQL` does not read it, no queue is dated from it, no target
counts against it, no collections list narrows by it and no scope resolves
through it. That is the whole reason it can be a MANAGER's while the two
beside it stay accounts' and admin's: `customer.reassign` is the narrowest
capability in the app because moving the sales seat moves numbers between a
manager's own people, and moving this one moves none. It is its own capability
(`customer.assignSalesManager`), its own action and its own dialog — folding it
into `updateAccountManagers` would have put one function behind one capability
doing two jobs with two answers about who may do them, and the generous answer
always wins in the end.

**And it takes no `amDecidedAt`.** That mark exists to hold the sheet off the
two seats it keeps restating; the customer master carries no sales manager at
all, so there is nothing to hold off, and stamping it here would silently
freeze the OTHER two seats against a sync as a side effect of naming a line
manager. `sales_manager_person_name` is the seat itself where the person
holding it has no login, like `back_office_name` and unlike `sales_person_name`
— nothing rebuilds it, because nothing outside MahekOne states it.

**A whole book moves by FILTER, not by ticking twenty-five rows at a time.**
The question this seat exists to answer is asked hardest on the day somebody
leaves, and the answer is "everything Rahul had" — a hundred and forty-seven
accounts spread over six pages. So the transfer sends the filters and the
server runs `customerFilterClause`, the SAME clause the list ran to draw the
screen the person is looking at. Re-deriving "which customers" on the way in
would be a second reading of it, and a bulk action that moves a set nobody
reviewed is the worst thing on the screen. The count that was on the screen is
sent with it and refused if it no longer matches: between reviewing a number
and spending it, an import can land, and a transfer that would touch a
different set has to stop rather than quietly grow.

**And the review changes shape with the scope.** A tick-list is read line by
line and the from-column is what catches a selection that caught too much. A
hundred and forty-seven checkboxes is a review in name only — it looks like
diligence and is scrolled past — so a filtered transfer is reviewed as the
count, the destination, and the filters said back in words. No filters at all
is the whole book, and the screen says exactly that in red: it is a legitimate
thing to do and a terrifying thing to do by accident.

**The three seats are drawn at ONE font size.** The second line of that column
was `text-xs` under a `text-sm` first line, which made the back office manager
read as a footnote to the salesperson rather than as the other half of the same
answer. They are peers — one sells to the account, one raises its paperwork,
one says who the first answers to — and a hierarchy of type sizes down a column
claims a hierarchy of importance that does not exist. What separates the lines
is colour on the LABEL: muted label, plain name, so the eye picks out the three
names without reading a word of the labels.

**An account has TWO managers and they move independently.** Sales is whose
book it is; back office is dispatch, billing and paperwork. Either or both can
be changed in one action, and each writes its own history row, because a
salesperson resigning says nothing about who raises the invoices. In the
dialog, a manager left untouched is OMITTED from the request rather than sent
as its current value — sending it would stamp a decision mark on an account
nobody decided anything about.

**AND THE BACK OFFICE SEAT IS "LOGISTICS", which is why no such role exists.**
The MBOS brief assigns six items to a Logistics actor and MahekOne's role list
is telecaller, manager, accounts, admin — so those items sat unbuilt, blocked
on a seat that appeared to be missing. It was not missing: dispatch is the
first word in the sentence above, and the people who put things on lorries and
chase them are the back office team. Reading the brief's job title as a role to
be created is what kept it blocked. A fifth `users.role` would have been a new
way to see the whole company's book — scope reads the derived widest role — to
model something that has existed since the second manager column shipped.

**Where nobody holds it, the task still lands, and it SAYS why.** An account
with no back office person still has to produce a chase: a sample that never
arrives is the quietest way a lead dies, because the salesman assumes it is
being tried and the shop assumes we forgot. So it falls through to the Lead
Manager and the description says it came there because no back office person is
named. That distinction is the whole of it — quietly moving a job the brief
puts elsewhere looks like completion, and naming why it moved does not. It also
turns the gap into something somebody can fix, which a silent fallback never
does. `back_office_am_id` and never `back_office_name`: a task needs somebody
who can sign in and close it, and the name column is for a person who may have
no login at all.

**A chase is CLOSED by the answer, not deleted by it.** Confirmed receipt marks
the task done and keeps its `sourceId`, because "we asked where this parcel was
and then it arrived" is the only way anybody finds out a courier is the
problem. Deleting it leaves a lead that converted late and nothing saying why.
It is closed before the review task is raised, so the two never sit on one list
saying opposite things about one sample.

**A reassignment is a decision, so the sheet keeps its hands off it.**
`customers.amDecidedAt` is the third mark of its kind, after
`orders.approvedAt` and `bills.paymentDecidedAt`, and it guards TWO things
rather than one. `--reassign` no longer overwrites the ids on a decided
account — but the half that would have been missed is
`recomputeSalesPeople()`, which rewrites `salesPersonName` from the sheet every
night. Holding the id while letting the NAME revert is the worst outcome
available: the account moves for scope, the queue and collections, and every
screen goes on showing the old person, because the lists read the sheet's name
first. Nobody reports that as a bug — they report that reassignment does not
work. So the mirrors move with the ids, and a decided account is skipped by
both paths.

**A reassignment must survive the next sync, and there were three ways it did
not.** `recomputeSalesPeople` honoured `amDecidedAt` and the party PROJECTION
did not — so a reassignment wrote its history, notified both people, and was
undone half an hour later by the scheduled pass. In production somebody made
the same change four times in four minutes before giving up, and the account
they were trying to move sat in the wrong person's Call Log for a day. The
projection now skips all four manager columns on a decided account and records
the disagreement in `sync_conflicts`, which is what the order projection
already did for `orders.status`. Everything that is NOT a manager — the phone
number, the credit term, the area — still comes from the sheet, because the
sheet is simply right about those.

**`updateCustomer` is not a door to it either.** It wrote `owner_id` for
anybody who could edit a customer and `back_office_am_id` for any manager, both
without the `customer.reassign` capability that is deliberately accounts' and
admin's, without a reason, without history, without notifying anybody, and —
worst — without `amDecidedAt`, so the sheet restated the old answer on the next
pass. The screen had already stopped sending those fields; the action refuses
them now, because a server action is a URL and the unaudited door always wins
in the end.

**And an emptied seat means nobody, not the importer.** The fallback from
`sales_am_id` to `owner_id` is for a field NOBODY HAS SET — it stops a record
mid-migration being orphaned out of every list. It is not for one somebody has
deliberately emptied: `owner_id` is whoever ran the import, one person on more
than a thousand rows, so "this account's salesperson has left" handed the
account to them, on a customer they had never sold to, with the departed
salesperson's name still on the screen because that is a different column.
After `am_decided_at` the sales seat is read exactly as it stands.

**AN ACCOUNT HAS A FIFTH SEAT, and it is the answer to §Q.** The brief asks
for the account to become a customer on the second order and for the
relationship to pass to a customer manager in the same breath. That is a
sentence about what the account IS and a sentence about who RUNS it, joined by
an "and" that hides the fact they are independent. `kind` answers the first and
flips on the FIRST order — `lead-conversion-service.ts` has the whole argument,
and it is settled. `relationship_owner_id` answers the second, and nothing
derives one from the other.

**It moves SIGHT, and deliberately not a rupee.** It is read by `scopedToUsers`
and by `assertCustomerInScope`, because a seat that did not carry sight would
announce to somebody that an account is theirs and then refuse them the screen —
a failure this file already carries three paragraphs about, having shipped
twice. It is NOT read by `ASSIGNED_TO_SQL`, and that is the load-bearing half:
that expression decides who is credited for an account's orders and whose
target it counts toward, so reading this there would move revenue between
people as a side effect of naming a relationship manager. Moving money is
`customer.reassign`, accounts' and admin's for exactly that reason.
`customer.handOver` is a manager's, and it can be *because* it moves none —
the same test the sales manager seat passes, one seat along. There is an
integration test asserting a handover leaves `sales_am_id`, `owner_id`, `kind`
and `am_decided_at` untouched, because that is the thing nobody would notice.

**Whether a handover is OUTSTANDING is derived, never stored.** Converted, and
`handed_over_at` still null. A flag would be a cache with nothing rebuilding it,
and the only facts it could be rebuilt from are the two columns it would be
caching. It is the same shape as the third-party filter listing shops with no
distributor: a list that should be empty and is not, because a row nobody can
account for is worse than one that says why it is there.

**And the seat's LABEL comes from a map, not a chain.** `seat-labels.ts`, pure
and client-safe like `complaint-labels` beside it. The record page rendered the
three seats with a ternary whose last arm was "Back office", so adding a fourth
relabelled it rather than failing — a handover reading on a customer's history
as a back office change, silently, on the screen somebody opens to find out
what happened to an account. `handover.test.ts` reads `amRoleEnum.enumValues`
and asserts every one has a label, so a fifth seat fails at the schema rather
than on the page.

**A lead moves by `owner_id` and a customer by `sales_am_id`.** That is what
`ASSIGNED_TO_SQL` reads, so writing only `sales_am_id` leaves every lead
exactly where it was while the screen reports it moved.

**Why it moved is a column, not a sentence in a log.** `customer_am_changes`
stores a reason code from `people.amChangeReasons` beside the from and the to,
and the reason list is configuration because a manager should be able to add
one without a deploy. The question people actually ask is "what moved when
Suresh left, and why" — `audit_log` can only answer that by grep. Names are
stored ON the row as well as the ids, so a history stays readable after the
person leaves and their account goes.

**Both sides are told, and the new manager especially.** Work has moved onto
their queue without them asking; the first they would otherwise know is a list
that grew overnight. The person who lost the accounts is told for the same
reason in reverse — a book that shrinks silently reads as a bug in the queue.
One notification per person per action, never one per account, and a
reassignment that changes nothing notifies nobody.

**Accounts have their own customer list, and it is not decoration.** An
accounts user holds `apps: ["accounts"]` and `src/app/crm/layout.tsx` redirects
them out of the CRM, so offering this action only on the CRM's list would have
shipped a permission that nobody holding it could reach. `/accounts/customers`
runs `listCustomersPage()` — the SAME query the CRM list runs, because two
reads of "who are our customers" is how two screens disagree about one. The
presentation is its own: the CRM list offers reminders and WhatsApp and links
every row into `/crm/customers/[id]`, all of which are doors this app's users
are redirected away from.

**One person picker, not two.** A dropdown beats a search box while the list is
short and loses the moment it is not, but building both means two components
and two sets of bugs, and the day the eleventh salesperson is hired somebody
has to notice and swap them. It is always the same searchable list;
`people.pickerSearchThreshold` decides only whether the search field takes
focus.

**What it does NOT do is decide whose book a customer is in.** That stays
`salesAmId`, because scope has to resolve to somebody who can sign in and see
the work. The two answer different questions and a name with no account cannot
be given a queue.

**Whose book is one definition, and it is `ASSIGNED_TO_SQL`.** A lead answers
to its owner; a customer answers to its sales account manager, falling back to
the owner. Every scoped list reads it — the queue, collections, bills,
complaints, targets, the inactive watch, WhatsApp replies and global search.
Reading `owner_id` alone silently drops every customer whose sales AM has been
set, including off the collections list while they still owe money.

**The sheet wins every column except a decision somebody made.** The team
works in the spreadsheet and the CRM projects what they type, so for almost
everything the sheet is simply right and should overwrite. `orders.status` is
the exception: accounts approve and decline in the app, and the projection
used to reset that to `dispatched` on every pass. The approval columns are not
part of that overwrite, so the row was left reading "declined by Deepa, over
credit limit" beside a status of `dispatched` — and approved status drives EOD
value, targets, the buying cycle, the product history and outstanding, so the
reset moved figures on five screens with nobody's name against it. `approvedAt`
is the mark of a decision, written by decline as well as approve and never by
the projection, so the upsert keeps the app's status wherever it is set.

**A kept decision is written down, not just kept.** Silence would trade one
invisible loss for another: the sheet still says something different and
somebody has to reconcile the two. `sync_conflicts` records what the sheet
wanted, what the app holds and who decided, with a partial unique index on the
unresolved ones — an uncorrected sheet is re-read every thirty minutes, and a
list that grows by forty-eight rows a day is one nobody reads.

**One sync per source at a time.** Nothing checked this, which was fine on a
laptop and is not on a schedule: a run that hangs on a slow Google response is
still `running` when the next fires, and two passes race through the same
upserts. A `running` row older than ten minutes is treated as dead rather than
blocking forever, because the route is capped at five — waiting on a killed
process would let one timeout stop every future sync. Refusing returns **409
and not 500**: two overlapping calls are the ordinary result of a slow run and
a fixed interval, and a scheduler must not page somebody about a sync that was
working perfectly.

**The schedule lives outside the deployment, because Vercel Cron is paid.**
Two cycles: every thirty minutes for the read modes and the projection, and
one a day for `reconcile` — the only pass that sees an edit to an old row or a
deletion — followed by `nightly`, which is the only thing that rebuilds the
derived caches. Steps run in sequence on purpose: no single call may exceed
the route's five-minute ceiling, but a caller may take twenty minutes, so the
cycle is chunked into calls rather than made into one long one, and the order
matters — the read modes land rows in the staging tables and `project`
publishes what has landed, so projecting first ships the previous cycle's data
as though it were fresh. Reading is cheap when nothing changed, since every
row carries a content hash — an untouched tab costs a read and no writes,
which is what makes the cadence affordable.

**A `schedule:` in GitHub Actions is a hope, not a cadence.** It is
best-effort, and on a private repo belonging to a free account it is the
lowest priority tier there is: a tick that cannot be served is DROPPED, never
queued, so the interval you wrote is an upper bound on frequency and nothing
more. `*/30` delivered three runs in eleven hours here — gaps of 2h01, 4h48
and 4h07, about one tick in ten — with every run green and finishing in two
minutes, which is what makes it so hard to notice: nothing fails, the log
looks healthy, and the CRM is just quietly hours stale. The half-hourly cycle
is an Apps Script time-driven trigger on the workbook instead
(`scripts/sheet-sync-trigger.gs`), which is not best-effort and lives beside
the sheet it reads. Cron minutes are `:07`/`:37` and `:13` rather than `:00`,
because the top of the hour is exactly when ticks get dropped.

**The nightly stays in Actions, because `curl` waits and `UrlFetchApp` does
not.** The daily pass is the one place ORDER is load-bearing across a
five-minute boundary — `nightly` rebuilds the caches from what `reconcile`
landed, so starting it early rebuilds them from half a compare.
`--max-time 310` blocks until the server answers; Apps Script gives up at
about sixty seconds with no way to raise it, and a full compare takes longer
than that, so the script would start the second step over an unfinished first
and have no way to know it had. One tick a day also has far better odds of
being delivered than forty-eight. Where a fetch DOES time out in the
half-hourly script it is logged and the cycle carries on: the request reached
the deployment and the job runs to completion server-side, so only the answer
is lost, and the next tick's 409 guard stops a second pass climbing on top.

**A backfill becomes a cadence the day the source stops being defunct.** The
field salesman activity history — the Activity tab of "Mahek EMP 2.0", a
prior system — shipped as a one-time CSV import because the live sheet was
not reachable from the app's service account at the time. Once
`mahekone@mahekone.iam.gserviceaccount.com` was confirmed to hold Viewer on
it, the same staging/hash/reconcile code the CSV backfill used became a live
sync, on the order sheet's OWN append/reconcile split rather than one full
compare per tick — the tab is tens of thousands of rows, so `?mode=
field-activity` (watermark-only) runs every few minutes and `?mode=
field-activity-reconcile` (full hash-compare, catches an edited or withdrawn
row) runs once a day. It is a SEPARATE spreadsheet from the order workbook,
so it cannot share `sheet-sync-trigger.gs` — an Apps Script trigger belongs
to the document it is bound to — and has its own,
`scripts/field-activity-sync-trigger.gs`, installed the same way in that
workbook. `?mode=field-activity-project` writes matched rows onto
`timeline_events`, which is how this reaches a customer's shared history and
a salesman's phone.

**A flag that is silently discarded is worse than one that is rejected.**
`npm run jobs -- project-sheet --bills` used to run the projection with no
options whatsoever: the argument was read into argv, dropped before `runJob`,
and the run then reported "bills skipped" — which reads as a fact about the
data rather than an option that never arrived. Sales Bills was empty and the
command said so in words that sounded like an explanation. Parsing lives in
`lib/job-args.ts` so it has tests; an unknown option, a `--owner` with nothing
after it, and a switch given a value are all refused rather than guessed at.

**The import has to be runnable from the screen.** On a deploy nobody has
shell access to, a terminal is not a fallback — it is the only door and it is
locked. The sheet jobs were reachable from a CLI and from a cron endpoint
guarded by a secret, which on this deployment meant neither, so the import ran
on somebody's laptop against the production database or it did not run at all,
and Sales Bills stayed empty through three releases that each claimed to fix
it. Admin Console → Order sheet → Sync runs both steps, and `triggerJob` takes
the owner because the sheet cannot supply one. A merge has to be enough.

**A bill number is unique across the TABLE, so uniqueness cannot be worked
out from one run.** `bills_no_key` is a unique index over every row, and the
import used to decide numbering by counting Tally numbers within its own batch
— blind to a bill somebody typed in, one the Payment Status path wrote, or one
a half-finished run left behind. The insert threw, and it threw after thousands
of rows had already landed. Existing numbers are read first and a contested one
falls back to `<tally>/<order number>`, then `ORD-<order number>`; an order
that still cannot get a unique number is counted and skipped, never renamed
into something nobody can reconcile and never thrown, because one unusable
number must not cost the other ten thousand rows.

**A sales bill IS the order.** Bills are projected from the Order Details tab,
one per order, valued as the SUM of its lines — Final Amount is line-level and
half these orders are multi-line. The number is the Tally number, gaining the
order number where that repeats. `--bills` swaps the source to the Payment
Status tab — never both, since they key on the same `SHEETPAY-<order number>`
and would give one bill two authors.

**The sheet never writes money. Not in any column, not by any path.** No
receipt, no `paid_amount`, no `status`, no `outstanding`. Whether money arrived
is the app's to record and nobody else's, and a sync that touches a payment
figure is a bug however reasonable its reading of the tab was.

It was not always so, and the reasoning that got it wrong was good. The Order
Details tab records what was billed and never what was received, so the only
two readings were assume-everything-owed — which invents the whole order book,
nine crore of it, as debt and puts every customer on the collections list — or
assume-everything-settled, which understates rather than fabricates and was
called the safer of two lies. It was still a lie, and it was the one that hides
money: every customer's every bill read as paid on a spreadsheet's authority
with no person behind any of it.

**So there is a third position, and it is stated rather than guessed.**
`bills.paymentPosition` is `stated` or `unstated`, and `unstated` counts as
NEITHER paid nor owed. The bill exists and shows on the customer record; it is
held out of outstanding, the aging strip, the collections worklist, the
slow-payer flag and the WhatsApp reminders until somebody speaks. Nothing
chases a debt nobody has vouched for, and nothing is written off either. The
column defaults to `stated`, deliberately: every row that existed when it
arrived kept exactly the behaviour it had, so adding it moved no figure on any
screen. Only the projection writes `unstated`, and only on INSERT — a bill
somebody has since spoken for must not be returned to silence because a
scheduled pass re-read the row it came from.

**What states a bill is a person.** Recording or confirming a receipt against
it — every route to confirmed money passes through `applyToLedger`, which is
where the mark is set, because a decision recorded in three places is a
decision missed in one — or Tally's receivables report naming it through
`leaveOwing`. `payment_decided_at` says WHEN and is set once; `paymentPosition`
says THAT, and is set unconditionally, because a bill can carry a decided
timestamp from before the column existed while still reading `unstated`.
`source <> 'sheet_import'` is what keeps the two apart: a receipt the
spreadsheet wrote is not somebody deciding.

**A screen showing a balance has to say which kind of number it is.** On an
`unstated` bill the balance is the full amount purely because nothing has been
recorded against it, so the bill screen says "no payment recorded either way"
rather than "₹0 received" and explains why. Rendering it beside real balances
presents an unknown as a debt, which is the original mistake wearing different
clothes.

**The Payment Status tab is evidence, not an author.** It has the best claim of
anything in the workbook — real received/not-received on 8,277 rows — and it
still does not write money. A receipt is the assertion that funds reached the
bank; a spreadsheet cell cannot make that assertion, because no person is
behind it and there is nobody to ask when it turns out to be wrong. What it
says is COUNTED and reported — `paidWithoutDate`, `blankStatus` — so accounts
can go and confirm it. A BLANK status is no longer read as settled, nor as
unpaid as it was before that; it is read as what it is, the same `unstated`
every other row gets.

**What the old assumption did is still in the database, and the revert is kept
for it.** Production carries thousands of `source = 'sheet_import'` receipts
and they are why the book reads as paid; they were deliberately left in place
when the writing stopped, so that no figure moved on the day of the change.
`revertSheetSettledBills` deletes only those whose order the Payment Status tab
affirmatively calls unpaid — silence is not evidence in either direction — and
`unpaidPerPaymentTab()` is the single definition both it and the old importer
shared, because two copies of that rule would clean up a different set to the
one the importer stopped writing, and the difference is money. The projection
can no longer produce that damage, so the tests build it by hand.

**The projection no longer rebuilds paid amounts.** `recomputeAllBillPaid` and
`recomputeBillStatuses` derive from confirmed receipts, and the sheet writes
none, so there is nothing new for them to read and running them would make a
pass that touches no money look like one that rewrites the ledger every thirty
minutes. Outstanding IS still rebuilt, because a corrected bill AMOUNT changes
what a stated bill is worth, and the follow-up stage and slow-payer flag follow
it in that order.

**The mark goes on before the receipt comes off.** `leaveOwing` writes
`paymentDecidedAt` first and unconditionally — including for a bill it finds no
assumed receipt to cut. The report naming a bill IS the decision, and a bill it
names must not be settled by assumption later just because there was nothing to
delete at the time. Marking it after the delete would leave a window, and the
window is exactly where the cron lives.

**A part payment is locked too.** Where some money did arrive `leaveOwing`
REDUCES the assumed receipt rather than deleting it, so the key stays taken and
the old bug could not bite — but the lock applies anyway, because "the customer
paid ₹1,000 of ₹2,360" is as much a decision as "they paid nothing", and a
later pass must not decide the remainder arrived too. There is a test for each
of the three: fully owed, part owed, and five consecutive syncs.

**The fix went in the projection, not in the two callers that spell the URL
out.** Adding `bills=1` to the workflow and the Apps Script would have worked
until the third caller, and a rule about money that lives in a query string is
one deployment away from being forgotten. The staging tables are what make the
damage reversible at all: `sheet_payment_rows` holds the tab's own verdict,
the projection reads it and never writes to it, so the receipts that SHOULD
exist stay derivable however badly the published side is mangled. `npm run
jobs -- revert-sheet-paid --dry-run` reports the count, the money and the
customers affected; without the flag it deletes and rebuilds the caches. It
touches `source = 'sheet_import'` receipts only — a telecaller's reported
payment and an accounts confirmation are somebody's word, and no cleanup of an
import's mistake may reach them.

**A recompute that filters is a recompute that freezes.**
`recomputeAllFollowUpStates` is the only thing that REMOVES a follow-up row
when the debt behind it goes, so restricting it to active customers did not
skip work — it stranded eight customers at stage 3 claiming crores overdue
while owing nothing, beyond the reach of any later run. It visits every
customer; nothing is created for one who owes nothing.

**The ledger is cut by financial year, not paged from the top.** Ten thousand
bills across three years is not a list anybody scrolls, and Mahek's own bill
numbers already carry the year — MMI/26-27/1119. The current year is the
default, the server filters to it, and the table pages within it. Paging is
over what is filtered IN, so the totals row, the aging strip and the export all
describe the whole year while only the table is cut into pages — a page that
changed the totals under it would show a different figure on every click.

**"Who owes us" is a different question to "what did we bill", and it has its
own screen.** The ledger is a list of bills; Outstanding is a list of CUSTOMERS,
one row each, with what they owe and the bills behind it opening on the same
row. Both questions are always asked together — how much, then against what —
and answering the second on another screen is what makes somebody give up half
way through a chase. It is deliberately NOT cut by financial year: the oldest
debt on an account is usually last year's, and that is the first row anybody
works. `lib/engines/outstanding.ts` is the grouping, pure like every other
engine, and `listOutstandingByCustomer` reads `listBills` rather than a query of
its own — a screen totalling outstanding from a different read than the ledger
is how two screens come to disagree about one customer.

**It is one screen rendered in two apps, not two screens.** Accounts and the
CRM read the same function through the same scope, so the two can never quote a
customer two different balances; what differs is what surrounds the table —
Accounts links into the customer account, the CRM links into the customer
record and the WhatsApp reminder, which is where a chase actually happens.

**And a bill nobody has spoken for is shown, counted and never added up.** An
`unstated` bill is not debt, so it stays out of the outstanding figure exactly
as `recomputeOutstanding` keeps it out — but it is listed, given its own
column, its own metric and a sentence saying what it is. Hiding it would make a
bill that is open on the ledger and absent here read as a screen that lost it;
adding it would put the whole imported order book on a collections list. Its
balance is drawn as "not stated" rather than as a figure, because rendering an
unknown beside real balances is the original mistake in different clothes.

**In raw SQL, qualify every column of the outer table.** Drizzle renders
`${customers.id}` as a bare `"id"`. Inside a correlated subquery that binds to
the *inner* table and the condition silently becomes false — types and unit
tests both pass. Write `customers.id` in the string instead. This one shipped
once; the integration tests exist partly to catch it.

**The Admin Console answers from the database, or it does not answer.**
Every platform screen — Overview, Apps, Data, Notifications, Audit — used to
render fixtures: a failing integration that did not exist, a nightly backup
nobody runs, "14 customers unassigned" that was a literal `14`, and a header
naming two invented people, Sandeep Rao and Vikram Shah, instead of whoever
was signed in. A console is where somebody goes to find out whether the
platform is all right, so one that answers from a file is worse than one that
does not answer: it is believed. `lib/services/admin-platform-service.ts` is
the one place those questions are asked.

**Where nothing can answer, the screen is GONE rather than filled in.** Access
requests, lockout counters, failed-attempt logs, grant expiry, unused-access
reports, feature flags, contract validation, export logs, backup status,
scheduled configuration changes and per-app roles were all deleted, because
MahekOne records none of them. Anything kept says plainly what it cannot show
— a session row has no device or IP because neither is stored.

**A screen that offers an action must do it.** "Trigger password reset" wrote
a line to an in-memory list and toasted as though mail had gone; "Create user"
created nobody. Those are real actions now (`sendPasswordResetFor`,
`endSessionsFor`, `createUser`), and the one save path with nowhere to write
says so instead of claiming success.

**An app id may not collide with a platform section key.** `people` and `apps`
are both, and a bare section address let the app win — `/admin/people` opened
"Attendance & People, registered but not built" instead of the roster. App
sections are addressed `app-<id>`; a bare id still resolves for anything that
is not a platform key, so `/admin/crm` keeps working.

**`users.lastLoginAt` is written on sign-in.** Nothing wrote it, so every
screen asking when somebody last signed in answered "never" — which made the
console's list of never-used accounts accuse the entire company. Attendance is
the fallback for accounts that signed in before the column was filled: a day
recorded is a sign-in, whatever the column says.

**The design system is a console section, not a CRM screen.** It sat at
`/crm/components` with a link from the telecaller Help centre, which put a
build-facing handoff artifact one click from somebody working a calling queue.
Every component in every state is exactly what whoever writes the screens
needs, and exactly nothing to whoever uses them. It is `admin/components` now,
under the platform nav, where the rest of the build-facing material already
lives.

**Feedback is a conversation, not a note.** The Tell us button sits in the
header of every app, and what it writes lands in `feedback` — kind, heading,
detail, and the screen the person was standing on, captured rather than asked
for. Anybody signed in may write one, because a form the telecallers cannot
reach only ever hears from managers. Answering one is a manager's or a platform
admin's, checked in the action rather than by hiding the control, and it is
the same shape as everything else here: reads in
`lib/services/feedback-service.ts`, writes in `lib/actions/feedback.ts`.

**Every line of it is a row in `feedback_messages`, from either side.**
`feedback.admin_note` was a single overwritable cell: a second answer erased
the first, and the person who reported the fault could not say "not quite" —
which, for a bug report, is usually the sentence that solves it. Both sides
write through one action, `replyToFeedback`, because the two directions are
the same act and splitting them would give one conversation two sets of rules
about length, files and who gets told. `0032` carried every existing note in
as the message it always was, and refuses to run rather than lose one whose
author was never recorded.

**A status change is a line of the conversation too.** `statusTo` on a message
carries it, so "Not doing" sits in the thread beside the reply that explains
it rather than in a column somebody has to go and look at. A row that says
neither — no body, no status — is refused by a check constraint, because an
empty message notifies somebody about nothing.

**Both ends read the SAME thread.** One component, `components/feedback/
feedback-thread.tsx`, renders it in the Admin Console and on `/feedback`,
where the reporter reads the answer; what differs is only which side is "you".
A submitter shown a shorter version of the conversation they are in is how
somebody concludes nobody answered them, and stops reporting.

**Both ends are told.** A new report notifies whoever can triage it — managers
AND whoever holds the Admin app, exactly the set `canTriageFeedback` lets in,
because notifying fewer people than may answer is how a report sits unread in
front of the one person who could have fixed it. Every reply and every status
change notifies the other side, and the submitter's notification carries an
href to `/feedback`: a bell saying somebody answered, with nowhere to go and
read the answer, is what this was before. Nothing is ever deleted.

**A screenshot is part of the report, and it must be openable.** The Tell us
form and every reply take images, bound to `feedback` and `feedback_message`
respectively. Feedback is the one attachment parent with no customer behind
it, so `canRead` cannot fall through to a customer's scope — the two sides of
the thread may open the file and nobody else, asked once in
`lib/services/feedback-access.ts`. That file exists to keep attachments from
importing the feedback service while the feedback service imports attachments.

**Who may see and answer a thread is defined once.** `canSeeFeedback` and
`canTriageFeedback` live in `feedback-access.ts` and are read by the action,
the console's read-only banner and the attachment endpoint. Three copies of a
permission rule is how one of them ends up more generous than the others.

**Its vocabulary is client-safe, and separate from the service.**
`lib/feedback-labels.ts` holds the kinds, the statuses and their sentences,
because the form that writes them runs in the browser and the service that
reads them is `server-only`. `bug_reports` is the empty table this replaced —
nothing writes to it; do not start.

**A SHOP MASTER IS NOT AN ORDER HISTORY, so the kind is read off evidence.**
The EMP 2.0 workbook's `Customer Details` tab is 5,292 shops and the only
place a phone number for any of them exists — the Activity tab has twelve
columns and not one is a contact detail, and the GPS pin export beside it
carries `CustomerPhone1..3` with exactly one of 6,525 filled. What it does NOT
carry is a single order, so `kind` cannot be read off it. It is decided from
evidence of a purchase in the Activity log: a Payment Collection visit (you do
not collect money from a prospect), the old app's own Stage 0/4/5 labels, or a
High/Medium/Low Value rating. None of those is a LEAD, which is what a lead
already means — an account that has never ordered. Every verdict is stored on
the staging row WITH its reasons, because "why is this one a customer" is asked
months later about one row, and re-running the rule then answers a question
about today.

**It writes neither `third_party` nor `active_in_order_system`, and that is the
whole point of both rules.** The first is a person's judgement plus a named
distributor and the schema says no import may set it; the second was cleared
once already by `0021` after an import muted the entire book. The evidence for
a third-party mark is kept in staging for whoever decides. `owner_id` is left
null too: on five thousand rows it would be whoever ran the import, and every
scoped list would read as their book — unassigned is said in words on a team
list, a false owner is not said at all.

**`Deactive` is the one status an import may write, because it is a decision.**
`customers.status` is derived by `recomputeInactivity`, and the single value
that engine never touches is `deactivated` — deactivation is a human decision.
The sheet's `Deactive` is exactly that decision, made in the old app, so it
maps straight through while everything else is left at `active` for the engine
to move.

**And it does not write `sales_person_name`, though the sheet names one.**
`recomputeSalesPeople` rewrites that column nightly from the PARTY sheet for
every customer without `am_decided_at`, INCLUDING back to null where the party
sheet is silent — which it is for all 5,292 of these. Writing the name would
last until the next nightly. Setting `am_decided_at` to protect it would be a
lie, since no person decided anything, and would freeze both manager seats
against a future sync as a side effect. The name stays on the staging row.

**A number that is on 919 shops is a placeholder, and it is found by counting
rather than by a literal.** The export carries one syntactically perfect Indian
mobile on 952 rows; every validity check passes it. `flagSharedMobiles` marks
any number on three or more shops — two is an ordinary proprietor with two
counters — because the next export will use a different placeholder and a
number written into the code would silently stop catching it.

**The employee master is a mirror, and mirrors do not get edited.** HRMS reads
the workbook's `Employee Details` tab and nothing on its screens can be
changed, because HR maintains that sheet and a field edited here would be
overwritten by the next sync without telling anybody. The sync is
hash-driven, so a tab that has not changed costs a read and zero writes —
which is what makes it affordable every minute rather than every night. One
mode, `reconcile`, not the order sheet's three: seventy rows is a single API
call, and only a full compare notices a salary corrected, a leaver marked
Inactive, or a row deleted.

**What keeps it current is the open screen, and only that.** It asks every
minute, so somebody who adds a row and switches tabs sees it. There is no
schedule behind it: Vercel Cron is a paid feature and this account is on the
free plan, so a sheet edited on Friday afternoon stays unread until somebody
opens HRMS on Monday. `/api/hrms/sync` still exists for an external scheduler
or a person to call, guarded by `CRON_SECRET`. Both paths land in the same
action, which refuses to run twice inside twenty seconds — ten open tabs must
not be ten reads of one sheet a minute.

**The employee sheet's password column never reaches the database.** It holds
plaintext credentials to a different system, MahekOne has no use for it, and
the raw snapshot is stored with it redacted. The hash is still taken over the
sheet's own cells, so a changed password still reads as a changed row.

**A bank account and an Aadhaar number are stored as four digits.** Enough to
recognise the account against a passbook, useless to whoever photographs the
screen. The full values stay in the row's `raw` snapshot, which no list query
and no screen selects — a leak of this kind is never a breach, it is an
ordinary query that selected everything.

**A date that can be read two ways says so rather than being guessed at.**
The tab mixes `1-Nov-2024`, Google's month-first rendering of real dates, and
day-first text somebody typed, so `hr-parse.ts` resolves what it can from the
value itself and falls back on a convention only when it must — and records a
note when it does. Those notes are kept apart from real problems: two thirds
of the rows carry one, and counting them as faults would put everybody under
"needs attention", which is the same as putting nobody there.

**The employee workbook's id is hardcoded, and the credential is not.** A
spreadsheet id names a document; it does not open one — the service account
does, and that stays in the environment. Keeping the id in
`employee-sync-service.ts` means one less variable to set correctly on every
deploy, and no HRMS reporting "not configured" because one was missed.
`HR_SHEET_ID` still overrides it, which is how a staging deploy points at a
copy.

**An employee who leaves the sheet is marked, never deleted.** Payroll history
outlives a spreadsheet edit, and somebody tidying a leaver off a tab is not
asking for their record to be erased.

**A new app id cannot be granted in the migration that adds it.** Postgres
refuses to USE a value added to an enum until that transaction commits, and
drizzle-kit applies every pending migration in ONE transaction — so a grant in
the next migration file fails on any database that has not already been
through the first. `npm run app:grant` is the way in, which suits HRMS anyway:
salaries and home addresses are granted deliberately.

**Renaming an app's slug is a RENAME, never an add-and-migrate.** `orders`
became `accounts` when the app outgrew the name it was given for its first
screen. Adding the new enum value, updating `app_access` and dropping the old
one cannot be done at all — a value added to an enum may not be USED in the
transaction that adds it, and drizzle-kit runs every pending migration in one
— and doing it across two deploys revokes the app from everybody who has it in
between. `ALTER TYPE app_id RENAME VALUE` changes it in place: every existing
grant keeps pointing at the same app without being touched. The old URLs are
kept alive by a permanent redirect in `next.config.ts`, because a slug lives in
bookmarks, in emails and in screenshots long after it has changed in the code.

**A plan is agreed, not issued, and BOTH halves of that are writes.** The
office proposes a city and the salesman answers — `proposed → refused → agreed
→ planned` — and it is the salesman who picks the shops, because he is the one
who knows which doors are worth a Tuesday morning. He could agree to a day and
then had no way to fill it, so the office arranged the stops; that is still
available to them, as the exception it should be rather than the only path.
`plan_stops` carries the WHOLE list rather than a difference: sending a shorter
one is how a shop is unpicked, and a merge would make unpicking impossible.
Picking nothing leaves the day `agreed`, because an empty day claiming to be a
route is the state the model exists to prevent. A shop that has left his book
since he picked it is dropped, counted and NOTIFIED — refusing the whole day
over one stale id loses the nineteen he got right, and dropping it silently is
how somebody walks a day missing a stop they chose.

**THE HANDSET IS RELEASED BY A WORKFLOW, and never from somebody's laptop.**
`.github/workflows/mbos-apk.yml` builds it, verifies the signature against the
committed keystore with `apksigner`, and publishes to R2 under a versioned name
and to the droplet as the one stable `/downloads/mbos.apk`. It is
`workflow_dispatch` — `gh workflow run "MBOS APK" --ref main -f
api_base=https://one.mahekindia.com -f publish=true` — because sideloading has
no staged rollout and no rollback, so a release is a decision somebody makes.
`api_base` is baked into the bundle and cannot be changed afterwards.

A release built by hand and copied up skips the signature check, the versioned
archive and any record of what shipped, and puts the app back on whichever
machine happens to have a JDK. That has happened, on 2026-09-08, because the
release path was written down nowhere anybody looks — which is why it is
written here. Local `gradlew assembleRelease` is for trying a change on your own
phone and nothing else. See DEPLOY.md, "Releasing the handset app".

**A pull says what exists; only a tombstone says what stopped.** A deleted row
has no `updated_at` for a delta to notice, so without `mbos_deletions` a
withdrawn document, a removed stop and a reassigned customer sit on the handset
for ever — and the salesman walks to a shop that is not his any more with
nothing anywhere looking wrong. It is reference data only: nothing he authored
is ever deleted by a sync, not a rejected order and not a visit that lost a
conflict. `user_id` null means everybody, which is what a withdrawn product is.

**The price list is replaced wholesale, and everything else is upserted.** A
rate that was withdrawn has to disappear, and a per-row upsert leaves it behind
— an order priced from a rate nobody sells at. It is a few hundred rows of three
columns; a delta would save nothing worth the way it fails.

**THE HANDSET'S SCHEMA IS THE WIRE CONTRACT, and one extra column empties the
phone.** `applyPull` upserts a pulled row by writing exactly the columns that
arrived — `INSERT INTO customers (<every key in the payload>)` — so a field the
server knows about and the handset has no place for throws on an unknown
column. It is ONE transaction, so that throw rolls back the whole pull: not the
customers, the pull. Products, the price list, the timeline, the journey, the
configuration, all of it. Seven of the ten pulled tables disagreed —
`customersForDevice` alone sent eleven columns that had nowhere to land — so no
MBOS handset had ever received a single row of reference data, on any build,
since the app shipped. What made it invisible is that everything a salesman
AUTHORS goes up perfectly: check-ins, visits, orders, the trail and the Live
map all worked, and only the book was empty.

**And the second half of the silence was in the sign-in.** `signIn` applies the
bootstrap inside the same `try` that wraps the network call, so the SQLite
error fell to a catch that reads "not an `ApiError`, therefore no answer at
all" and went down the OFFLINE path — which succeeds, because
`rememberForOffline` ran three lines earlier. The salesman was signed in
against an empty database with nothing on the screen to say so. A local
storage failure is now its own answer: `payload`, the fifth of the five checks
that screen already names.

**So the payload is trimmed to the handset, never the handset widened to the
payload.** An APK cannot be recalled — the server has to be able to move first,
and a phone in somebody's pocket cannot. `upsert` drops a column this build
does not know about rather than refusing the row, which is the same trade in
the other direction: a field the screens cannot read costs nothing, and
refusing it costs the book. `src/lib/mbos-wire.test.ts` reads both files as
text and pins it, because nothing else can — the server's SQL is a string, the
handset's schema is a string in a project `tsconfig.json` excludes, and the two
are joined only inside a phone. It type-checks, it lints, the integration tests
pass, and it is wrong.

**A FUNCTION WITH NO CALLER IS A FEATURE NOBODY CAN USE, and nothing was
checking for one.** An exported function that nothing imports is legal
TypeScript and clean lint — it is exported, so no unused-symbol rule fires, and
`tsc` has no opinion about who imports it. So a feature can be finished in
`data/`, given a server handler, given a wire payload, pass every test in the
suite, and simply have no screen. Nothing goes red and nothing looks wrong.
`markDeposited` and `markBounced` were complete on both ends for months with no
button anywhere, so cash in hand could only ever grow and a bounced cheque
could not be reported at all; `listTours` meant a salesman asked to work away
for a week and the manager's answer reached his phone, was stored, and was
never shown to him. `validationsFor`, `listOrders`, `listPayments`, `touchLead`
and `daysAwaitingAnswer` were the same shape. `mbos-app/src/data/reachable.test.ts`
asserts every export in `data/` is named somewhere outside its own definition,
with a `PARKED` allowlist that takes a REASON — the alternative is not "no
allowlist", it is the list this app already had, held nowhere and known to
nobody. It proves a function is reached, never that the path is one a person
can walk; the cheap half is what was missing.

**And a handler the handset never calls is the same bug across the wire.**
`dispatchItem` is the whole list of things a salesman can send us, and a `case`
with no matching `entityType:` on the handset means the server half shipped and
the phone half never arrived — both compile perfectly alone. `internal_note`
sat like that from the day the module shipped: §R had a table, a role list and
a bootstrap that narrowed by role, and `handleInternalNote` waited for a
payload nothing sent, so it was a read path over a table nothing could put a
row in. `mbos-wire.test.ts` now reads the dispatcher against the handset's
writes and fails on either direction, with a `SERVER_ONLY` map for the cases
where "the office sends this one" is the honest answer.

**A HAND-ROLLED HANDLER CANNOT THROW, and that is the trap rather than the
safety.** Three tables — `tasks`, `leads`, `samples` — are written by a handler
that types its column list out, because none of them is the same word twice on
the two sides: `companyName` is `company`, a lower-case `won` is `Converted`,
one note field is a list, and a sample's `state` is not on the wire at all. A
typed list cannot fail on an unknown column, so a field the handler READS and
the server never sends is simply `undefined` — and the `ON CONFLICT` clause
then writes that NULL over whatever was there. `upsertTasks` read
`completionNote`, `completionPhotoId` and `escalatedAt`, none of which were on
the wire, so every pull erased the note and the photograph off any task the
salesman had completed. Nothing failed, nothing logged, and the loss looked
like the salesman never wrote one.

**Leads and samples are the two OWNED tables with an office end, so a pull may
not overwrite what the outbox still holds.** They were on the bootstrap from
the day it was written, on no delta at all, and applied nowhere — so a lead
raised at a desk reached the phone only on a fresh sign-in, and in practice
never. They come down on every pass now, like `journeyStops` and `tasks`, and
they land under `where syncState = 'synced'`: a queued row is one this handset
has said something about and the office has not heard yet, so the local answer
is the newer fact and it stands until it is sent. The note list is written on
INSERT only, because it is APPENDED to locally and the wire carries one
flattened string — restating it every pass would replace a salesman's own notes
with the office's rendering of them.

**And a date off the wire is not an instant until something names the
midnight.** The fourth spelling of the rule, in JavaScript on a handset:
`Date.parse('2026-09-08')` is specified to read a date-only string as UTC, so a
`requestedDate` lands five and a half hours before the day it names. It is
invisible in IST, where it still formats to the right date, and wrong the
moment anything compares it to a local day boundary. `localInstant` spells a
date as local midnight and leaves a full ISO instant alone, because that one
carries its own zone.

**A parameter is a string, not a Date.** `postgres` serialises a JS Date by
asking Node to measure it as text, and on Node 25 that throws — inside the
driver, where no type check sees it. Every query in the MBOS pull delta carried
the cursor, so every one of them failed and the whole pull answered 500 the
moment a handset had a cursor; bootstrap passes no Date at all, which is exactly
why sign-in worked and syncing after it did not. An ISO instant carries its own
zone, so this is not the bare-cast rule in different clothes.

**A NUMBER SUBTRACTED FROM A DATE NEEDS ITS TYPE SAID OUT LOUD, and this one
took the whole delta down again.** Same endpoint, same 500, a different cause,
and it outlived the fix above: `p.plan_date >= (now() at time zone $tz)::date -
$days`. `$days` is a bind parameter and an untyped parameter beside a date lets
Postgres resolve the subtraction as `date - date` — which yields an integer, so
`date >= integer` has no operator and the query throws. `buildPull` ran two of
these inside its `Promise.all`, so the rejection took every other channel with
it: the journey, the customers, the products, the tasks, the price list, all of
it, on every pull from a handset holding a cursor. Which is every pull after
sign-in, because the bootstrap is what issues the first one. `::int` on the
parameter is the whole fix and `planDaysFor` is the one copy of it.

**And NOTHING HAD EVER EXECUTED `buildPull`** — that is why both of these
lived there. The wire test reads the file as TEXT to compare column names
against the handset's schema, which is a real check and cannot see a query that
throws; `buildBootstrap` was exercised and the delta was not. Correct columns
in a query nothing runs is exactly the state it was in for both bugs. There is
a test in `activity-location.test.ts` that RUNS the delta with a cursor now,
asserts every channel the handset applies came back as an array, and puts a
real plan day and stop through it. Its point is not the date arithmetic: it is
that the next query which only fails at the database fails there rather than on
a phone in Nagpur.

**And it came back, in the order handler, where it failed differently.**
`handleOrder` bound `orderedAt` — a Date — into both `update customers set
last_order_date …` statements, so EVERY field order was refused with a
`Failed query` message and came back as a **retry** rather than a rejection.
That is the worse of the two shapes: the outbox resends for ever, the salesman
sees an order that never lands, and nothing on either end names the cause. It
was found by the first test to send a real order payload through the handler,
which is the point — the rule is invisible until something actually binds a
Date, and no type check will ever see it. Grep for `${` followed by a Date
before adding a raw query, and pass `.toISOString()`.

**And it was in the visit handler too, where it cost the whole day.**
`handleVisit` bound `checkInAt` into the derived `last_visit_date` and into
the journey stop, so every visit came back as a **retry** — and a visit is the
DEPENDENCY of the order and the payment taken on it, so the order and the
payment never went either. A salesman's whole day sat in the outbox behind a
record that would never land, with the office seeing nothing and the handset
saying only that it was still trying. It was found by sending a real visit
payload through the HTTP endpoint rather than the service, which is the only
way any of these three ever show up.

**Publishing to the field is a decision, and withdrawing is the same decision
reversed.** The document library and the training centre had tables, handset
screens that read them, and no door between the two — both were empty because
they could not be filled. Neither `publishDocument` nor `publishCourse` deletes:
a policy a salesman quoted to a customer in March is a fact about March, and
somebody half-way through a course does not become unfinished because the
material was taken down. `active = false` takes it off the handsets and the
tombstone is what tells them it went.

**A document must have a file; a course need not.** A briefing delivered in a
meeting is still a course to record and tick off. A document with nothing behind
it is a row the handset lists and cannot open, and the failure — a tap that does
nothing — says nothing about why, so it is refused at the form instead.

**A course's file is its own attachment parent.** It could have borrowed
`mbos_document`, and that would be wrong exactly where it matters: `canRead`
decides who may open a file FROM the parent kind, so a course deck filed as a
document would be read under the document rules — role lists and a customer's
scope, neither of which a course has.

**THE OWNER IS ASKING FIVE QUESTIONS, and they are one funnel rather than five
reports.** New leads, what became of them, what an order is worth, how often
one comes, and whether the customers it produced are still buying. That is why
they live in one engine, share one definition of a period, and each opens the
thing behind it — a headline figure nobody can get behind is a number they have
to take on trust. Margin is absent on two counts: the brief excludes it, and
`products.priceSource` is still `unset`, so a cost here would be an invention on
the one screen where a wrong number does the most damage.

**A LEAD LIVES IN TWO TABLES and both count.** `customers.kind = 'lead'` is a
party the book knows has never ordered — an owner, a source, a created date,
and no ladder at all. `mbos_leads` is somebody a salesman actually met, with the
full rung list: new → contacted → qualified → negotiation → won/lost. The
owner's question is whether the company is generating opportunities, not which
table one landed in, so `leadsCreatedIn` reads both. They are DEDUPLICATED
across the join: a converted field lead writes a customer row, and counting that
row as well would inflate the very KPI that measures lead generation.

**Conversion is measured by COHORT, never by dividing this month by this
month.** Orders this month over leads this month asks a lead created on the 29th
to have ordered by the 31st, and mixes orders from leads generated in March into
a rate labelled with August's lead count. A cohort follows one window's leads
forward for `owner.conversionWindowDays` and reports what became of them.

**A cohort read before its window closes is UNFINISHED, not failing.** A lead
eleven days old with a ninety-day window has not failed to convert. `stillOpen`
carries how many are still inside it and every screen says so in words — the
difference between a low rate and an incomplete one is the single most misread
figure in the module.

**The denominator is EVERY lead in the cohort, and the qualified rate sits
beside it.** Only a field lead can be `qualified`, because only a field lead has
a ladder. A denominator restricted to qualified leads would silently drop every
CRM lead — most of this book — and report a flattering number with nothing on
the screen saying why. Both are shown; the headline is the one somebody can
verify by counting.

**A rate moves in POINTS and a count moves in percent.** 12.5% to 14.8% is up
2.3 percentage points, not up 18.4%, and printing the second is the commonest
way a dashboard flatters itself. `changeInCount` and `changeInRate` are separate
functions returning a `kind`, and the pill prints "pp" so the reader can see
which they are looking at. Growth from nothing is `null` rather than a
percentage: one lead last month and forty this month is not up 3,900%.

**A month is compared CALENDAR-ALIGNED and equal-length at once.**
`comparableRange` is not `previousRange` and must not be confused with it: the
latter gives the equal span immediately before, which is right for a calling day
and wrong for a month — twenty-two days of August against 10–31 July is an equal
window nobody recognises. Aligned so the comparison is the one somebody meant,
equal-length so a month-to-date is never held against a whole month. The 31st
shifted into a thirty-day month lands on the 30th rather than rolling forward,
which a naive `setMonth` gets wrong by a whole month.

**Average bill size is net of credit notes, and the COUNT is untouched.** A
credit note is not a sale that un-happened, it is money given back on one that
did — removing the transaction would raise the average every time somebody
allowed a claim. It is datable at all only because `issueCreditNote` writes a
confirmed receipt keyed `creditnote:<complaint>`; there is no issue date column.
That same key is why a credit note no longer counts towards a salesman's
COLLECTION figure, which it did until this landed: AGENTS.md already said
`Adjustment` is not money arriving, and the collection component was counting it
as though it were.

**Frequency divides by customers who ORDERED, not by the book.** Dividing by
every customer would make the figure fall every time somebody added a prospect.
"A thousand transactions" says nothing without the number of customers behind
it — a thousand from 250 is a different business to a thousand from 900.

**THE BAND OWNS THE PHRASE "AT RISK", AND THE SCORE MAY NOT BORROW IT.**
There are two health models and both are worth having — the BAND asks whether
somebody has stopped buying, from one fact, their own cycles elapsed; the SCORE
asks how the relationship is doing, from five. They were being rendered in five
places with four different sets of thresholds, and two of those five used the
same two words for different questions: `/sales/leads` called a customer "At
risk" below a SCORE of 40, and the owner's report called one "At risk" at 1.25
CYCLES overdue. A manager and an owner could read that phrase about one shop on
one afternoon and mean different things, which is what B3-16 was raised about.
The handset's `customerStage` was the worst of the five — `< 40 ? 'Overdue' :
< 60 ? 'At risk'`, a third pair of thresholds, neither of them configuration,
and an unscored customer falling through to "Active", which is a verdict about
somebody nothing had measured.

`lib/customer-health.ts` is the one place either becomes words, pure and
client-safe like `account-types` and `seat-labels` beside it. The band gets the
retention word; a low score says `watch` and NAMES the components dragging it,
because "paying late, two complaints open" is both truer than "at risk" and
tells somebody what to do. There is a test asserting a score can never produce
the phrase.

**And its two thresholds are configuration now.** They were a literal 70 and 50
inside the handset's health pill — two business numbers invisible to the one
screen a manager would change them on. `mbos.health.strongAtOrAbove` joins
`mbos.health.atRiskBelow`, and `checkConsistency` refuses a strong threshold at
or below the watch one, because a score between them would be both at once.
The old key keeps its name so no stored setting has to be migrated; what
changed is its label, which is what a manager actually reads.

**The band reaches the handset on the wire, computed once.** Like the score
beside it: a phone deriving its own would derive it from a book hours old, and
two salesmen standing in one shop would read different words about it. It is
filled in JS by `bandFor` — never as a CASE in the query — because a second
copy of that rule drifts the day somebody changes a multiplier.

**CUSTOMER HEALTH IS FOUR BANDS OF ONE EXISTING RULE, not a second one.** Active,
at risk, dormant and lost, measured in multiples of the customer's OWN buying
cycle — a fortnightly buyer and a twice-a-year buyer are both a quarter late at
1.25 of their own rhythm, and a flat 30/60/90 would call the first lost and the
second fine. `dormant` is deliberately NOT its own setting: it IS
`inactive.cycleMultiplier`, the threshold the source document states precisely
and the point at which `customers.status` becomes `inactive`. One number, so the
Call Log cannot chase somebody the owner's screen has written off. The bands
live in `engines/inactivity.ts` and `evaluateInactivity` reads them, so nothing
moved on the day they shipped — there is a test asserting the flag still fires
exactly where it did.

**A customer who never ordered is in NO band, and a lead is not in the book at
all.** They have not stopped buying, they have not started; folding them into
Active is how a retention figure flatters itself and calling them Lost is worse.
A DEACTIVATED account is out entirely — somebody closed it deliberately, and
counting a business decision as a retention failure is a different lie. Both are
counted and printed rather than hidden.

**Movement is the figure the counts cannot give you.** 145 at risk in both
months looks stable and may be 145 different customers, half recovered and half
newly slipping. `customer_health_snapshots` holds where each customer stood at
the end of a month and is the only place that survives — a band is a statement
about a day, unrecoverable once the customer has ordered. It is a SNAPSHOT, not
a cache: nothing rewrites a past month and nothing may learn to, because a
rebuild would destroy the thing it exists for. The nightly pass writes over the
CURRENT month's row, which is what makes a closed month correct for free — it
stops being overwritten on the last night of the month, so no job has to fire on
exactly the right day. **It cannot be backfilled**, and the screen says "we
cannot say yet" rather than drawing a movement of zero.

**The Reports app narrows by scope like every other list.** It is the owner's,
but a manager granted it must not see the whole company through it — a reporting
screen that skips the narrowing is a way around it rather than a report.

**A SALESMAN IS NOT MEASURED IN RUPEES ALONE, and the reason is arithmetic
rather than philosophy.** A price revision moves every rupee figure in the
business without one extra can leaving the godown, so a book measured on
revenue alone reports the month prices went up 30% as the month everybody
improved 30% — and the salesman who actually sold less outranks the one who
sold more. `sales_targets` therefore asks for five figures and a mix, and
`lib/engines/performance.ts` scores six components out of a hundred: revenue
35, volume 20, product mix 20, new customers 10, collection 10, activity 5.
Every weight is configuration and `checkConsistency` refuses a set that does
not total 100 — a score presented out of 100 computed out of 95 is a different
number wearing the same label, and nothing on any screen would say so.

**Volume is the half a price list cannot move, so the divergence between the
two is the alert.** Revenue at or above target with volume more than
`performance.volumeDivergencePoints` below it means the money came from the
price list, and it is exactly the month somebody would otherwise be
congratulated for. It is drawn on the team dashboard, on the person's own
screen and on the handset, because the person being congratulated is the one
who most needs to know.

**Litres are derived from the SKU's packing, and revenue is not derived from
anything.** Quantity is cans, `products.millilitres_per_can` turns it into
millilitres, and the value of a line is what was actually billed — the product
master still holds no prices and `canValueOrders()` still answers no. Nothing
here reaches for a packing cost to make a total look complete.

**Whose number it is falls through, and it is ONE person.**
`lib/sales-attribution.ts` is the only place that rule is written: the
salesperson on the account, and where there is none, the back office person who
works it. Not both — `scopedToUsers` deliberately answers with both seats,
because two people may need to SEE an account, and exactly one may be CREDITED
with it or the team's revenue adds up to more than the company's and every
comparison between two salesmen is drawn from a total that does not exist.
`owner_id` is deliberately absent from the chain although `ASSIGNED_TO_SQL`
ends with it: on an imported book it is whoever ran the import, one person on
more than a thousand rows, and ending there would hand them the revenue of the
whole company on the day somebody set them a target. A customer with neither
seat is UNATTRIBUTED, counted, and printed on the dashboard — a figure nobody
can account for is worse than one that says why it is there.

**Which is why a telecaller has a performance screen.** Back office people
carry a large part of this book under that fall-through, and they are
redirected out of `/sales` by its own layout — so `crm.performance` exists, it
shows one person and only ever the signed-in one, and it takes no id. A manager
comparing people has the Sales Dashboard; an id on this route would make it a
way for anybody to read anybody's appraisal.

**A mix category is a row, not four strings in a screen.** The brief names
Universal, PU and Nano and the catalogue carries nineteen formulations, so the
classification hangs on `product_formulations.category_id` — the level at which
it is actually true, since one liquid sells as Nano, Astar Nano and M5x4
Thinner and all three are the same strategic product. Exactly one category is
the RESIDUAL, enforced by a partial unique index, and it catches both the
formulations nobody has classified and every order line whose product name
matched nothing. Without a residual the shares would not total 100% and every
percentage on every screen would be wrong by an amount nothing named.

**Unmatched money counts as revenue, contributes no litres, and is REPORTED.**
Order lines carry a product NAME and several of the sheet's names match
nothing. That money is real; what it cannot do is claim to be litres of a known
product. `sales_performance.unmatched_revenue_paise` carries the figure so a
screen can say the mix was computed over 94% of the value rather than present a
share that is quietly wrong.

**Each mix category is weighted by what was ASKED, never by what arrived.**
Weighting by the actual share would let somebody who sold nothing but the easy
line score a perfect mix — that category would be the only one with any weight
and it would be far above its target. Three numbers rather than one, because a
book selling into furniture and one selling into automotive cannot be held to
the same 30%, and a band that does not increase is refused by a check
constraint: it would score a larger share lower than a smaller one, invisible
until somebody is marked down for selling more of exactly what they were asked
to sell.

**A component nobody set a target for is DROPPED, and its weight is shared
out.** Null and zero are different answers here. Scoring an unset component 0%
marks somebody down for a question never put to them and scoring it 100% pays
them for it, so it leaves the score and the remaining weights are restated out
of a hundred — which keeps the sentence "this is out of 100, against what was
actually asked of you" true. The names of the dropped components are stored and
the screens print them.

**A target is DRAFT until it is published, and a published one changes only
with a reason.** A manager builds thirty of these in an afternoon and a
salesman watching his number change four times before lunch stops believing any
of them, so nothing reaches a handset until it is published.
`sales_target_revisions` is a table rather than a line in `audit_log` because
the question somebody asks in March is "which targets moved for the price
revision", and an audit log can only answer that by grep — the reason is a code
from `performance.revisionReasons` so it can be counted, one row per figure
that moved, and the person is notified. A draft is EDITED rather than revised:
nothing has been promised to anybody, and logging every keystroke of
target-setting buries the four changes that matter.

**A salesman cannot reach any of it.** `target.set` is checked in the action on
every path — a server action is a URL and a hidden button is not a permission.
It is deliberately not the same capability as `customer.reassign`, which moves
which accounts feed a target and stays accounts' and admin's, so no one person
both chooses the number and chooses the book that fills it.

**`target.set` is held by managers AND by accounts, and the second is where it
actually gets used.** The module shipped manager-only, on the assumption that
whoever runs the team's calling book is who sets its numbers — the same
assumption behind keeping `order.approve` off managers, read the other way
round. That assumption was not Mahek's own practice: the accounts desk is who
assigns and manages targets here, so the capability sits in
`ACCOUNTS_OR_MANAGER` beside `sheet.import` now, for the same reason —
widening rather than moving, so a manager coaching a shortfall can still act on
it without asking accounts to do it for them. The Accounts app's own Sales
targets screen, at `/accounts/targets`, is not a second target system: it
reads `targetableCandidates`, `mixCategories` and `baselineFor`, writes through
`saveSalesTarget`/`publishSalesTarget`, and shows the same "Add someone" picker
and "Carried forward" badge `/sales/targets` does — because accounts hold
`apps: ["accounts"]` and are redirected out of the Sales Dashboard before they
would ever reach the original screen, and a second door onto the same feature
that quietly drew a different picture would be worse than no second door. It
adds one thing that screen never had: a **revision history** drawer reading
`revisionsFor`, which had sat in the service since the module shipped with
nothing ever calling it. Holding `order.approve` and `target.set` together is a
new hat combination worth naming on its own terms: an accounts user who is
ALSO a telecaller could now set their own target, which is why
`lib/role-conflicts.ts` carries a second telecaller+accounts entry for it,
beside the one about reporting a payment and then confirming it.

**A person's target and a customer's are two different grains, and they stay
two different screens.** `/accounts/customer-targets` reaches the CRM's own
Monthly Targets — `listTargets`, `setTarget`, `setTargetsBulk`,
`shortfallAnalysis` in `lib/services/worklist-services.ts` — the same way
`/accounts/targets` reaches the Sales Dashboard's: one door added for
accounts, nothing rebuilt. `MonthlyTargetsScreen` moved to
`src/components/customers/`, the same shared home `CustomersScreen` already
has, and takes `app`/`basePath`/`customerHrefTemplate` so the two doors differ only in
where their links lead — Accounts has no customer detail page, so a customer's
name leads to their ledger statement instead, and "See their bills" folds into
that same link rather than pointing at a screen accounts cannot reach. Folding
this into the Sales targets screen as a third tab was the obvious shortcut and
the wrong one: a target set on a PERSON and a target set on a CUSTOMER are
different questions, and one screen answering both from tabs would say which
tab was answering which question and nothing else. The screen's own gating
moved with it — it read `isManager(user)` to decide who may set a target,
which was correct while `target.set` was manager-only and silently wrong the
moment it widened; both doors now check `can(user.role, "target.set")`
instead, the capability itself rather than a role that used to imply it.

**The score is a CACHE, and not the same kind of column as
`calls.next_step_*`.** `sales_performance` is rebuilt by
`recomputeSalesPerformance()` — nightly for this month and the last, hourly for
this month, because the handset reads the cache and a salesman who took three
orders this morning must not see yesterday's figures all day. Those next-step
columns record what somebody was TOLD on a day and must never be rebuilt; this
is a reading of the present, so a rebuild is a correction rather than a
destruction. The handset is sent the cache with its `computed_at` and prints
it, because a screen that implied it was live would be believed.

**Working days, never dates.** A month with four Sundays left is not two thirds
gone because twenty of thirty dates have passed, and a forecast built on dates
tells a salesman on the 20th that he is further behind than he is. Holidays
come from `mbos_holidays` and the working week from configuration. The current
day is not counted as elapsed — dividing by a day still being worked makes
everybody look behind every morning — and with no completed day there is no
forecast at all, because one day's selling multiplied by thirty is a
multiplication rather than a projection.

**A visit's ACTIVITY is counted on the server's clock.** `client_created_at` is
what the phone said and its owner can set it, so anything anybody is paid on
reads `server_created_at`. Believing the handset would let somebody backdate a
fortnight of visits into a month they had missed.

**Collection counts confirmed receipts only.** A `reported` or `held` payment
moves no money anywhere else in this product and moves none here either — a
collection target met on a telecaller's word is a target met on money nobody
has found in the bank.

**A new customer is one whose FIRST counting order lands in the period.**
Creating a lead never counts, which is the only definition that cannot be
worked from a desk, and a customer is won exactly once.

**Salary is read, never written.** HR maintains the employee workbook, HRMS
mirrors it hash-for-hash, and the salary columns are already in it — so the
Sales Dashboard reads what payroll publishes and a correction is made in the
workbook. Days worked and reimbursements sit BESIDE the pay without being added
to it: a reimbursement is money owed back rather than earnings, and a single
figure combining them is neither. There is no incentive column, because
MahekOne sets no monthly target for a field salesman and a figure with nothing
to be computed from would be an invention on the one screen where a wrong number
is least forgivable.

**HOW HE GOT TO THE SHOP IS ASKED WHEN HE SETS OFF, and "Start visit" now
means "I am setting off".** Pressing it opens `TravelGate` — the modes from
`mbos_travel_modes`, an admin's rows rather than a list in a screen — and the
visit stays LOCKED behind an "I have arrived" step until he says he is there.
That reversal is the point: starting the dwell clock at the tap would count the
ride as time in the shop, which is the one number the dwell check exists to be
honest about. Nothing new is priced by this. A leg it opens is the same
`mbos_travel_legs` row `/travel` writes, on the same `mbos_expense_days`, and
the policy engine decides what it is worth exactly as before — so a day's
reimbursement is one figure however its legs got there.

**A LEG NOW HAS A REAL GAP BETWEEN ITS TWO ENDS, which is a state `/travel`
could never express.** The day log writes `started_at` and `ended_at` in the
same breath, because it is typed up once the journey is over; a leg opened from
a visit sits with `ended_at` null while he is on the road. It is a ROW and not a
screen state — Android reaps this app on the road constantly, and a "travelling"
flag in memory would be gone by the time he arrived with the departure
photograph already taken and nothing left to attach it to. A partial unique
index keeps one open leg per person, at both ends: he cannot be travelling to
two shops at once, and two open legs would mean the arrival photograph had a
choice of which departure to close.

**THE METER IS PHOTOGRAPHED AT BOTH ENDS, because one photograph cannot show
two readings.** `odometer_photo_id` keeps exactly the meaning it had — a
day-log leg types both readings at once and photographs the meter as it stands
— and `odometer_end_photo_id` is its counterpart. The one that would otherwise
be missing is the DEPARTURE: the reading nobody can go back and check, because
by then the meter has moved. Both the reading and the picture are required and
neither is redundant — two photographs cannot be subtracted, and a figure with
no picture behind it cannot be checked by anybody who was not standing there.

**`origin` is what lets the server be strict about one and not the other.** A
`day_log` leg is typed from memory once the journey is over: the photograph is
optional and always will be, because refusing it for want of a picture nobody
can now take would mean refusing to record a journey that happened. A `visit`
leg was opened as he set off and closed as he arrived, so the app was present
at both ends and CAN insist. Without the column the strictness would silently
have broken the screen that shipped first, which is the whole reason it is a
column rather than a guess from which fields happen to be filled in.

**It is our own camera, unlike every other rear-facing photograph.**
`selfie-camera.tsx` argues that only the selfie should be ours and every word of
that still holds — it just does not decide this one, because `OdometerCamera` is
not asking for a photograph. It is asking for a NUMBER with the photograph as
its proof, and the two have to be one act. Handed to the system camera they
become two: MBOS goes to the background where a battery manager reaps it, and
the digits get typed against an image nobody is looking at any more. The only
ways out are both together, or abandoning the journey.

**The reading is refused while he is still at the meter, which is the only
moment it can be.** An arrival below the departure is a digit dropped from the
front, not a meter running backwards; a distance above
`mbos.travel.maxLegKilometres` is a typo, not a long day. Checked in
`lib/travel-leg.ts` on the handset and AGAIN in `handleTravelLeg`, because a
mileage claim is money and a check that lives only in an interface is not a
check. A journey called off is CLOSED AT ITS OWN READING so it measures nothing
and carries the reason — deleting it would leave the next departure following on
from a gap, which is the pattern an audit stops at.

**A bus or train ticket is offered on the way out and never demanded.** It is a
scrap of paper that gets lost between the seat and the shop door, and refusing
the visit over one would mean refusing to record a visit that happened. Skipping
says in words that the fare can still be added on `/travel`, so nobody skips it
believing the money is gone; the PNR is optional beside it, because a local bus
ticket has no number and that is what a duplicate would be caught on.

**EVERY ODOMETER PHOTOGRAPH WAS BEING DELETED NIGHTLY, and none of them could be
opened.** Both halves of the bug AGENTS.md already records for the whole MBOS
media subsystem, arriving again with the module written after the fix.
`MBOS_PARENTS` did not name `travel_leg`, so `storeMbosMedia` resolved no parent
and every file landed with `parent_id` null — which is exactly what
`sweepOrphans` removes past `attachments.orphanCleanupHours`. A meter
photographed on Monday was gone on Tuesday, and until then only its uploader
could open it, because `canRead` named no rule for `mbos_travel_leg` either and
`customerBehind` fell through to `calls`. Who may open one is
`canReadTravelLegPhoto`: the man who took it, and whoever holds the `sales`
grant with him inside `managerScope`. The grant is asked FIRST and is not
optional — `managerScope` answers "national, sees everybody" for anybody with no
row in `mbos_manager_territories`, which is every plain salesman, so falling
straight through would let one salesman open another's mileage evidence by id.
It is not read through the customer's scope either, though a leg names a shop:
this is evidence about a person's expense claim, not about the customer.

**Tracking runs between the check-in and the check-out and not one second either
side.** A track that carried on after the day was closed would be following
somebody home. The handset takes a fix every few seconds — dense enough that
the line connecting them hugs the actual road with no map-matching service
needed to snap it there — and posts batches to its own endpoint rather than
through the outbox — a position is one of a thousand, worth nothing alone, and
queueing them ahead of the visit behind them on a 2G connection buys nothing.
`mbos.location.trackWhileWorking` is checked in the route as well as on the
handset, because a hidden control is not a disabled feature.

**A POSITION IS ITS READING, and an id that is not derived from one is a
duplicate generator.** Every fix was stored under a fresh `randomUUID()`, so
`INSERT OR IGNORE` on the handset had nothing to ignore ON and neither did
`onConflictDoNothing` here. `data.locations` is a BATCH of deferred fixes and
Android hands the batch over again whenever the task did not complete — which
is every time the OS reaps the process mid-flush. Production reached 33,000
rows for 4,000 real fixes, one of them ninety-three times across ninety-two
separate uploads. The id is `at|lat|lng` now, and `mbos_positions_fix_key` is
the half that does not depend on which build is in somebody's pocket: an old
APK cannot reintroduce the damage while it waits to be updated.

**A QUEUE DRAINED OLDEST-FIRST, ONE BATCH PER TICK, CANNOT CATCH UP.** `flush()`
sent exactly one batch of five hundred, and the sync tick that calls it is a
`setInterval` that only advances while the app is open — a drain with a fixed
rate in front of a queue with none. At a fix every three seconds that is twenty
rows a minute before any redelivery, filled all day and emptied at five hundred
per minute of SCREEN TIME, oldest first. The newest fix, which is the only one
the Live map wants, sits at the back of it. A phone uploaded three thousand rows
across six successful posts in one day and moved its trail forward by three
minutes of the PREVIOUS evening, while its owner walked a full beat — and
nothing anywhere looked wrong. The posts returned 200, the connection was fine,
and the office simply saw a salesman standing where he had been the night
before. `flush()` loops until the queue is short now. The general lesson is the
one worth keeping: a drain whose rate is fixed and whose fill rate is not is a
queue that reports success all the way down.

**AND THE THREE SECONDS IN THAT PARAGRAPH WERE NOT A SETTING ANYBODY CHOSE.**
`mbos.location.trackEveryMinutes` said five and the handset asked for five, and
Android delivered at 3.0 seconds for three days. `timeInterval` NEVER REACHES
IT: expo-location declares it `Long?` and reads it out of the task's persisted
options with `map["timeInterval"] as? Long` — but options are stored as JSON,
so `org.json` hands back a boxed `Integer` and a strict `as?` yields null. The
override is skipped in silence and `Accuracy`'s own fallback of 3000 ms stands.
`distanceInterval` is declared `Int?` and survives the same round trip, which
is why the one parameter nobody meant to be load-bearing was the only one
arriving. A hundred times the fixes, a hundred times the battery, and the queue
above could never have drained whatever `flush()` did.

**So the cadence is enforced where no cast can lose it, and that is
JavaScript.** `deferredUpdatesInterval` is set beside `timeInterval` because it
IS read with a coercing `getLong` and does arrive — but it is the battery half
only, since expo bypasses it outright while the app is in the foreground
through its own `shouldReportDeferredLocations`. The authority on what actually
gets WRITTEN is `shouldKeepFix` in `engines/cadence.ts`, which is pure and
tested. It is an engine rather than three lines inside `trail.ts` for exactly
the reason the bug lasted three days: that file imports expo-location and
TaskManager at module scope, so nothing in it can be exercised without a
device, and a cadence nobody can test is a cadence nobody can be sure of. The
mark lives in `kv` and not in `positions`, because the queue is emptied as it
uploads — asking the table would answer "nothing kept recently" the moment a
flush succeeded, and the cadence would collapse back to whatever the OS felt
like delivering. A clock corrected BACKWARDS resets it rather than stalling,
or a phone an hour fast would record nothing until it caught up with a mark
from a future it no longer believes in.

**A fix that is not kept is still REMEMBERED.** The trail wants one point every
few minutes; `whereNow()` wants the freshest reading there is, and throttling
that would age the position on every order and payment by the whole cadence.

**A fix is judged against the SESSION IT BELONGS TO, not against today.** The
sentence at the top of this section used to be enforced by asking whether the
sender is checked in RIGHT NOW, which is a different question. A batch is a
queue catching up — its fixes were taken hours or days before they arrive — so
the day to judge them against is the day they were TAKEN. Worse, any CLOSED day
refused the whole batch, and `markMissedCheckouts` closes a forgotten day at the
last position it can see: a handset that lost its trail early had its day closed
early, and every later fix was then refused BECAUSE the day was closed, on the
strength of a closing time that existed only because the fixes were missing.
The route reads the attendance rows the batch actually spans. The privacy rule
is unchanged and only now actually holds.

**A batch with no session to file it against is KEPT, not dropped.** The handset
deletes what it sends on any `ok`, so `ok: true, stored: 0` is an instruction to
forget — and answering that to a batch whose check-in is still in the outbox
destroys a morning to win a race by thirty seconds. `no-session-yet` is the one
answer that means hold on to them, and the handset drops them itself after a
week, because a queue that only ever grows is the other way to lose a day.

**`SCHEMA_VERSION` COUNTS THE MIGRATIONS RATHER THAN BEING TYPED BESIDE THEM.**
It was a literal and it drifted: travel and expense added an eleventh block and
left the constant at 10, so `migrate()`'s own `current >= SCHEMA_VERSION` guard
returned before running it. A fresh install was fine — it starts at 0 and runs
everything — which is exactly why nobody saw it, and why the handsets that
skipped the block were precisely the ones already in the field. It is
`MIGRATIONS.length` now, so adding a block is the whole of adding a migration.

**`timeInterval` never reaches Android, and no error says so.** expo-location
declares it `Long?` and reads it out of the task's persisted options with
`map["timeInterval"] as? Long` — but those options are stored as JSON, so
`org.json` hands back a boxed `Integer` and a strict `as?` yields null. The
override is skipped in silence and the accuracy preset's own fallback stands:
`High` is 2000 ms, `Balanced` 3000. `distanceInterval` is declared `Int?` and
survives the same round trip, which is why the parameter nobody meant to be
load-bearing is the only one arriving. It is close enough to
`trackEverySeconds`'s floor of 3 to be harmless today, and it means that
setting is INERT on Android — raising it to a minute would change nothing.
Enforce a cadence in JS if one is ever needed; do not trust that field.

**Every activity is logged with where it was done, and it is written in ONE
place.** Four MBOS tables carried a coordinate and twenty-three did not, so an
order taken at a shop, a payment collected at a counter and a complaint raised
in a godown were all recorded with no idea where they happened.
`mbos_activity_locations` is one row per activity rather than a lat/lng pair on
each table — "where was this done" is one question with one answer shape, and
answering it in twelve places is answering it in eleven and forgetting the
twelfth. The server writes it in the sync DISPATCHER and no handler mentions it,
which is what makes a thirteenth entity type carry it by existing; the handset
attaches it in `enqueue`, the one function every write passes through, for the
same reason.

**It is a sibling of the payload, never a field inside it.** `idempotencyKey` is
a hash of the payload, so folding a position in would make the same order
enqueued twice from two spots on a street into two orders. Where somebody stood
is a fact about the act, not part of the record's content.

**A position never delays a save, and never costs one.** `whereNow()` answers
from the freshest fix already known — almost always one the day's trail took
minutes ago, which is why this needs no extra battery — and the top-up happens
after the write has returned. A missing fix, a refused permission, a nonsense
coordinate: the activity lands regardless, which is the same rule attachments
follow and for the same reason.

**Age is part of the reading, exactly as accuracy is.** Four minutes is evidence
of where somebody stood; four hours is evidence of nothing. Both are stored with
their age and `mbos.location.activityFixMaxAgeSeconds` decides what the screens
CALL stale — dropping the older one would throw away a fact to avoid having to
explain it. A stale mark is drawn hollow rather than hidden: the act is certain
and only its place is not.

**No fix is a recorded fact, not a missing row.** Coordinates null with a reason
says we asked and could not; no row at all says nothing asked. Those are
different facts about somebody's day and no screen may render them alike.

**Paperwork carries no location, and that is deliberate.** Leave requests,
agreeing a proposed day and picking shops all happen on a sofa at nine in the
evening as often as anywhere. Where an order was taken answers a real question;
where a form was filled in records where somebody lives and answers none.

**It is written only for an ACCEPTED item.** A refused order did not happen, and
a position for it is a record of somewhere a salesman stood while something
failed — noise on every screen, and one more row held about a person for no
reason.

**The Live map has streets under it, and it started with none.** The
original reasoning was that tiles meant sending Mahek's salesmen's coordinates
to whoever supplies them, on every render, plus a key and a bill, to answer a
question nobody was asking — so it shipped as pins on a bare equirectangular
projection of the team's own bounding box instead. OpenFreeMap answered two of
those three objections outright — no key, no account, no bill, no usage
limit — and was the first supplier. It is Ola Maps now: once the map needed a
key anyway, for Snap-to-Road, running two tile suppliers for one screen was
two things to keep coverage and reliability current on. The pins themselves
are drawn from MahekOne's own data and never leave it; a tile server is only
ever asked for squares of map, never a coordinate. Two views, because they
answer two questions: where they are NOW is the morning one, and everywhere
they went TODAY is the evening one.

**And that key is the one exception to how every credential here is read.**
`readSecret` — see AGENTS.md's own note on it, in `lib/secrets.ts` — is read
once, server-side, by the request about to spend it, and never otherwise
leaves the server; a map tile key cannot follow that rule, because the
BROWSER is what repeatedly asks Ola Maps for tiles as somebody pans and
zooms. `page.tsx` reads it once and hands it down as a plain prop, and
nothing downstream asks for it again. This is true of every tile
provider — Mapbox, Google, Ola — and the mitigation is the standard one:
restrict the key to this deployment's own domain in Ola Maps' own console,
so a copy seen in a browser's network tab is not spendable anywhere else.

**Without a key there is no map, and the screen says so rather than drawing
one broken.** Every tile request would fail the moment there is nothing to
attach to it, so `street-map.tsx` does not attempt to build one: no key gets
its own state, pointing at Admin Console → Platform → Maps, on both views —
the team list beside it is unaffected either way.

**The renderer is MapLibre and the supplier is a URL.** `STYLE` in
`street-map.tsx` is the one line that names the tile supplier; if Ola Maps'
coverage of a beat turns out to be thin, or terms change, swapping the
supplier is an edit to that constant and its `transformRequest` rather than a
rewrite. That `transformRequest` — appending the key to every request except
an image tile — is not a workaround invented here: it is read out of Ola
Maps' own published web SDK source, which does exactly this internally. The
map's own Mercator projection and `fitBounds` replaced the hand-rolled
equirectangular one — the FIT-not-FILL rule survives every change of
supplier: one pin gets `MAX_FIT_ZOOM` instead of a rooftop, and every point on
the screen, trail and activity marks included, is folded into the same bounds
so a six-kilometre walk and a five-hundred-metre one are never drawn at the
same scale by accident.

**A pin is only drawn where there is a fix.** The design mock spaces salesmen
out arithmetically, which is fine in a picture of a screen and a lie on a real
one. Somebody with no position today is in the team list saying exactly that and
nowhere on the map — inventing a spot for them is the one thing a map of
where people are must not do. The list reads the newest of the trail, the
check-in and each visit, so somebody whose tracking is off still appears.

**The trail can be snapped onto the road it was walked on, and Snap-to-Road
specifically never has to run for the map to work.** At the fifteen-second
sampling density this app uses, a raw GPS line already hugs the road on its
own, so snapping is a refinement on top of a map that already has its
streets — not the thing that draws them. `lib/services/road-snap-service.ts`
calls Ola Maps' Snap-to-Road, batched at its own hundred-point ceiling, and
returns null on anything that goes wrong — a network failure, a bad
answer — which `street-map.tsx` treats identically to "nothing to improve":
the raw line stays exactly as drawn. The SAME key gates both jobs, though:
with none set, there are no streets to lay a trail onto in the first place
(see above). It is set from the Admin Console, under a section of its own
(Platform → Maps), for the same reason dictation's keys are: a deploy nobody
has shell access to needs a screen, not an environment variable, to turn a
credential on.

**It is asked for ONE trail, when a manager actually looks at it — never for
the whole team on every poll.** `tracksForDay` answers the "today" view for
every salesman at once, on a thirty-second refresh; snapping all of that on
every tick would turn one open tab into dozens of calls to an outside service
a minute, almost all of them for lines nobody is looking at. `/api/sales/
live/snap-trail` is asked by the client only for whoever is selected in the
team list, and only once per person per day — `street-map.tsx` remembers who
has already been answered and does not ask again for a name already snapped.
The raw fixes in `mbos_positions` are never touched by any of this: the
snapped line is a second, disposable geometry for the map's `LineString`
only, re-derivable at any time, exactly like every other engine reading in
this codebase.

**Map and satellite are a `setStyle` call, not two maps.** `StreetMap` swaps
the style JSON in place rather than tearing the whole map down — the camera,
the markers and the click handlers survive, because only what the STYLE
itself carries (the trail and activity layers) gets wiped by the swap.
`drawOverlays` runs off `style.load` rather than the once-only `load` event
for exactly that reason: it fires on the very first paint and on every later
switch, so one function draws the same picture every time instead of the
initial build and a later switch drifting into two slightly different ones.

**A single bad layer must not read as "the map could not be drawn."**
MapLibre's `error` event fires identically for something fatal and for one
malformed layer in an otherwise-fine style — and Ola Maps' own
`default-light-standard` ships exactly that: a `3d_model_data` layer naming
a source-layer the `vectordata` source's tiles do not actually carry.
MapLibre logs it and keeps rendering every other layer perfectly, so a
handler that flipped the whole screen to "could not be drawn" on any
`error` put every load of the Live map into that state — even though the
map was, provably, drawn. What is watched for instead is whether the
STYLE ever loads at all, on a generous timeout: that is the one signal
that does not depend on reading meaning into a vendor's error text, and a
bad layer reference among thousands of good ones does not fail it. It is
deliberately the style loading and not MapLibre's own "load" event, which
waits for every tile in view to finish downloading too — Ola Maps serving
a burst of tile, glyph and sprite requests on one page can genuinely take
longer than the timeout to finish all of them, and a merely slow
connection is not a broken map either.

**Territory's shop map is a second Ola Maps instance, and what the two share
lives in one file.** `sales/territory/shop-map.tsx` plots the book's own
shops — clustered, since it can be a few thousand points — and
field-collected prospect pins that never matched a customer, drawn hollow so
the two are never mistaken for each other. It is built separately from the
Live map's `street-map.tsx` because the two draw different things — one
tracks salesmen live, this one is a static read of the book — but both need
the same style URLs, the same key-authenticating `transformRequest` and the
same Map/Satellite switcher, so those live once in `sales/ola-maps.tsx`
rather than as two copies that would drift the day one of them changed. The
same `olamaps.apiKey` gates both: without it, neither map draws streets, and
each says so on its own screen rather than showing a blank canvas.

**A shop pin is a real account, so clicking it opens the account, not a
tooltip.** `customer-quick-view.tsx` reads
`/api/sales/customer-quick-view`, which runs the SAME two functions the
CRM's own record page and Information tab call — `getCustomer` for the
profile, `customerInformation` for the purchase cycle and recent calls — so
a figure a manager reads off a pin on the Sales Dashboard can never disagree
with the CRM's own answer for that account. Fetched on click rather than
carried on every pin, because most pins on a territory of a few thousand
shops are never clicked. Out of scope or gone both answer with nothing to
show, the same "absent to them, never a crash" rule the CRM record page
itself follows. A prospect pin keeps its plain text popup — there is no
customer record behind it yet.

**THE HANDSET'S MAP WORKS WITH NO SIGNAL, because the streets are on the
phone.** The Live map and Territory's map are read in an office; the handset's
is read in a paint market with two bars of nothing, which is exactly where a
map is worth most and exactly where a tile server cannot be reached. MapLibre
serves a tile out of a downloaded pack without being asked to, so the drawing
needed no code — what needed code is deciding WHAT is worth several hundred
megabytes of somebody's phone, saying what it will cost before he starts, and
being able to tell him afterwards whether where he is standing is inside it.
`mbos-app/src/engines/tiles.ts` is the arithmetic, pure like every other
engine; `data/offline-maps.ts` wires it to the book and the native pack store;
`app/maps.tsx` is the screen.

**A DISTRICT IS NOT THE UNIT.** An administrative boundary was drawn for
revenue collection: most of one is fields with no shop in it, and a beat that
straddles two needs both. The areas offered are CLUSTERED FROM THE SALESMAN'S
OWN BOOK — single-link on a grid, so two shops on a street are always one area
and two towns an hour apart never are — and named with the office's own word
for where they are, the area falling back to the city. A repeated name is
separated by its town rather than by a number, because two rows both reading
"Sadar" are two rows nobody can tell apart and the one with the wrong 300 MB
in it is the one they will pick.

**THE KEY IS NOT IN THE STYLE URL, and that is what makes any of it work.**
MapLibre files every downloaded resource under the URL it asked for. With
`?api_key=` on that URL the pack is stored under the key — so rotating it in
the Admin Console makes several hundred megabytes on a phone unreachable, with
nothing on any screen able to say why the map went blank. `TransformRequestManager`
signs requests at the HTTP layer, which runs AFTER the offline database has
been consulted, so a pack is stored key-less and found key-less and a rotated
key costs one request and no tiles. It fixes a second thing in the same
motion: a key on the style URL authenticates the style file ALONE, and the
tile sources, glyphs and sprite sheet it names carry none — which is why Ola's
own SDK signs every request rather than the first. The web has done this since
Territory's map shipped; the handset never got the equivalent.

**The size is on the row before the button is pressed.** These are the largest
downloads this product asks anybody for, and a progress bar that appears after
the decision is not a decision. It is an ESTIMATE — a vector tile over a paint
market is several times one over farmland — and every screen calls it one; the
question it is right about is "tens of megabytes or hundreds", which is the
one the answer turns on. `mbos.maps.maxZoom` is the setting that decides it,
because each step closer is four times the tiles.

**Two ceilings in two units, and only one of them can explain itself.** Ours
refuses an area up front with its size on the screen; MapLibre's own tile count
ABORTS a download part-way with an error about tiles. `checkConsistency`
refuses a tile ceiling below what the megabyte ceiling allows, or a salesman
starts a download this app has already told him is fine and watches it stop.
Its shipped default is 6,000 tiles — a few square kilometres, inherited from
Mapbox's terms — so it has to be raised before the first pack is created.

**A saved area is matched to a pack by GEOMETRY, never by a stored id.** An id
written into the metadata at download time is wrong the first time somebody
adds a shop and the cluster moves: the pack is orphaned, the area offers to
download itself again, and the phone ends up holding two copies of the same
300 MB with nothing able to say so. Coverage is counted in SHOPS — "9 of these
62 are outside the map you saved" is something a salesman can act on, and "83%
of the bounding box" is not — and PARTIAL is a real answer that is never
rounded to either end. Rounding up draws a map with a blank corner and no
explanation; rounding down hides a map that would have worked for most of what
he needs.

**Saving again replaces, and the old pack goes AFTER the new one lands.** The
grown area is a superset, so nothing is lost by dropping the old one, and
MapLibre shares resources between packs and frees a tile only when no pack
still wants it — so an overlapping download costs the new tiles and not the
old ones again. Deleting first is the version that loses a salesman his
working map for the twenty minutes the new download takes, on the day he is
standing in the market it covers.

**Nothing here deletes anything on its own.** Not a pack for an area that has
left his book, not one that has gone stale, not one that failed half-way. Each
is listed with what it is and a way to remove it: the storage is his, and
taking back three hundred megabytes unasked is the kind of helpfulness nobody
thanks you for. "Old" is a nudge and never an expiry — refreshing re-checks
each tile against the server and fetches only what changed, which is why it is
worth offering at all.

**And the map screen says which of four things is true, rather than drawing a
grey rectangle.** No key, no pinned shops, covered, or offline with nothing
saved for here — and only the last is new. Where an area is covered the map
draws exactly as it does in the office and the signal is irrelevant; where it
is partly covered it draws and says how many shops fall outside; where there
is no signal and nothing saved it does NOT draw, because the pins would sit on
a blank ground and the thing that is being hidden is that fifteen minutes on
Wi-Fi would have prevented it. That last state carries the link to the screen
that fixes it.

## Testing

`npm run test` runs the engine tests: pure, fast, no database. They pin the
business rules themselves.

`npm run test:integration` runs the six §11 journeys, the Accounts app and the
feedback threads against `mahekone_test` using the real services. Create it
with `npm run test:db` first, and again after any schema change. The runner
refuses to start against a database not named `mahekone_test`, and truncates
between tests.

Integration tests sign in through `setTestUser()`, a seam in `lib/auth.ts`
that only exists under `NODE_ENV=test`. Everything downstream — scope,
capabilities, audit — is the real thing.

## React Compiler

The React Compiler lint rules are on and the build is clean. Two consequences:

- **Do not reset state in an effect when a prop changes.** Give the component a
  `key` and let it remount with fresh initial state. Every modal and drawer here
  does this; see `ConfirmDialog` and `CallPanel`.
- **Do not read the clock during render.** `Date.now()` and `new Date()` are
  impure. Read the clock in a server component via `nowMs()` and pass the value
  down as a prop.

## Adding the next MahekOne app

Every app already has a login, an entry on the launcher, access control,
attendance and a switcher — only its own screens are missing. To build one:

1. Add its tables to `src/db/schema.ts` — same file, same database. Reference
   `customers` and `users` directly rather than copying them.
2. Flip `built: true` on its entry in `src/lib/apps.ts`, and point `href` at its
   first real screen.
3. Replace `src/app/<app>/page.tsx` (currently an `AppPlaceholder`) with the app
   itself. Gate its layout on `listUserApps()` the way `src/app/crm/layout.tsx`
   does.
4. Give it a launcher count and status line in `launcherApps()` so its tile says
   what is waiting inside — and make the badge count the same thing the sentence
   describes.
5. Reads go in `lib/queries.ts`, writes in a new `lib/actions/<app>.ts`.

Nothing about the CRM is private to it, so nothing has to be duplicated or
synced later.
