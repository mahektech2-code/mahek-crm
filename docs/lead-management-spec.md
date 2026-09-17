# Lead Management — the build specification

The funnel's engines, services, actions and schema already exist and are
tested. What does not exist is a place to *work* in them: nine screens sit
behind two module keys, buried in a sidebar built for the field team, and a
person whose whole job is the funnel has no front door. This document is the
front door — the whole information architecture, every screen, every modal,
every field, and every transition between them.

It is a SPECIFICATION, not documentation. Nothing here describes code that
exists unless it says so; every screen is marked **Built**, **Partial** or
**New**, and every screen with nothing behind it says what it is missing
rather than being quietly dropped. Delete this file when the last row of the
build order is struck through.

Section references (§4, §8, §16, §22, §28) are to "Mahek One — Sales Lead
Funnel & Management Rules". The prior contract, `docs/lead-funnel-contract.md`,
settled the data decisions; this settles the surface. Where the two disagree,
that one wins — it is the older decision and the schema was built to it.

---

## 1. The three decisions this rests on

**It lives inside the Sales Dashboard, not in a new app.** `/sales/leads/*`
keeps its routes, `sales.leads` and `sales.samples` keep their keys, and no
`app_id` enum value is added. A new app would have cost an enum migration that
cannot grant itself (a value added to an enum may not be USED in the
transaction that adds it, and drizzle-kit runs every pending migration in one),
a redirect table for every existing bookmark, and a second grant for everybody
who already holds the funnel. The cost of this choice is real and is named
here rather than discovered later: **anybody granted Lead Management is granted
the Sales Dashboard's app shell around it.** `app_module_access` is what makes
that survivable — a lead manager holds the ten lead modules and none of the
salary, GPS or expense ones, and the sidebar draws only what they hold.

**Ten sidebar rows in one collapsible group, and tabs beneath them.** The Sales
sidebar is already 24 destinations in six groups; ten more is already longer
than any group beside it, which is why this one collapses and no other does.
The rest of the workspace's thirty-four screens are TABS inside those ten —
see §3 for where that line falls and what it costs.

**All 34 screens, with the gaps named.** Four of them have no data behind them
today. They are built anyway, each stating in words what it needs — a table, a
job, a decision — because a named gap is a thing somebody can close and a
missing screen is a thing nobody remembers. What they must never do is draw a
plausible empty state that reads as "nothing here today".

---

## 2. What already exists

Read this before writing anything. Most of the work below is composition.

**Engines — pure, no I/O, no clock.**

| File | Exports |
|---|---|
| `lib/engines/lead-ladder.ts` | `LEGACY_LADDER`, `DIRECT_LADDER`, `THIRD_PARTY_LADDER`, `DISTRIBUTOR_LADDER`, `TERMINAL_STAGES`, `ladderFor`, `rungOf`, `nextStage`, `previousStage`, `isTerminal`, `isParked`, `directionOf`, `bandOf`, `promotesToCustomerAt`, `isOnTheBookAt` |
| `lib/engines/lead-gates.ts` | `PROSPECT_CONDITIONS`, `QUALIFICATION_CONDITIONS`, `DISTRIBUTOR_CONDITIONS`, `gateTo`, `gateForNext`, `checklistFor`, `mustDecideSuspect`, `approvalRouteReason`, `ladderVerdicts` |
| `lib/engines/lead-nurture.ts` | `NURTURE_SOURCE_TYPE`, `nurtureKey`, `tasksDueFor`, `chaseOffset`, `sampleChaseDue` |

**Vocabulary — `lib/lead-labels.ts`, pure and client-safe.** `LeadStage` (23
values), `LeadSalesType`, `SampleState` (8 values), `SALES_TYPES`,
`stageLabel`, `stageSentence`, `PROSPECT_REASONS`, `SAMPLE_REASONS`,
`LOST_REASONS`, `OVERRIDE_REASONS`, `labelOf`, `VERIFICATION_QUESTIONS` (§8's
twelve), `VERIFICATION_COLUMNS`, `verificationAnswers`, `verificationVerdict`,
`FEEDBACK_FIELDS` (§16's seven), `sampleStateLabel`, `NURTURE_SEQUENCE` (§13's
fifteen), `COMMUNICATION_ACTIONS` (the eleven), `FIRST_ORDER_QUESTIONS` (the
eight).

**Reads.** `lib/services/lead-service.ts` — `leadRow`, `leadGateInput`,
`leadTransitions`, `leadManagerCallsFor`, `leadRecord`, `evaluateLeadStageMove`,
`applyLeadStageMove`, `leadManagerCandidates`.
`lib/services/lead-console-service.ts` — `canLead`, `verificationQueue`,
`leadFunnel`, `leadsWithoutNextAction`, `appointmentQueue`, `sampleDesk`,
`nurtureSchedule`, `publishedDocuments`, `leadRecord`, `gateInputFor`,
`ladderOf`, `leadTransitions`, `managerCalls`, `leadTimeline`, `leadOrders`,
`leadReceipts`, `leadCommunications`, `handoverCandidates`.
`lib/services/sample-service.ts` — `samplesAwaitingApproval`,
`samplesAwaitingDispatch`, `samplesOverdueInTransit`, `samplesAwaitingReview`,
`sampleFeedbackFor`, `sampleDeskCounts`, `sampleDetail`, `samplesForCustomer`.
`lib/services/lead-conversion-service.ts` — `hasOrderedBefore`,
`conversionColumns`, `recordConversion`, `convertIfNowQualified`,
`convertLeadOnSecondOrder`.
`lib/services/lead-qualification-service.ts` — `lineManagerFor`, `qualifyLead`.

**Writes.** `lib/actions/leads.ts` — `advanceLeadStage`, `setLeadSalesType`,
`saveLeadQualification`, `saveProspectFields`, `setLeadNextAction`,
`decideSuspect`, `assignLeadManager`, `recordLeadValidationCall`,
`recordCommunication`, `askForFirstOrder`.
`lib/actions/lead-samples.ts` — `requestSample`, `decideSample`,
`dispatchSample`, `confirmSampleReceived`, `recordSampleFeedback`,
`cancelSample`.

**Capabilities** — `lead.work`, `lead.verify`, `lead.override`,
`distributor.approve`, `distributor.terms`, `customer.handOver`, narrowed in
one place by `canLead()`.

**Configuration** — `leads.suspectMaxVisits`, `leads.requireNextAction`,
`leads.allowManagerOverride`, `leads.prospectReasons`, `leads.sampleReasons`,
`leads.lostReasons`, `leads.overrideReasons`, `leads.sampleReviewChaseDays`,
`leads.verificationDueDays`, `leads.distributorDiscountApprovalPercent`,
`leads.distributorCreditLimitApprovalPaise`. On the handset side:
`mbos.leads.staleDays`, `archiveDays`, `escalateAfterDays`,
`visitsBeforeDecision`, `maxSuspectVisits`, `validationScript`.

