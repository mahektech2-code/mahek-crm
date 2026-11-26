# Places tree and territory

<!-- Moved verbatim out of AGENTS.md so it loads only when needed. Read AGENTS.md first. -->

**WHERE A SHOP IS, IS READ OFF THE BOOK RATHER THAN TYPED INTO IT.**
`customers.city` is what the sheet says, and on the real book that is 1,165
distinct strings across 5,925 shops — 675 naming exactly one shop, 355 carrying
a comma because whole postal addresses were dropped into the column, and the
ordinary duplicates beside them: bhiwendi 55 and bhiwandi 49, bhubaneshwar 71
and bhubaneswar 39, "jabalpur, madhya pradesh, india" 78 sitting apart from
plain Jabalpur. `beat`, `area` and `territory_region` are empty on every one of
those rows and always have been. So a journey is proposed by typing into a box
against a flat datalist, a territory is allocated by comparing that same text,
and there has never been a third rung to allocate an area with.

**No rule over those strings can produce a hierarchy** — the city is the first
comma-separated field in one row and the sixth in the next, and stripping at
the comma takes 1,165 distinct values to 1,078, which is a rounding error with
somebody's afternoon spent on it. What produces one is the COORDINATE: 4,930 of
these shops carry a pin somebody stood on, and a reverse geocode answers with
the administrative tree the shop is actually in — `administrative_area_level_1`
the state, `_2` the district, `locality` the city, `sublocality` the area.

**THE DISTRICT AND THE CITY ARE TWO RUNGS though they are often one word.**
Where they differ they differ enormously: this book carries Kandivali,
Dombivali, Mira Road and Nalasopara as separate cities with 37 to 92 shops each
and one district above all four. A territory is allocated in districts and a
day is walked in cities, and neither rung can do the other's job.

**AND `customers.city` IS NOT CLEANED, because it cannot be.** Two projections
rewrite `city` and `region` from the sheet on every pass and neither is
decision-guarded the way the manager seats are, so a corrected row is gone
within half an hour — the `sales_person_name` failure this file already
records, where holding the id and letting the name revert was the worst outcome
available, and the reason `india-states.ts` normalises on read instead. The
resolution is a DERIVED CACHE beside those columns: four ids on `customers`,
rebuilt by `resolvePlaces()`, and nothing here replaces a column.

**THREE PASSES, THREE COSTS, and only the first one spends anything.**
`lookupPlaces` asks Ola and writes only `customer_place_lookups`;
`proposePlaces` reads those and builds the tree it WOULD write, writing
nothing; `resolvePlaces` writes the master and the ids. It is the sheet jobs'
own split — sync, project, reparse — and the middle pass exists because a place
master is what every territory and every journey gets picked from afterwards:
a wrong node is not a row somebody notices, it is a shop that quietly stops
appearing on a list.

**A CHANGED READING COSTS NOTHING, which is what the lookup table buys.** The
raw answer is kept per shop, so improving `parsePlace` means re-running the
third pass rather than re-spending 4,930 requests. Without it this would be the
Taken Order tab again, where a hash-driven sync re-read nothing when the rule
changed and 294 rows stayed muted on the strength of a decision already
reversed in the code.

**IT GOES THROUGH `olaGet`, and here that matters more than anywhere.** This is
by far the largest single spend MahekOne has ever asked of the key pool, and
going round it with a bare `readSecret` would mean a run that dies half-way
with four unused accounts configured and nothing recording why.

**A TREE CANNOT HAVE A HOLE IN IT.** Ola answers rural coordinates with a state
and a district and no locality, and a sublocality arriving under that hole
would have to hang from the district — a rung it is not the child of, and every
count above it would then be counting two different things. The chain ends
where the answer does. A missing rung is never filled in from the one above it
either: "the area is Nagpur" invented from the city is a statement nobody made,
and `neighborhood` is not read as a second-choice sublocality, because it is a
finer grain and promoting it would put two rungs in one column.

**NULL IS THE HONEST ANSWER, and it is counted rather than hidden.** A shop
with no pin resolves to nothing; forcing it into the state its typed text
happens to name would put a guess in a column every screen reads as a fact. The
proposal reports the unresolved by cause — never asked, asked and unanswered —
the same rule `statelessShops` already follows.

**AND A ROW SOMEBODY DECIDED IS LEFT ALONE.** `place_decided_at` is the third
mark of its kind after `orders.approvedAt` and `customers.amDecidedAt`, and it
guards the same thing: a job that runs unattended must not undo a person's
decision. It is separate from `place_source` because they answer different
questions — the source says how to READ the figure, the mark says whether
anything may TOUCH it, which is the split `bills.paymentPosition` and
`bills.paymentDecidedAt` already keep.

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

**A SHOP HE CREATED STAYS IN HIS BOOK.** A field-created shop arrived with
whatever town he typed and no state, so under a state or city allocation it
matched nothing, fell out of `bookIds`, and the handset's reconcile deleted it
thirty seconds after he made it — orders still pointing at it.
`handleCustomerCreate` files it under a state the way `placeNewLead` files a
lead, and `customerIdsInScope` keeps the creator's own `mbos` shops in his book
whatever their address: a narrowing, never a permission, so no sight widens.

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

**A LEAD IS RAISED INSIDE THE SALESMAN'S OWN AREA, and that is Mahek's rule.**
`placeNewLead` in `lib/territory-rules.ts` states it as "the lead must land in
his book", because the two are one fact: a lead accepted outside the area is
one its own author can never open. `handleLead` refuses a create that fails it
and names his areas in the sentence; the handset's lead form offers only his
areas as an Area picker (`engines/lead-areas.ts`), so the refusal is what an
older build meets rather than what a current one is ever shown. A manager or
admin whom nothing narrows is not refused — `territoryExempt` is the one
definition the book, the handset's territory state and this gate all read.