**Schema.** One lead is one `customers` row: `lead_sales_type`,
`lead_stage_since`, `lead_source`, `lead_next_action{,_date,_owner_id,_outcome}`,
`lead_manager_id`, `lead_manager_assigned_at`, `lead_verified_at`,
`lead_verified_by_id`, `lead_monthly_litres`, `lead_competitor`,
`lead_required_product_id`, `lead_decision_maker`, `lead_credit_days_wanted`,
`lead_application`, `lead_qualification` (jsonb), `lead_suspect_decided_at`,
`lead_hold_reason`, `lead_distributor_salesman_id`, `lead_expected_order_date`,
`lead_expected_order_value_paise`, `relationship_owner_id`, `handed_over_at`,
`gps_lat`/`gps_lng`. Tables: `lead_stage_transitions`, `lead_manager_calls`,
`distributor_profiles`, `distributor_salesmen`, `sample_feedback`,
`mbos_samples`, `mbos_approvals`, `mbos_tasks`, `timeline_events`.

**Screens that exist today**, and which module they will become:

| Route | Becomes |
|---|---|
| `/sales/leads` | `sales.leads` — All Leads (1) |
| `/sales/leads/[id]` | screen 24, the record |
| `/sales/leads/verification` | a tab of `sales.lead-qualify` (4), redirected |
| `/sales/leads/nurture` | a tab of `sales.lead-actions` (8), redirected |
| `/sales/leads/no-next-action` | a tab of `sales.lead-actions` (8), redirected |
| `/sales/leads/appointments` | `sales.lead-appointments` (7) |
| `/sales/samples` | `sales.samples` (5) |
| `/sales/samples/desk` | a tab of `sales.samples` (5) |

---

## 3. Ten modules, thirty-four screens

The sidebar's constraint decided this, not the feature's. The Sales sidebar
already carries twenty-four destinations in six groups; Lead Management is
**ten rows in one collapsible group**, which is already longer than any group
beside it. The rest of the workspace is TABS inside those ten.

Where the line falls is the rule `lib/modules.ts` already states: **a module is
a destination that can be GRANTED; a tab is a destination inside one that
cannot.** "Suspect decisions" and "Verification queue" are one job asked of two
populations, so they are two tabs of Qualification and one grant. Splitting
them would have put four near-identical rows in front of somebody scanning for
one, and made "can she work the funnel" a twenty-three-part answer nobody could
hold in their head at the Access screen.

**What that costs, named rather than discovered:** a tab cannot be withheld on
its own, so somebody given Qualification is given all four of its tabs. The ten
were chosen so that is never the wrong answer — each is a job somebody holds
whole — and the two that genuinely *are* separately sensitive are their own
keys rather than folded into a neighbour: **Handovers**, which moves who runs
an account, and **Oversight**, which is the override log and the audit trail.

| # | Module key | Sidebar row | Route | Tabs |
|---|---|---|---|---|
| 1 | `sales.leads` *(exists)* | All Leads | `/sales/leads` | List · Board |
| 2 | `sales.lead-funnel` | Funnel & conversion | `/sales/leads/funnel` | Funnel · Sources · Reasons |
| 3 | `sales.lead-intake` | Intake | `/sales/leads/intake` | Capture · Bulk · Duplicates |
| 4 | `sales.lead-qualify` | Qualification | `/sales/leads/qualify` | Suspect decisions · Verification · Validation · Checklists |
| 5 | `sales.samples` *(exists)* | Samples & trials | `/sales/samples` | All · Desk · Review chases · Trial feedback |
| 6 | `sales.lead-commercial` | Commercial | `/sales/leads/commercial` | Negotiation · Commitments · First orders |
| 7 | `sales.lead-appointments` | Distributor appointments | `/sales/leads/appointments` | — |
| 8 | `sales.lead-actions` | Next actions & nurture | `/sales/leads/actions` | Due · Overdue · Nothing scheduled · Nurture · Communication |
| 9 | `sales.lead-handovers` | Handovers | `/sales/leads/handovers` | — |
| 10 | `sales.lead-oversight` | Oversight | `/sales/leads/oversight` | Overrides · Audit · Thresholds |

Thirty tab-screens, plus four reached from a record rather than from
navigation: the lead record `/sales/leads/[id]`, its transitions
`/sales/leads/[id]/transitions`, one sample `/sales/samples/[id]`, and one
distributor candidate `/sales/leads/appointments/[id]`. **Thirty-four.**

**The group collapses and remembers.** It is the only collapsible group in the
app, because it is the only one long enough to push Commercial, People and
Enablement below the fold for the majority of this app's users, who do not work
the funnel. It opens itself whenever the current route is inside it — a group
that hid the screen somebody is standing on would be furniture rather than
navigation — and what is remembered lives in `localStorage`, wrapped, because
site data can be blocked and the sidebar has to draw correctly with none of it.

**A count is drawn only where something is waiting**, red past five and amber
below, on both levels. The console's own rule, kept: a zero beside a heading
reads as a problem rather than as an empty queue.

## 4. The registry, the guards and the grant

**Two lists, joined by a spelling.** `lib/modules.ts` says what can be granted;
`src/app/sales/leads/lead-nav.ts` (`LEAD_SECTIONS`) says what is drawn and what
its tabs are. Nothing in TypeScript connects them, and both directions fail
silently — a section naming a module that does not exist is a screen nobody can
be refused, and a module nobody drew is a screen nobody can find, which reads
as a feature that was never built. `src/lib/lead-nav.test.ts` pins them: every
section names a real module, every Lead Management module is drawn exactly
once, a section's own href is its first tab's, the module's href and the
section's agree, no two tabs share a route, and the cap of ten fails the build
rather than quietly growing.

**The eight new keys are written out longhand, because the key and the route
disagree.** `sales.lead-funnel` is guarded at `/sales/leads/funnel`. The
`sales()` helper derives the route from the slug and would have produced
`/sales/lead-funnel` — a path that does not exist, matching nothing in
`requireModule` and absent from the href set the sidebar filters on, so all
nine rows would have been drawn for nobody. Same shape as `crm.deactivations`,
for the same reason. `sales.leads` carries `exact: true`, or the workspace root
matches every child of itself and every child is a different module.

**The guard moved down.** `/sales/leads/layout.tsx` used to
`requireModule("sales.leads")`, which was right while everything beneath it was
one module and is wrong now that it is nine. A guard there would refuse
somebody holding Qualification on the strength of a module they were
deliberately not given. Each module folder carries its own layout; the book's
own page carries its check inline, because it is a page rather than a folder.

**Three routes moved and are redirected permanently** in `next.config.ts`:
`/sales/leads/verification` → `/sales/leads/qualify/verification`,
`/sales/leads/nurture` → `/sales/leads/actions/nurture`, and
`/sales/leads/no-next-action` → `/sales/leads/actions/none`. A route is a
bookmark, and the last of those is the one a manager actually sends somebody —
it is §24 made visible.