**And it is filed under a STATE, or it lands nowhere.** Every allocated city
carries its state as a parent and `territoryClause` ANDs the two, so a lead
saved with a town and no state matched no territory at all — every lead ever
raised on a handset was on nobody's Customers tab, its author's included. The
state is the phone's pick, else the allocated city's parent, else what the
book most often files that town under, else his only state; one that none of
those can resolve is refused rather than guessed.

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

**THE SAME TREE NARROWS THE LEADS LIST, and it is the same CLAUSE underneath.**
A manager asking for Nagpur and a salesman allocated Nagpur are asking one
question, so the Where filter on the leads list and the board hands its picks
to `territoryClause` rather than writing a second reading of the same columns.
That matters because the sheet spells a state twenty-four ways and a city
three, and every one of those folds lives in `territory-rules.ts`: a copy here
would drift the day somebody teaches that file a new spelling, and the half
that drifts would be the filter — a list returning slightly too few rows looks
exactly like a list that worked. `territoryClause` takes a table name for it,
because every territory caller selects `from customers` plain and the leads
list selects `from customers c`.

**A PLACE IS A PATH, and it is ESCAPED before it joins a comma-separated
parameter.** "Nagpur" alone is not an answer — two states can each hold a town
of one name — so `lib/lead-places.ts` carries the branch: `Maharashtra>Nagpur`,
narrowest rung last, matched AND-ed down the branch and OR-ed across branches
exactly as an allocated territory is. It rides on the same `,`-separated URL
parameter every other multi-select here uses, which it can only do because each
path is escaped: 355 of the 1,165 `city` strings on the real book CARRY A
COMMA. Unescaped, one pick becomes eight that must all match, which is a filter
that silently answers nothing. Escaped, it is an ordinary parameter and
`splitFilter`, "Clear all" and "Select everything this filter reaches" go on
working with no special case — which is the point, because a filter needing its
own handling in four places is one that gets forgotten in the fifth.

**THE THIRD RUNG READS `beat` OR `area`, and neither is filled yet.**
`TERRITORY_BEAT_SQL` is the same fall-through `TERRITORY_REGION_SQL` makes one
rung up: both columns are free text the sheet was meant to fill, both are empty
on all 5,926 rows, and which of the two the office eventually types into is not
a distinction anybody filtering a list is making. It moves nothing today and it
is what stops the rung staying empty after somebody fills the other column. A
city with no areas recorded says so in words rather than drawing an empty list,
which on this book is every city.

**THE FILTER BAR IS A BUTTON RATHER THAN A WALL, and there is ONE of it.**
Ten dropdowns drawn side by side wrap onto three rows on a laptop, each
labelled only by the placeholder inside it — so the screen opened with more
filter than table and the first question anybody asked was which of the ten
boxes was which. Ten controls drawn at once is not ten options offered; it is
one option offered ten times, and the ones nobody can find are the ones nobody
uses. `components/leads/filter-bar.tsx` is a search box, one button carrying
how many filters are on, and a removable chip per filter that IS on — because a
narrowing hidden inside a panel is one somebody forgets they set, and then the
table is right and the screen is lying. The list and the stage board share it:
they each had their own copy and the copies had already drifted two filters
apart, so a narrowing offered on one screen simply did not exist on the other.

**AND A BAR OF FOUR BUTTONS IS ONE BUTTON AND A MENU.** The selection bar
appears the moment somebody ticks a box, so four buttons side by side is four
things to read every time. Changing the owner is what a selection is made for
nine times out of ten — moving a departed salesman's book is the whole reason
"select all NNN this filter reaches" exists — so that is the button and the
rest sit behind a named one. `RowMenu` takes a `label` now and draws a named
trigger instead of the `···`, rather than a second popover with its own open
state and its own way of being clipped by a Card's overflow. Archive keeps its
colour INSIDE the menu rather than being promoted out of it: a destructive
control drawn permanently beside a routine one is how it gets pressed.

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

**A TOWN THE TREE DOES NOT KNOW, IN HIS DISTRICT, IS FILED UNDER THE
DISTRICT.** The lead form offers a district as a chip and asks for the town to
be typed, and the tree holds only towns a shop was ever reviewed in — so a
village in the district he was allocated matched no district row and the lead
was refused after the shop, the photograph and the pin were behind it.
`placeNewLead` now answers `filedUnder` (the district's ids) when the tree
could not place the town at all and the district he picked (`district` on the
lead payload; on an older build, his one district in that state) is his.
`handleLead` writes `resolved_state_id` and `resolved_district_id` with
`place_source = 'field'`, which keeps the nightly typed pass (it re-reads only
`sheet` rows) off it while a geocode of the pin may still refine it; nobody
decided it, so `place_decided_at` stays null. The typed town stays in `city`.
A town the tree DOES place in another district is still outside, and two
districts in one state with no district named is still refused rather than
guessed.

**AND NO TERRITORY STILL KEEPS THE SHOPS HE OPENED.** `customerIdsInScope`
short-circuited to `[]` before the creator clause was built, so a salesman with
no area who opened a shop at a counter had it deleted by the reconcile on the
pull that answered the create. With nothing allocated the book is now his own
`mbos`-created shops inside `visible` and nothing else — the rule "no
territory, no book" is unchanged for everything he did not create.