**`0137_lead_management_modules.sql` is the step that has to be right on deploy
day.** An app grant with no module rows already means every module, so almost
nobody is affected: whoever holds the whole Sales Dashboard reaches all ten the
moment they exist. What needs the migration is a grant somebody deliberately
NARROWED to `sales.leads` — left alone, that person opens the book tomorrow and
the verification queue they used today is gone, with nothing saying why. A
narrowed lead grant is widened to the whole workspace, which is the generous
direction and the correct one here: these ten were one grant yesterday and
nobody has yet had the chance to ask for less. `sales.samples` is deliberately
not a trigger — the sample desk without the book is a coherent thing to hold,
and widening it would hand somebody the whole funnel because a group label
changed.

## 5. The state machine, stated once

Every screen below reads this and none of them restates it.

**Three ladders plus a legacy one.** `ladderFor(salesType)` decides:

- `direct` — suspect → prospect → qualification → sample_trial → sample_received → sample_review → negotiation → first_order → delivery → payment → second_order → customer
- `third_party` — the same, minus `sample_received`
- `distributor` — suspect → prospect → qualification → management_review → commercial_discussion → distributor_approval → distributor_agreement → initial_stock_order → active_distributor
- `null` — the six MahekOne shipped with: new → contacted → qualified → negotiation → won → lost. **Nothing backfills a sales type.** Guessing which of three ladders somebody was on is a decision dressed as a migration, and the ladder decides which gates apply.

**Two stages are off every ladder.** `lost` is terminal. `on_hold` is a PARK —
a live prospect that has stopped moving — and it displaces the rung rather than
being one, which is why `bandOf` cannot answer for it and `gateForNext`
refuses. The rung it was parked from is in `lead_stage_transitions`, never in
the stage column. Both demand a reason; `lead_hold_reason` is the one column
for "why is this parked" and "why is this still a Suspect", because they are
the same question.

**Every move is a row.** `lead_stage_transitions` is append-only. A transition
recorded wrongly is corrected by a further transition, never by an edit.

**§28 is the toll.** `gateForNext(input)` returns a `GateVerdict` naming which
conditions are missing. Three callers, one answer: the handset draws the next
rung disabled with the list underneath, the server action refuses on the same
function before it writes, and — from this release — the Qualification desk
shows a manager what a whole book is stuck behind. A second copy typed into a
screen would drift inside one release, and the half that drifts is the half
somebody is reading.

**The override exists so the rule survives contact with a Tuesday.** Behind
`leads.allowManagerOverride`, a manager holding `lead.override` may pass a shut
gate; it demands a code from `leads.overrideReasons` and
`lead_stage_transitions.overridden_conditions` stores exactly what was missing.

**`kind` flips at the FIRST order** — `promotesToCustomerAt()` is the one place
that is decided, and the ladder keeps its own `second_order` and `customer`
rungs. Do not relitigate this on any screen below: the funnel's `customer` rung
is a statement about the relationship, `customers.kind` is a statement about
the ledger, and about thirty readers depend on the second.

**A commitment is not an order.** `lead_expected_order_date` and
`lead_expected_order_value_paise` are a forecast. `askForFirstOrder` records
what was actually agreed. Screens 17 and 18 exist precisely to keep the two
apart, and no figure on 17 may ever be added to a figure on 18.

---

## 6. The 34 screens

> **The routes below are AS BUILT.** The per-screen entries that follow were
> written against the 23-module draft and still name its pre-consolidation
> paths (`/sales/leads/suspects`, `/sales/leads/sources`, …). Where the two
> disagree, this table is right — it was generated from the tree.

| # | Route | Module | Tab of |
|---|---|---|---|
| 1 | `/sales/leads` | `sales.leads` | List |
| 2 | `/sales/leads/board` | `sales.leads` | Board |
| 3 | `/sales/leads/funnel` | `sales.lead-funnel` | Funnel |
| 4 | `/sales/leads/funnel/sources` | `sales.lead-funnel` | Sources |
| 5 | `/sales/leads/funnel/reasons` | `sales.lead-funnel` | Reasons |
| 6 | `/sales/leads/intake` | `sales.lead-intake` | Capture |
| 7 | `/sales/leads/intake/bulk` | `sales.lead-intake` | Bulk |
| 8 | `/sales/leads/intake/duplicates` | `sales.lead-intake` | Duplicates |
| 9 | `/sales/leads/qualify` | `sales.lead-qualify` | Suspect decisions |
| 10 | `/sales/leads/qualify/verification` | `sales.lead-qualify` | Verification |
| 11 | `/sales/leads/qualify/validation` | `sales.lead-qualify` | Validation |
| 12 | `/sales/leads/qualify/checklist` | `sales.lead-qualify` | Checklists |
| 13 | `/sales/samples` | `sales.samples` | All samples |
| 14 | `/sales/samples/desk` | `sales.samples` | Desk |
| 15 | `/sales/samples/chases` | `sales.samples` | Review chases |
| 16 | `/sales/samples/feedback` | `sales.samples` | Trial feedback |
| 17 | `/sales/samples/[id]` | `sales.samples` | — (record) |
| 18 | `/sales/leads/commercial` | `sales.lead-commercial` | Negotiation |
| 19 | `/sales/leads/commercial/commitments` | `sales.lead-commercial` | Commitments |
| 20 | `/sales/leads/commercial/first-orders` | `sales.lead-commercial` | First orders |
| 21 | `/sales/leads/appointments` | `sales.lead-appointments` | Queue |
| 22 | `/sales/leads/appointments/[id]` | `sales.lead-appointments` | — (record) |
| 23 | `/sales/leads/actions` | `sales.lead-actions` | Due |
| 24 | `/sales/leads/actions/overdue` | `sales.lead-actions` | Overdue |
| 25 | `/sales/leads/actions/none` | `sales.lead-actions` | Nothing scheduled |
| 26 | `/sales/leads/actions/nurture` | `sales.lead-actions` | Nurture |
| 27 | `/sales/leads/actions/communication` | `sales.lead-actions` | Communication |
| 28 | `/sales/leads/handovers` | `sales.lead-handovers` | — |
| 29 | `/sales/leads/oversight` | `sales.lead-oversight` | Overrides |
| 30 | `/sales/leads/oversight/audit` | `sales.lead-oversight` | Audit |
| 31 | `/sales/leads/oversight/settings` | `sales.lead-oversight` | Thresholds |
| 32 | `/sales/leads/[id]` | `sales.leads` | — (record) |
| 33 | `/sales/leads/[id]/transitions` | `sales.leads` | — (record) |
| 34 | `/sales/leads/[id]/qualify` | `sales.leads` | — (record) |
| 35 | `/sales/leads/[id]/verify` | `sales.leads` | — (record) |

Thirty-five, not thirty-four: the two full-screen forms under the record were
counted as one in the draft and are two routes in the tree.


Each entry: **route** · status · who may open it · what it reads · what it
writes · its modals · its empty state.

### Group 1 — Pipeline

---

**1. All Leads** — `/sales/leads` · **Built**, extended
*Module* `sales.leads` · *Capability* `lead.work` to act, readable to anyone
holding the module.

The book. Already has filters, pagination and an archived view. What this
release adds is the header dropdown above it and four columns the funnel
earned and never surfaced: **Rung** (`stageLabel` + `rungOf` as "4 of 12"),
**Gate** (green tick, or the count of missing conditions from `gateForNext`),
**Next action** (`lead_next_action_date`, muted where past), and **Sales type**
(`salesTypeLabel`, with "Not set" drawn as a real answer rather than a blank,
because a lead with no type is on the legacy ladder and that is a fact about it).

*Reads* the existing list query, plus `gateForNext` per row — computed on the
page, never in SQL, because a second copy of the gate in a query is the thing
§28 exists to prevent.
*Writes* nothing directly; every row opens screen 24.
*Modals* — **Bulk next action** (see M-12), **Bulk reassign lead manager**
(M-13). Both take the FILTERS rather than a tick-list when the selection is a
whole filtered book, and both send the count that was on the screen and refuse
if it no longer matches, the same discipline `assignSalesManager` already keeps.
*Empty* "No leads match these filters" with the widest filter named.

---

**2. Funnel & conversion** — `/sales/leads/funnel` · **New**
*Module* `sales.lead-funnel`

Three funnels side by side, one per ladder, each rung a clickable bar carrying
its count and its median age in that rung. Below them, cohort conversion: of
the leads raised in a window, what became of them, followed forward rather than
divided month by month. A cohort read before its window closes is **unfinished,
not failing** — the count still inside the window is printed in words.

*Reads* `leadFunnel()` (exists, returns `FunnelByType[]` of `FunnelBandCount`),
plus a new `funnelByRung(salesType)` in `lead-console-service` — `bandOf` is
four bands and this screen needs twelve rungs, which is a different question
of the same table. Ages come from `lead_stage_since`.
*Writes* nothing.
*Modals* none — every bar is a link into screen 1 pre-filtered.
*Empty* impossible; a funnel with no leads draws the rungs at zero and says so.

> **Note.** `bandOf` maps every new rung onto one of four bands and there is a
> test walking every enum value through it. This screen must not introduce a
> second mapping — where it needs bands it calls `bandOf`, and where it needs
> rungs it uses the ladder array.

---

**3. Stage board** — `/sales/leads/board` · **New**
*Module* `sales.lead-board`

The same population as screen 1, drawn as columns per rung with a card per
lead — the view somebody uses to see where a book is bunching. Capped at the
first 50 cards per column with the true count in the header, because a column
of four hundred cards is a column nobody reads and a lie about what fits.

**Dragging a card is a stage move and goes through the gate.** It does not
write on drop: it opens M-01 (Advance stage) pre-filled with the target rung,
so the same refusal, the same reason code and the same override path apply. A
board that moved a lead by dragging would be a second door onto
`advanceLeadStage` with none of the conditions attached.

*Reads* the list query grouped by stage; `ladderFor` for column order.
*Writes* `advanceLeadStage` via M-01.
*Empty* per column, muted, "nothing on this rung".

---

**4. Lost & archived** — `/sales/leads/archive` · **New**
*Module* `sales.lead-archive`

Everything terminal: `lost`, `on_hold`, and leads archived by staleness. Three
tabs are wrong here and one list with a "why" column is right — the question
being asked is "what did we lose and why", and the reason code is the answer.
Grouped counts by `LOST_REASONS` code sit above the list, which is what makes
"how many did we lose on credit terms this quarter" answerable without a grep.

**On hold is not lost** and the list says so in every row: a parked lead keeps
`lead_hold_reason` and a **Reopen** action, and a lost one does not. Folding
them into one status is how a real prospect gets archived by the staleness
sweep.

*Reads* a new `lostAndParked(range)` over `customers` + the most recent
`lead_stage_transitions` row carrying the reason.
*Writes* `advanceLeadStage` (reopen, which is a move like any other and is
recorded as one).
*Modals* **M-11 Reopen a parked lead**.
*Empty* "Nothing lost or parked in this window" — and the window is printed.

### Group 2 — Intake

---

**5. Capture a lead** — `/sales/leads/intake` · **New**
*Module* `sales.lead-intake`

The office's own lead-raising form. Today a lead is raised on the handset or
projected from a sheet; somebody at a desk taking a phone call has nowhere to
put it, which is exactly how a lead ends up as a note in somebody's book.

**The sales type is asked first and alone**, because it decides which questions
the rest of the form asks — `SALES_TYPES` with its three hints, which name the
chain ("who ends up holding the invoice") rather than defining the term.

Then: company, contact, phone, city, address, `lead_source` (from screen 6's
list), customer type, and the four Prospect-Conversion fields as *optional*
first captures — monthly litres, competitor, product, application. Optional
because this is a phone call, not a visit; the gate will demand them at the
right rung and demanding them here loses the lead.

*Writes* a new `captureLead` action in `lib/actions/leads.ts` — creates the
`customers` row at `kind = 'lead'`, stage `suspect` (or `new` where no sales
type is chosen), writes `lead_source`, and calls `setLeadNextAction` in the
SAME transaction, because `leads.requireNextAction` is the rule and a lead
raised with nothing owed by anybody is the state §24 exists to prevent.
*Modals* none — it is a page, not a dialog. A form this long in a modal is a
form people abandon.
*Gap* none, but note: `captureLead` does not exist and is the only new write
this whole release needs.

---

**6. Sources & attribution** — `/sales/leads/sources` · **New**
*Module* `sales.lead-sources`

Where business comes from. `lead_source` is free text today, which is why this
screen exists: it lists every distinct value with its count, its conversion
rate by cohort, and the ones that differ by a character. Renaming a source here
rewrites the column across the book in one audited write — the alternative is
that "Website", "website" and "Web site" are three sources for ever.

*Reads* new `leadSources()` — `group by lead_source` with a cohort conversion
per value, built on the same cohort definition screen 2 uses.
*Writes* new `renameLeadSource(from, to)`, audited, manager-only.
*Modals* **M-14 Merge a source**.
*Empty* "No source recorded on any lead" — which is itself the finding.

---

**7. Duplicates & merge** — `/sales/leads/duplicates` · **New — GAP**
*Module* `sales.lead-duplicates`

Two leads for one shop is the ordinary failure of a book fed by a website form,
a handset and a spreadsheet at once. This screen finds them — same phone,
same GSTIN, or a close name in the same city — and offers to merge.

> **This screen has nothing behind it and says so.**
>
> There is no merge path in MahekOne. Merging two `customers` rows means
> deciding what happens to two sets of orders, bills, receipts, visits,
> timeline events, tasks and stage transitions, and at least one of those
> answers is a business decision rather than a technical one: **a merged lead's
> stage history is two histories, and `lead_stage_transitions` is append-only
> by design.** Until that is decided, this screen **detects and reports only** —
> it lists candidate pairs with the evidence, and its action is "Not a
> duplicate" (which suppresses the pair) rather than "Merge".
>
> What it needs: a `customer_merges` table, a decision on history, and a
> `mergeCustomers` action. The screen names all three on the page.

*Reads* new `duplicateCandidates()` — trigram similarity on name within city,
exact match on phone and GSTIN. The trigram extension and its GIN indexes
already exist for product search.
*Writes* new `dismissDuplicatePair(a, b, reason)` only.
*Empty* "No likely duplicates" — the good answer, and worth being able to see.

### Group 3 — Qualify

---

**8. Suspect decisions** — `/sales/leads/suspects` · **New**
*Module* `sales.lead-suspects`

§4's cap, as a worklist. Every lead at `suspect` or `contacted` with its visit
count, sorted by how far past the cap it is. Three states, and the screen draws
them as three: **warned** (`mbos.leads.visitsBeforeDecision` reached),
**must decide** (`mbos.leads.maxSuspectVisits` reached — the visit cannot be
CLOSED without an answer), and **past it** (the manager has been notified).

**The cap asks; it does not refuse.** That is the whole shape of §4 and this
screen must not invent a block: a salesman whose visit is refused stops
recording visits, and the company loses the GPS, the competitor note and the
reason in order to stop a number reaching four.

*Reads* new `suspectDecisions()` — `mustDecideSuspect` per row over a count of
`mbos_visits`, never a cached column.
*Writes* `decideSuspect`.
*Modals* **M-05 Prospect or not a Prospect**.
*Empty* "Nobody is sitting undecided" with the two thresholds printed.

---

**9. Verification queue** — `/sales/leads/verification` · **Built**
*Module* `sales.lead-verification` (new key, existing route) · *Capability*
`lead.verify`

§7/§8. Prospects awaiting a manager's verification call, ageing against
`leads.verificationDueDays`. Already built on `verificationQueue()`.

What this release adds is the **verify-don't-re-ask** discipline the prototype
argued for and this screen has never had: before the twelve questions, the
salesman's own findings are listed, each with **Confirm / Correct / Unable to
verify**, and only *Correct* reveals a value and a reason. Confirm and
Unable-to-verify never touch the stored value.

*Reads* `verificationQueue`, `VERIFICATION_QUESTIONS`, `VERIFICATION_COLUMNS`.
*Writes* `recordLeadValidationCall`.
*Modals* **M-03 Manager verification**.
*Empty* "Nothing waiting on a verification call".

---

**10. Validation calls** — `/sales/leads/validation` · **New**
*Module* `sales.lead-validation`

The other half of §8: not the queue of calls to make, but the **record of calls
made** — every `lead_manager_calls` row, its twelve answers, its verdict, and
crucially the disagreements. `lead_requirement` is what the salesman was told
standing in the shop; `confirmed_requirement` is what the office was told on the
phone, and **the two disagreeing is the single most useful thing this call
produces**. This screen is where that is visible across a book rather than one
record at a time.

It carries the script — `mbos.leads.validationScript`, configuration, because
it is content that will be argued about and improved after a bad call.

*Reads* `leadManagerCallsFor` generalised to a queue: new
`validationCalls(range, filters)`; `verificationAnswers`, `verificationVerdict`.
*Writes* nothing — append-only by nature. A second call is a second row.
*Modals* none; rows expand in place.
*Empty* "No validation calls recorded in this window".

---

**11. Qualification desk** — `/sales/leads/qualification` · **New**
*Module* `sales.lead-qualification` · *Tabs* In qualification · Blocked ·
Ready to advance · Overridden

The §28 screen a manager has never had: every lead at `qualification` with its
checklist state, and — on the Blocked tab — **what each one is stuck behind, in
words**. That list comes from `checklistFor` and `gateForNext`, the same
functions the handset and the action use.

A tick is not an answer where a column exists: four of the twelve conditions
are satisfied by the VALUE, not by the checkbox beside it, and this screen
draws those four differently so a ticked box beside an empty field is visibly
the wrong state rather than an invisible one.

The **Overridden** tab reads `lead_stage_transitions.overridden_conditions` —
who passed a shut gate, on what, with which reason code. That is not a shaming
list; it is how somebody finds out that one condition is shut on everybody and
is the wrong condition.

*Reads* new `qualificationDesk()` — `leadGateInput` per lead + `checklistFor`.
*Writes* `saveLeadQualification`, `advanceLeadStage`.
*Modals* **M-02 Qualification checklist**, **M-01 Advance stage**,
**M-10 Override a gate**.
*Empty* per tab; the Blocked tab empty is a good day and says so.

### Group 4 — Sample & trial

---

**12. Samples** — `/sales/samples` · **Built**
*Module* `sales.samples`

Every sample, every state, one list. Unchanged except that it now draws the
Leads dropdown and links each row to screen 26.

---

**13. Sample desk** — `/sales/samples/desk` · **Built**, extended
*Module* `sales.sample-desk` · *Tabs* Awaiting approval · Awaiting dispatch ·
In transit · Awaiting review

Already built on `sampleDesk()` and the four `sample-service` reads. The tabs
are a filter on one read.

**Three dates, three parties**, and the screen must keep them apart:
`dispatched_at` is us, `delivered_at` is the carrier, `received_at` is the shop.
`received_at` is NEVER defaulted from `delivered_at`.

*Writes* `decideSample`, `dispatchSample`, `confirmSampleReceived`,
`recordSampleFeedback`, `cancelSample`.
*Modals* **M-06 Decide a sample**, **M-07 Dispatch a sample**,
**M-08 Confirm receipt**, **M-09 Record trial feedback**.

---

**14. Review chases** — `/sales/leads/sample-chases` · **New**
*Module* `sales.sample-chases`

§16 does not stop: a sample review is chased on day 2, then 4, then 6
(`leads.sampleReviewChaseDays`), and **the last interval repeats until there is
an answer**, because a trial nobody reviewed is stock given away for nothing.
This screen lists every sample in that loop with `review_chase_count` — "asked
three times" is the number that tells a manager to pick up the phone
themselves.

*Reads* `sampleChaseDue` and `chaseOffset` over `samplesAwaitingReview()`.
*Writes* `recordSampleFeedback` (which closes the loop).
*Modals* **M-09**.
*Empty* "No trial is waiting on an answer".

---

**15. Trial feedback** — `/sales/leads/sample-feedback` · **New**
*Module* `sales.sample-feedback`

§16's seven answers across every trial ever run — quality, performance,
application, drying, the comparison, price, and the open box. "Good" cannot be
read back; this is the screen where "better drying than the incumbent, price is
the problem" becomes a pattern rather than a note on one record.

Filterable by product and by competitor, because the comparison is the whole
point of a trial.

*Reads* new `feedbackLibrary(filters)` over `sample_feedback`; `FEEDBACK_FIELDS`.
*Writes* nothing.
*Empty* "No trial feedback recorded yet".

### Group 5 — Commercial

---

**16. Negotiation desk** — `/sales/leads/negotiation` · **New**
*Module* `sales.lead-negotiation`

Every lead at `negotiation`, with what is blocking it. There is no negotiation
table and this screen does not add one — it reads the stage, the most recent
transition's reason, the lead's own credit-days ask against the standard term,
and any open commitment.

**An order below `negotiation` is refused** — §G, and `handleOrder` already
enforces it. This screen is where a manager sees the queue of conversations
that refusal is protecting.

*Reads* new `negotiationDesk()`.
*Writes* `setLeadNextAction`, `advanceLeadStage`.
*Modals* **M-04 Record a commitment**, **M-12 Set next action**.
*Empty* "Nothing in negotiation".

---

**17. Commitments & forecast** — `/sales/leads/commitments` · **New**
*Module* `sales.lead-commitments` · *Tabs* Open · Due this week · Slipped ·
Converted

`lead_expected_order_date` and `lead_expected_order_value_paise`, as a
forecast board. Every figure on this screen is labelled a forecast and
**no total on it may ever be added to a real order value**. The Slipped tab —
a commitment whose expected date has passed with no order — is the tab that
earns the screen.

*Reads* new `commitments(range)`.
*Writes* `askForFirstOrder`, `setLeadNextAction`.
*Modals* **M-04 Record a commitment**, **M-15 Confirm the actual order**.
*Empty* per tab.

---

**18. First order & conversion** — `/sales/leads/first-orders` · **New**
*Module* `sales.lead-first-orders`

Leads at `first_order` and beyond, through delivery and payment to the second
order. The eight `FIRST_ORDER_QUESTIONS` are asked here, once.

**This screen renders order status; it never writes it.** §20 — `orders.status`
comes from the sheet and from accounts' approval, and a second ladder here
would be overwritten every thirty minutes or would fight the projection into
`sync_conflicts`.

It also carries the one sentence people get wrong: **`kind` flipped at the
first order**, so an account on this screen is already a customer in the
ledger while still climbing the funnel's last three rungs. The screen says so
rather than letting somebody discover it.

*Reads* `leadOrders`, `leadReceipts`, `hasOrderedBefore`, `promotesToCustomerAt`.
*Writes* `askForFirstOrder`, `advanceLeadStage`.
*Modals* **M-15**, **M-01**.

---

**19. Distributor appointments** — `/sales/leads/appointments` · **Built**
*Module* `sales.lead-appointments` (new key, existing route) · *Capability*
`distributor.approve` to decide, `distributor.terms` to change terms

§12's two-step chain: `stepIndex` 0 is the sales manager, 1 is management.
What forces the second step is NAMED rather than judged — exclusivity always, a
discount above `leads.distributorDiscountApprovalPercent`, a credit limit above
`leads.distributorCreditLimitApprovalPaise` — and `approvalRouteReason()` is
the one place that is decided.

*Reads* `appointmentQueue()`, `approvalRouteReason`.
*Writes* the existing approvals path.
*Modals* **M-16 Decide an appointment**.

### Group 6 — Work

---

**20. Next actions** — `/sales/leads/actions` · **Partial** (absorbs
`/sales/leads/no-next-action`) · *Module* `sales.lead-actions` ·
*Tabs* Due today · Overdue · No next action · Mine

§24: an active lead may not sit with nothing owed by anybody. Four answers, not
a date — the action, the day, the person, and what that person is expected to
come back with. The **No next action** tab is the existing screen, kept whole
as a tab because it is the same question asked at zero.

*Reads* `leadsWithoutNextAction()` plus a new `nextActionsDue(range, owner)`.
*Writes* `setLeadNextAction`.
*Modals* **M-12 Set next action**.
*Empty* "Every active lead has a next action" — the sentence that means the
rule is holding.

---

**21. Nurture schedule** — `/sales/leads/nurture` · **Built**
*Module* `sales.lead-nurture` (new key, existing route)

§13's fifteen rows. `NURTURE_SEQUENCE` names the trigger, the delay, the owner
and the sentence; `tasksDueFor` turns an event into the tasks that should
exist, keyed on `sourceType`/`sourceId` so a second pass raises nothing twice.
**Owner matters** — the salesman and the lead manager are chased for different
things about the same lead, and one list would read as one person being nagged
twice. The screen keeps them in two columns.

*Reads* `nurtureSchedule()`.
*Writes* nothing directly; tasks are raised by the nightly pass.

---

**22. Communication log** — `/sales/leads/communication` · **New**
*Module* `sales.lead-comms`

The eleven `COMMUNICATION_ACTIONS`, across the book: who sent a profile, a
brochure, a price list, a video; who made a negotiation call; who asked for the
first order. One tap logs one, and the row lands on the customer's timeline.

**Every timeline kind is a constant.** `CRM_EVENT`/`MBOS_EVENT` in
`lib/timeline.ts` are the whole vocabulary, and `timeline-coverage.test.ts`
reads the source and fails on a bare string. Nothing on this screen may write a
literal.

*Reads* `leadCommunications()` generalised to a book-wide query;
`publishedDocuments()` for what is actually sendable.
*Writes* `recordCommunication`.
*Modals* **M-17 Log a communication**.
*Empty* "Nothing sent to anybody yet".

### Group 7 — Oversight

---

**23. Handovers** — `/sales/leads/handovers` · **New**
*Module* `sales.lead-handovers` · *Capability* `customer.handOver`

§Q's fifth seat. `relationship_owner_id` answers who RUNS the account;
`customers.kind` answers what it IS, and nothing derives one from the other.
This screen is the list a flag would have been: **converted, and
`handed_over_at` still null** — derived, never stored, because the only facts a
flag could be rebuilt from are the two columns it would be caching.

It says in a line what a handover moves and what it does not: it moves SIGHT
(`scopedToUsers`, `assertCustomerInScope`) and deliberately not a rupee — not
`ASSIGNED_TO_SQL`, not `sales_am_id`, not a target.

*Reads* new `outstandingHandovers()`; `handoverCandidates()`.
*Writes* the existing handover action behind the existing panel.
*Modals* **M-18 Hand over an account**.
*Empty* "Every converted account has an owner".

### Screens 24–34 — reached from the above, not from the dropdown

---

**24. Lead record** — `/sales/leads/[id]` · **Built**, extended

The one page everything links to. Header with the five seats, the ladder
tracker (`ladderOf`, `rungOf`), the next-action strip with its four fields and
its distinct **missing** state, and a right rail carrying `gateForNext`'s
verdict — the next rung, enabled or disabled with the missing conditions named
underneath.

Ten tabs, each a module's worth of this record: Overview · Qualification ·
Verification · Samples · Negotiation · Orders & payment · Communication ·
Nurture · Transitions · Timeline. A distributor lead swaps Samples and
Negotiation for **Distributor profile** and **Approval**.

It is a **fixed-length page**: every panel the same height, scrolling inside
itself, every read capped, the timeline paged with a keyset and a tiebreaker
(`at desc, id desc`). The customer record already learned this the hard way.

*Modals* all of M-01 … M-12 are reachable here.

---

**25. Stage transitions** — `/sales/leads/[id]/transitions` · **New**

§25's timeline at full depth: every `lead_stage_transitions` row joined to the
manager's calls, the samples, the orders and the receipts. Append-only, and the
screen says so — there is no edit control anywhere on it.

*Reads* `leadTransitions`, `managerCalls`, `leadTimeline`.

---

**26. Sample record** — `/sales/samples/[id]` · **New**

One sample end to end: the six states, the three dates with the party that
asserted each, the chase count, the seven feedback fields, and the reason a
rejection carried. A rejected sample has to say why — the same rule as a lost
lead, for the same reason.

*Reads* `sampleDetail`, `sampleFeedbackFor`.

---

**27. Override log** — `/sales/leads/overrides` · **New**
Reached from screen 11's Overridden tab. Every gate passed, what was missing,
who passed it and the reason code — countable, because the reason is a code.

---

**28. Lead audit trail** — `/sales/leads/audit` · **New**
Every audited action in the funnel, with `actor_role` AND `actor_app` — the
second column is what tells the ledger desk from the phones now that
`associate` says neither.

---

**29. Lead settings** — `/sales/leads/settings` · **New**
The eleven `leads.*` keys and the six `mbos.leads.*` ones, READ-ONLY, each with
its current value, who last changed it and a link to the Admin Console. A
second door onto configuration is how two screens come to disagree about a
threshold.

---

**30. Reason-code analytics** — `/sales/leads/reasons` · **New**
The four coded lists — prospect, sample, lost, override — counted over a
window, by salesman and by city. This is the payoff for storing codes rather
than labels, and it is the screen that answers "how many did we lose on credit
terms this quarter".

---

**31. Qualification checklist (full screen)** — `/sales/leads/[id]/qualify` · **New**
The modal at full size, for the twelve-condition case where a modal is a
scroll. Same component, same action.

---

**32. Verification (full screen)** — `/sales/leads/[id]/verify` · **New**
As above for §8's twelve questions plus the confirm/correct rows.

---

**33. Appointment record** — `/sales/leads/appointments/[id]` · **New**
One distributor candidate: `distributor_profiles`, the requested terms, the
named escalation reason, both approval steps with their decider and note, and
`distributor_salesmen` — the distributor's own people, who have no MahekOne
login and never will.

---

**34. Bulk intake** — `/sales/leads/intake/bulk` · **New — PARTIAL**
A CSV of leads, validated and previewed before anything is written, modelled on
`/crm/customers/import`. **It never sets `active_in_order_system`** — `0021`
cleared what an import last wrote to that column after it muted the entire book
— and it never sets `owner_id` to whoever ran the import, because on a thousand
rows that reads as one person's book on every scoped list. Unassigned is said
in words; a false owner is not said at all.

> *Gap*: the preview and validation are real; the commit path needs
> `captureLead` (screen 5) to exist first and to accept a batch.

---

## 7. The modal catalogue

Eighteen modals. Every one states the rule it is enforcing in its subtitle,
because a refusal that does not say what it wants teaches somebody to press the
button again rather than to do the work.

**Rules that apply to all of them.** Every field that produces a stored reason
is a CODE from configuration, never a typed label. Every destructive or
irreversible action is confirmed in words, never on a stray click. No modal
validates only on the client — the action re-checks, because a server action is
a URL and a hidden control is not a permission. Every modal is keyed so it
remounts with fresh state rather than resetting state in an effect (the React
Compiler rules are on).

---

**M-01 · Advance stage** — from screens 3, 11, 18, 24
- *Sub*: the rung being entered, and what §28 asks of it
- **Target rung** — `nextStage` by default; a manager may pick any rung on the ladder, and moving DOWN is recorded as a move rather than refused
- **Verdict panel** (read-only) — `gateForNext`'s missing conditions, in words
- **Reason** — required on any move that is not straight up the ladder
- **Override** — drawn only when the gate is shut, only for `lead.override`, only when `leads.allowManagerOverride` is on. Requires a code from `leads.overrideReasons`. Stores `overridden_conditions`.
- *Writes* `advanceLeadStage`

**M-02 · Qualification checklist** — screens 11, 24, 31
- The twelve conditions from `checklistFor`, each a tick
- **The four value-backed conditions render their field inline** — monthly requirement, potential, product, competitor. A tick beside an empty field is refused at the save, not merely discouraged.
- **Note to the salesman** — optional
- *Manager variant*: read-only checklist, four footer actions — Close · Request clarification · Mark incomplete · Verify (disabled until all twelve)
- *Writes* `saveLeadQualification`

**M-03 · Manager verification (§8)** — screens 9, 24, 32
- **Salesman findings**, read-only, then per field: **Confirm** / **Correct** / **Unable to verify**. Only *Correct* reveals `Corrected value` + `Reason`. Confirm and Unable-to-verify never write.
- **The twelve questions** from `VERIFICATION_QUESTIONS`, answered into `VERIFICATION_COLUMNS`
- **Verdict** — verified · verified with corrections · follow-up required · verification failed
- **No default verdict.** The prototype pre-selected "Verified" and every yes/no answer as yes; a manager who clicks through then produces a clean verification without answering anything. Nothing here is pre-selected.
- *Writes* `recordLeadValidationCall`

**M-04 · Record a commitment** — screens 16, 17, 24
- *Sub*: "a forecast, not a sale — confirming the actual order is a separate step"
- **Expected quantity** (cans) · **Expected value** (₹, stored paise) · **Expected order date** · **Blocker** (coded, from `LOST_REASONS`, plus "no blocker")
- *Writes* `lead_expected_order_*` via `setLeadNextAction`'s transaction

**M-05 · Prospect or not a Prospect (§4)** — screen 8
- **Decision** — Prospect / Not a Prospect / Still a Suspect
- **Reason** — coded: `PROSPECT_REASONS` on yes, `LOST_REASONS` on no, `lead_hold_reason` on "still a suspect" (which is the answer that asks why)
- *Writes* `decideSuspect`

**M-06 · Decide a sample** — screen 13
- **Approve / Reject** · **Reason** (required on reject — the next sample goes out exactly the same otherwise) · **Quantity approved** · **Note**
- *Writes* `decideSample`

**M-07 · Dispatch a sample** — screen 13
- **Courier** · **Tracking** · **Dispatched on** · **Expected delivery**
- *Writes* `dispatchSample`

**M-08 · Confirm receipt** — screen 13
- **Received on** — *the shop's word.* The modal says in one line that this is not the delivery date and must not be copied from it.
- *Writes* `confirmSampleReceived`; the review task is dated from HERE, never from dispatch

**M-09 · Record trial feedback (§16)** — screens 13, 14, 24, 26
- The seven `FEEDBACK_FIELDS` · **Outcome**: approved · more testing required · rejected
- **Reject requires a reason.** Stated before the button is pressed.
- *Writes* `recordSampleFeedback`. An approved verdict opens negotiation — `afterSampleVerdict` — which is the gate `handleOrder` requires, so the gate and the thing that opens it are one mechanism.

**M-10 · Override a gate** — screen 11, and inline in M-01
- Read-only list of what is missing · **Reason** (coded) · typed confirmation
- *Writes* through `advanceLeadStage`

**M-11 · Reopen a parked lead** — screen 4
- **Rung to return to** — defaults to the rung in the most recent transition, never guessed from the stage column
- **Reason**
- *Writes* `advanceLeadStage`

**M-12 · Set next action (§24)** — screens 1, 16, 20, 24
- **What happens next** · **Date** · **Responsible person** · **What they are expected to come back with**
- All four required where `leads.requireNextAction` is on
- *Bulk variant*: takes the filters, prints them back in words, and refuses if the count has changed
- *Writes* `setLeadNextAction`

**M-13 · Assign a lead manager** — screens 1, 24
- **Lead manager** from `leadManagerCandidates(region)` · **Reason**
- One line of copy: this fills the coordinating seat and **does not move the book** — `ASSIGNED_TO_SQL` does not read it.
- *Writes* `assignLeadManager`

**M-14 · Merge a source** — screen 6
- **From** (read-only) · **To** · the affected count · typed confirmation
- *Writes* `renameLeadSource`

**M-15 · Confirm the actual order** — screens 17, 18
- Quotes the commitment back first, labelled a forecast
- **Product** · **Quantity** (cans) · **Value** (₹) · **Reference / PO**
- *Writes* `askForFirstOrder`

**M-16 · Decide an appointment (§12)** — screen 19
- Profile and requested terms, read-only · **the named escalation reason** from `approvalRouteReason` · **Approve / Send back / Decline** · **Note**
- Step 1 needs `distributor.approve`; changing terms needs `distributor.terms`

**M-17 · Log a communication** — screens 22, 24
- **Action** — one of the eleven `COMMUNICATION_ACTIONS` · **Document** where one applies, from `publishedDocuments()` · **Note**
- *Writes* `recordCommunication`

**M-18 · Hand over an account (§Q)** — screen 23
- **New relationship owner** from `handoverCandidates()` · **Reason**
- States what does not move: `sales_am_id`, `owner_id`, `kind`, `am_decided_at`
- *Writes* the existing handover action

---

## 8. The flows, end to end

**Direct customer, the happy path.** Capture (5) → suspect decisions (8) →
M-05 Prospect → verification queue (9) → M-03 verified → qualification desk
(11) → M-02 twelve conditions → M-01 to `sample_trial` → sample desk (13) →
M-06 approve → M-07 dispatch → M-08 receipt → review chases (14) → M-09
approved → negotiation desk (16) → M-04 commitment → commitments (17) → M-15
actual order → first orders (18) → delivery → payment → second order →
`customer` rung. `kind` flipped at the first order, four rungs earlier.

**Distributor appointment.** Capture with type `distributor` → suspect →
prospect → qualification (`DISTRIBUTOR_CONDITIONS`, not the twelve) →
`management_review` → appointments (19) → M-16 step 0 → escalation reason named
→ M-16 step 1 → `commercial_discussion` → `distributor_approval` (billable from
here) → `distributor_agreement` → `initial_stock_order` → `active_distributor`.

**Third-party shop.** As direct, minus `sample_received`. The record carries
the relationship chain — shop → distributor salesman → distributor → Mahek —
and the invoice stays with the distributor.

**A lead that stalls.** Any rung → M-01 to `on_hold` with a reason → archive
(4) → M-11 reopen to the rung in the transitions, not to the stage column.

**A lead that dies.** Any rung → M-01 to `lost` with a coded reason → archive
(4) → counted on reasons (30). Never deleted.

**A gate that will not open.** Qualification desk (11) Blocked tab → the
missing conditions in words → either the work is done, or M-10 with a reason,
recorded on the transition and visible on overrides (27).

**A lead nobody owns.** Next actions (20), No-next-action tab → M-12 → the rule
holds again.

**A converted account nobody runs.** Handovers (23) → M-18 → sight moves,
money does not.

---

## 9. Every gap, named

| # | Screen | What is missing | What it does instead |
|---|---|---|---|
| 7 | Duplicates & merge | `customer_merges`, a decision on merging two append-only histories, `mergeCustomers` | Detects and reports pairs; the only action is "Not a duplicate" |
| 34 | Bulk intake | `captureLead` must exist and accept a batch | Validates and previews; the commit is disabled with the reason on the button |
| 3 | Stage board | nothing | — |
| 5 | Capture a lead | `captureLead`, the one genuinely new write | — |
| 6 | Sources | `lead_source` is free text | The screen is the cleanup tool for exactly that |
| — | Lead map | half the book has no `gps_lat`; needs `olamaps.apiKey` | **Deliberately not a module.** A map that silently omits a third of the book is one somebody plans a day from and is wrong. It belongs on Territory, which already draws shops and already says what has no pin. |

---

## 10. Build order

1. `lead-nav.ts` + `LeadNav` + the 21 module keys + the grant migration. Nothing else ships until an existing holder of `sales.leads` still sees all three of their screens.
2. Redirect `/sales/leads/no-next-action` → `/sales/leads/actions?tab=none` in `next.config.ts`. A slug lives in bookmarks.
3. The screens with services already behind them: 2, 4, 8, 10, 11, 14, 15, 16, 17, 18, 20, 22, 23, 25, 26, 27, 28, 29, 30.
4. `captureLead`, then 5, then 34.
5. 3, 6, 7, 31, 32, 33.
6. Extend 1, 9, 13, 24.

## 11. Tests this must carry

- `lead-nav.test.ts` — every entry in `LEAD_MODULES` has a module in `APP_MODULES`, and every `sales.lead*` module is in `LEAD_MODULES`. A nav item with no module is a screen nobody can be refused; a module with no nav item is a screen nobody can find.
- A migration test asserting every grant narrowed to `sales.leads` before the migration holds all 23 after it.
- `lead-gates` coverage is already there; assert no screen re-derives a verdict — a grep test for `checklistFor`/`gateForNext` being the only producers, beside the three that already guard the timezone rules.
- An integration journey per flow in §8, against `mahekone_test`.
- The existing `bandOf` enum walk stays green — screen 2 must not add a second mapping.
