# Travel & Expense — implementation plan

The client's 75 numbered requirements, checked against what MahekOne already
has, turned into a build. Read §0 first: a third of the brief is already
built under a different name, and one requirement cannot be met at all with
the data we hold today.

Scope: the **MBOS handset** (`mbos-app/`), the **Sales Dashboard**
(`src/app/sales`, which is what the brief calls the MBOS Manager Dashboard),
the **Admin Console** (`src/app/admin`, where a policy is authored), and the
**Reports app** (`src/app/reports`, the owner's screens).

---

## 0. What exists today, and what it is not

| Thing | Where | What it actually is |
|---|---|---|
| Expense claim | `mbos_expenses`, `mbos_expense_claims` | A flat row: date, one of four categories, an amount, an optional bill photo. Nothing else. |
| Caps | `mbos.expenses.categoryCapsPaise` in `app_settings` | **One** current value per category, company-wide, no version, no dates, no grade, no city. |
| Approval | `mbos_approvals` | One table for all six MBOS approval kinds. Subject state is DERIVED from it. Already has `approvedAmountPaise` and `partially_approved`. |
| Handset entry | `mbos-app/app/expenses.tsx` | Category, amount, date, note, bill photo. Shows headroom against the cap. |
| Manager screen | `src/app/sales/expenses/page.tsx` | Waiting / decided list, month-to-date against cap, "no bill" banner, approve/part-approve/refuse. |
| GPS trail | `mbos_positions` | A fix every `mbos.location.trailKeepEverySeconds` (default 3) while checked in. |
| Per-activity fix | `mbos_activity_locations` | One row per MBOS write — where each order, payment, visit was done. |
| Visits | `mbos_visits` | Check-in/check-out coordinates and times, `distanceFromShopM`, customer link. |
| Salary | HRMS mirror of the employee workbook, read via `payForPeriod()` | Read-only. Payroll publishes it; nothing here writes pay. |

**What does not exist anywhere in the codebase:** travel legs, travel modes,
KM of any kind, odometer readings, food allowance rules, hotel limits, policy
versions, effective dates, per-grade or per-city rules, claimed-vs-eligible,
exceptions, duplicate detection, EOD expense lock, and every ROI/COCA figure.
`grep -ri odometer src mbos-app` returns nothing. So roughly 55 of the 75
requirements are new build, and the 20 that exist all need reshaping.

### The one requirement we cannot meet as written

**#61 Salesman ROI and #64 Customer ROI ask for "contribution".** Contribution
is margin, and MahekOne holds **no prices and no costs at all** —
`products.priceSource` is `unset` and `canValueOrders()` answers no by design,
precisely so that no screen shows a confident wrong figure. Order value is
what was billed, not what it earned.

So ROI will be built and shipped against **net revenue**, not margin, and
every screen will say so in words. The moment a cost or margin source exists
(a price list, or a margin % per formulation), the engine takes one more
argument and the same screens become true ROI. This must be said to the
client rather than papered over — a made-up margin on the owner's dashboard
is the single most expensive wrong number in the product.

Related, smaller: **#71 "AI alerts"** — see §6.4. The alerts are computed by
a deterministic engine and only *narrated* by a model. A model must never be
the thing that decides money is suspicious.

---

## 1. Five architectural decisions

### 1.1 A policy is DATA with versions, not `app_settings`

`app_settings` is the wrong home and requirement 6 is what kills it: it holds
one current value per key with no history, so raising ₹/km from 3.50 to 4.00
would silently restate every expense ever claimed. Same for 5 (version +
effective dates), 7 (per grade), 8 (per city) and 4 (draft until published).

New tables — `expense_policies`, `expense_policy_rules`,
`expense_grades`, `expense_grade_map`, `expense_city_classes`. The uploaded
PDF, Excel or Word file stays attached to the version as the source of record.

**A published policy version is IMMUTABLE.** A change is a new version with a
new effective-from date; the old one gets an effective-to. That is what makes
requirement 6 fall out for free rather than being enforced by a rule somebody
has to remember: re-deriving an old expense re-reads a row nothing can edit,
so it can only ever produce the same answer.

`mbos.expenses.*` in the config registry is not deleted — it becomes the
**fallback when no policy covers a date**. `0086` reads today's stored settings
and writes them into version 1, so that when Phase 1 starts reading policies
the numbers are already the numbers that were in force — the same discipline
`0042_day_boundary_midnight` and `0051` follow, falling back to the registry
defaults where a deployment never touched the settings screen.

It leaves that version a **draft**. Requirement 4 says a policy is verified by
an authorised person before it goes live, and a migration is not a person.

### 1.2 The rule vocabulary is CLOSED, not an expression language

Requirement 3 says an admin changes rates without a developer. The tempting
reading is a formula box. That would be a second programming language inside
MahekOne — unreviewable, untestable, and one typo away from paying everybody
nothing. Instead there is a fixed set of **typed rule kinds**, each with its
own form, its own validation and its own engine branch:

| Rule kind | Answers | Requirements |
|---|---|---|
| `per_km` | mode → ₹/km, optional daily KM cap, optional slabs | 9, 10 |
| `actuals` | mode/category → cap per instance and per day, proof required? | 11, 12, 13, 37 |
| `zero_rated` | mode → always ₹0, still recorded | 14, 15 |
| `km_source` | which KM is authoritative, and the variance that flags | 17, 18, 19 |
| `odometer_photo` | always / random at N% / on variance over X% | 20 |
| `meal_slab` | hours away (or window) → breakfast / +lunch / +dinner amounts | 26, 27 |
| `meal_disqualifier` | departed after HH:MM → that meal is ₹0 | 28 |
| `dormitory` | overnight arrival between HH:MM–HH:MM with no hotel → flat ₹ | 29 |
| `lodging` | max per night, day-hotel = ₹0, bill required above ₹X | 31–35 |
| `proof_threshold` | category → amount at or above which proof is mandatory | 37 |
| `approval_route` | claimed/exception conditions → who decides | 44, 45 |
| `exception_bands` | what counts as abnormal KM / abnormal spend | 42, 48, 49 |

Every value in every rule is a number or a time on a form. Nothing in that
list needs a deploy to change, which is the star rule satisfied — and it is
satisfied by a screen a person can read, not by a language.

Adding a **new kind** of rule is a code change. That is the honest trade and
it is the right one: a rule shape nobody has designed a form for is a rule
nobody has designed a validation for either.

**Two rules of one kind at one specificity resolve LAST-WINS**, and they
resolve rather than being left to a stable sort. The database refuses to store
such a pair — `expense_policy_rules_key`, with `NULLS NOT DISTINCT`, because
null means "any" here and two applies-to-everybody rules of one kind would
otherwise both be storable. But the engine also runs on a handset, over
whatever came down the wire, and "the first one declared won because the sort
happened to be stable" is not a rule anybody can predict from looking at a
screen. Last-wins is the reading people already have of a list of overrides,
and it is the one under which an appended correction actually corrects
something.

### 1.3 The calculation is ONE pure engine, shared byte-for-byte with the handset

`src/lib/engines/expense-policy.ts` — pure, no I/O, no clock, takes the
resolved policy and the day's facts and returns eligible amounts plus the
exceptions raised. That is the house rule for engines (`DESIGN.md` §1) and it
is what makes the simulator (#73, #74) free: the same function, run over last
month's real facts with a draft policy.

**The handset must run the identical function.** A salesman logs a day in a
market with no signal and requirement 24 says he does not calculate anything
himself — so the eligible amount has to be computable offline. Two copies of
this arithmetic is the worst possible drift, because the half that drifts is
the half the salesman reads out and then argues about.

`mbos-app` is a separate TypeScript project with no path into `src/`, and it
already hand-duplicates its engines. For this one we do it mechanically:

- source of truth: `src/lib/engines/expense-policy.ts`
- `npm run mbos:sync-engines` copies it (plus its golden test vectors) to
  `mbos-app/src/engines/generated/expense-policy.ts` with a
  `GENERATED — DO NOT EDIT` header
- a test in **both** projects asserts the copy is byte-identical to the
  source, so CI fails rather than the salesman finding out

### 1.4 Eligible is DERIVED; approved is a RECORD; the resolution is STAMPED

Three different kinds of number and the codebase already distinguishes them
(`orders.approvedAt`, `bills.paymentDecidedAt`, `calls.next_step_*`).

- **Claimed** — what the salesman typed. Stored.
- **Eligible** — what the policy allows. **Derived on read**, never a cache,
  because a published policy cannot change and the engine is pure, so the
  answer is stable forever. (`AGENTS.md`: derived values are never
  hand-edited.)
- **Approved** — what a person decided. Stored on `mbos_approvals`, with the
  person, the time and the reason. Never recomputed.

But the *inputs to policy resolution* can move — an executive promoted to ASM
would retroactively change the eligible amount on last year's claims. So the
resolved `policyVersionId`, the grade and the city class are **stamped onto
the expense row at submission**. After that, re-derivation is deterministic.

### 1.5 Travel is its own entity; money is still one ledger

A travel leg has a from, a to, a mode, three candidate KM figures, an
odometer pair, a photo, a purpose and a customer link. Forcing that into an
`mbos_expenses` row with `category = 'travel'` throws all of it away and
makes the Daily Travel Ledger (#25) unbuildable.

So: `mbos_travel_legs` is the record of a movement, and it **produces** an
expense line. `mbos_expenses` stays the single money ledger — the thing a
claim is made of, the thing the daily summary totals, the thing approval acts
on — and gains `sourceType`/`sourceId` so every line says what produced it.
Food lines are produced by the day, not typed at all.

---

## 2. Data model

New tables. All money in paise (house rule). All new MBOS tables use
`mbosColumns()`. Distances in **metres** as integers — never a float of
kilometres, for the same reason money is not a float of rupees.

### 2.1 Policy

```
expense_policies                 -- one row per VERSION
  id, versionNo (int, unique), title
  status: draft | published | superseded | archived
  effectiveFrom (date, not null), effectiveTo (date, null = open)
  sourceAttachmentId  -> attachments.id   (the PDF/Excel/Word, #1)
  notes
  publishedAt, publishedById            -- #4: a decision, stamped
  supersededByPolicyId
  createdById, updatedById, timestamps
  -- partial unique index: only one PUBLISHED version may cover a date
  --   (exclusion constraint on the daterange where status='published')

expense_policy_rules
  id, policyId -> expense_policies (cascade)
  kind         -- the closed vocabulary of §1.2
  scopeKey     -- 'travel_mode:own_bike', 'meal:breakfast', 'lodging', ...
  valueJson    -- the typed rule payload, validated per kind
  sequence     -- for slab ordering
  grade, cityClass                  -- null = any. #7 and #8 live HERE
  -- unique (policyId, kind, scopeKey, grade, cityClass, sequence) NULLS NOT DISTINCT

expense_grades                    -- #7. Exactly one residual, partial unique index
  id, key, label, sortOrder, isResidual, active

expense_grade_map                 -- what HR actually typed -> a grade
  id, positionNormalised (unique), positionRaw, gradeId

expense_city_classes              -- #8, editable, no deploy
  id, cityNormalised (unique), cityRaw, cityClass  -- metro | tier1 | tier2 | other
  -- a city with no row falls to the policy's residual rule
```

**Why a city CLASS rather than the city itself.** A rule set with four
hundred city names in it is a rule set nobody maintains, and the day a new
town is added the salesman there gets no allowance with nothing on any screen
saying why. Classes are four rows; the city→class map is a list an admin
edits. This mirrors the mix-category residual in `AGENTS.md`: exactly one
residual, enforced by a partial unique index, so the shares always total and
an unclassified city is caught rather than dropped.

**Why an exclusion constraint on overlapping published ranges.** Two policies
in force on one date is a state where requirement 6 has two answers. Refuse it
at the database rather than picking one at read time.

### 2.2 The day

```
mbos_expense_days                  -- the anchor for food, the summary, the lock
  ...mbosColumns()
  userId, day (date)               -- unique (userId, day)
  departedAt, returnedAt           -- timestamptz, #26
  departedFromHometown (bool)      -- #28's condition
  overnight (bool)                 -- derived from the times + hotel, #31
  destinationCity, destinationCityClass
  tourId -> mbos_tours             -- an outstation tour, where there is one
  arrivedAtDestinationAt           -- #29's dormitory window
  stayedInHotel (bool)             -- #29's other condition
  -- EOD, §J
  submittedAt, submittedTotalPaise
  lockedAt                         -- #54
  reopenedAt, reopenedById, reopenReason   -- #50: an authorised correction
  policyId, resolvedGrade, resolvedCityClass   -- stamped at submission, §1.4
```

### 2.3 Travel

```
mbos_travel_modes                  -- a ROW, not an enum. #9-#15 and whatever
  id, key, label, sortOrder,       --   the client adds next year
  reimbursementKind: per_km | actuals | zero
  requiresOdometer (bool), active
  -- seeded: own_bike, own_car, bus, train, auto_local, customer_vehicle,
  --         walking, taxi, company_vehicle

mbos_travel_legs
  ...mbosColumns()
  userId, expenseDayId -> mbos_expense_days
  modeId -> mbos_travel_modes
  fromLabel, toLabel                          -- #21
  fromLat, fromLng, toLat, toLng
  startedAt, endedAt                          -- #21
  purpose   -- visit | collection | complaint | new_customer | delivery | other  (#23)
  customerId -> customers                     -- #22, #55
  visitId -> mbos_visits                      -- #22, #55
  orderId -> orders                           -- #56
  -- the three candidate distances, all in metres, all kept (#16-#19)
  gpsMetres, gpsMethod           -- 'trail' | 'straight_line_factored' | null
  gpsFixCount, gpsCoveragePct    -- how much of the leg the trail actually saw
  manualMetres                   -- #17
  odometerStart, odometerEnd     -- #18, in the unit the dial shows (km)
  odometerMetres                 -- derived from the pair
  odometerPhotoId -> attachments -- #20
  chosenMetres, chosenSource     -- what the policy said to pay on
  varianceBps                    -- gps vs odometer, basis points (#19)
  ticketAmountPaise, ticketPhotoId            -- #11, #12, #13
  ticketReference                             -- PNR / ticket no, for #47
  note
```

**Why `mbos_travel_modes` is a table and not a pgEnum.** Requirement 3 says an
admin adds and changes things without a developer, and "Auto/Local Transport"
is plainly the start of a list, not the end of one. An enum value cannot be
added and used in the same migration on Postgres (`AGENTS.md` already records
this trap), so an enum here guarantees a two-deploy dance every time the
client names a new mode. Policy rules reference `modeId`.

**Why all three distances are kept.** Requirement 19 asks the system to
compare them, which is impossible if only the winner is stored — and #48 asks
to flag abnormal KM against GPS *and* odometer *and* history.

### 2.4 The money ledger, reshaped

```
mbos_expenses  (ALTER, existing table)
  + kind            -- travel | food | lodging | local_transport | other
  + sourceType      -- travel_leg | expense_day | manual
  + sourceId
  + expenseDayId -> mbos_expense_days
  + claimedPaise    -- what he asked for (existing amountPaise is renamed to this)
  + eligiblePaise   -- what the policy allows, at the moment of submission,
                    --   stored ONLY as a rendering convenience; the truth is
                    --   re-derived. See §1.4 — and there is a test that the
                    --   stored value equals the derived one.
  + excessPaise     -- claimed - eligible, never negative  (#35, #41)
  + policyId, resolvedGrade, resolvedCityClass      -- §1.4
  + exceptionReason -- what the salesman typed when over policy  (#43)
  + vendorName, billNumber, billDate                -- #47 needs something to match on
  + billHash        -- perceptual hash of the bill image, for #47
  + supersededById  -- an authorised correction writes a NEW row, #50

mbos_expense_exceptions           -- #42-#46, #48, #49, #69
  id, expenseId (null for day-level), expenseDayId, travelLegId
  kind    -- over_cap | over_km_band | missing_proof | duplicate_suspect
          -- | gps_odometer_variance | above_own_average | above_team_average
          -- | day_hotel | backdated | ...
  severity   -- info | warn | block_route     (block_route only reroutes approval)
  detail     -- the numbers behind it, jsonb, so a screen can say WHY
  raisedAt
  resolvedAt, resolvedById, resolution   -- accepted | rejected | corrected
```

**Nothing is ever blocked at entry.** The existing handset screen already
gets this right and the comment in `sales/expenses/page.tsx` says why: the
salesman spent the money; refusing to record it does not unspend it, it just
means nobody finds out. An exception **routes** a claim; it never refuses one.
The single exception to that is a missing mandatory proof, which is refused at
the picker on the handset (where he can still go and photograph the bill)
rather than at the server (where he cannot).

### 2.5 Approval routing

`mbos_approvals` stays the one approval table — do not build a second one.
Two additions:

```
mbos_approvals
  + stepIndex        -- 0 = first decider, 1 = escalation, ...
  + routeReason      -- why this step exists: 'normal' | 'over_cap' | 'high_value' | ...
  -- partial unique index on (subjectType, subjectId, stepIndex)
```

The subject's state is the state of its **highest** step — which keeps the
existing rule ("the subject's state is DERIVED from this table") true while
letting #44's chain exist. #46 (approval history) is then the step rows plus
`audit_log`, both of which already carry who, when and why.

> **Confirm with the client:** does an exception need *two* approvals (manager
> then owner), or does it *skip* the manager and go straight to the owner?
> The tables above support both; the policy rule `approval_route` decides. The
> difference matters to #45.

---

## 3. The engines (pure, tested without a database)

### 3.1 `lib/engines/expense-policy.ts` — the calculator

```ts
resolvePolicy(policies, assignments, { grade, cityClass, onDate }) -> ResolvedPolicy | null
computeTravelLeg(policy, leg)      -> { chosenMetres, chosenSource, eligiblePaise, exceptions }
computeDayAllowances(policy, day)  -> { meals: [...], dormitory, lodging, exceptions }
computeExpenseLine(policy, line)   -> { eligiblePaise, excessPaise, proofRequired, exceptions }
computeDay(policy, dayFacts)       -> DayComputation      // everything, one call
```

`computeDay` is what both the handset and the server call. It takes the day,
its legs and its typed lines and returns every eligible figure and every
exception in one pass, so the summary screen and the claim cannot disagree.

Requirement-by-requirement, this file is where 9–15, 19, 24, 26–35, 38–42 and
48–49 actually live.

### 3.2 `lib/engines/travel-distance.ts` — how far, and how sure

```ts
trailDistance(points, fromAt, toAt, opts) -> { metres, fixCount, coveragePct }
straightLine(a, b) -> metres                       // haversine
chooseDistance(policy, { gps, manual, odometer }) -> { metres, source, varianceBps }
```

**A GPS number has to say what kind of number it is.** The trail takes a fix
every five minutes by default; on a bike at 30 km/h that is 2.5 km between
points, so the polyline cuts every corner and **under-reads real road
distance**. Presenting that as "the actual distance travelled" would quietly
short-pay every salesman.

So: the trail figure is evidence for the cross-check (#19), the policy names
which source money is paid on (`km_source` rule, default odometer for
own-vehicle and GPS for everything else), and every screen prints the method
and the coverage. Where the trail did not cover the leg — tracking off, phone
dead, indoors — `gpsMetres` is null with a reason, never a straight line
silently labelled GPS. (Same rule `mbos_activity_locations` already follows:
no fix is a recorded fact, not a missing row.)

### 3.3 `lib/engines/expense-fraud.ts` — §I, deterministic

```ts
duplicateCandidates(line, history) -> Candidate[]     // #47
kmAnomalies(leg, history, bands)   -> Exception[]     // #48
spendAnomalies(day, ownHistory, teamHistory, bands) -> Exception[]  // #49
```

Modelled on `lib/engines/receipt-match.ts`, which already solves exactly this
shape of problem for payments: **candidates offered strongest-first, a
suggestion and never a gate**, and a reason a human can read. A bill number
match beats an equal amount on the same date, which beats a near amount. Two
lines with no bill number and no vendor match on nothing — otherwise every
₹200 auto fare matches every other one and the flag means nothing.

Image duplicate detection is a perceptual hash (`billHash`) computed on upload
from the bytes — the same place `sniffContentType` already reads them.

### 3.4 `lib/engines/sales-roi.ts` — §K and §L

```ts
salesPerKm, salesPerVisit, travelExpenseRatio      // #57, #58, #59
totalSalesmanCost(salary, approvedExpenses)        // #60
salesmanReturn(revenue, cost)                      // #61 — revenue, NOT margin
coca(acquisitionExpenses, newCustomers)            // #62
servicingCost(servicingExpenses, servedCustomers)  // #63
customerReturn(...)                                // #64
```

**#65 — acquisition and servicing must not mix.** The split is the travel
leg's `purpose` plus the customer's own history: a leg whose purpose is
`new_customer`, or against a customer with no counting order before that date,
is acquisition. Everything else is servicing. That is one rule in one place,
and the residual — a leg against no customer at all — is reported as
unattributed rather than folded into either. (`sales-attribution.ts` already
sets this precedent: a figure nobody can account for is worse than one that
says why it is there.)

Cost counts **approved** expenses only, never claimed. Money the business has
agreed to pay is the only cost figure that means anything — the same rule the
payments module already follows for `reported` vs `confirmed`.

---

## 4. Server — services, actions, sync

```
lib/services/expense-policy-service.ts   read + resolve a policy for a person/date
lib/services/expense-service.ts          days, legs, lines, exceptions, summaries
lib/services/expense-roi-service.ts      §K and §L, wired to orders and HRMS pay
lib/actions/expense-policy.ts            draft, edit, assign, publish, supersede
lib/actions/expenses.ts                  submit day, reopen, decide, resolve exception
```

New capabilities in `lib/access-control.ts`:

| Capability | Held by | Why |
|---|---|---|
| `expense.policy.write` | admin + manager? **confirm** | Authoring a draft. |
| `expense.policy.publish` | admin only (#4) | "authorised person verifies and publishes". Deliberately separate from writing, so the person who typed the rates is not the only person who has seen them. |
| `expense.approve` | manager + accounts | Ordinary claims. |
| `expense.approve.exception` | owner/admin, configurable | #44's escalation. |
| `expense.reopen` | manager + accounts | #50 — an authorised correction, always with a reason. |

Every one checked **in the action**, never by hiding a button — house rule,
and `AGENTS.md` states it three times because it keeps being the thing that
goes wrong.

### 4.1 Sync (PROTOCOL.md)

New entity types in `SYNC_ENTITY_TYPES` (`src/lib/mbos/types.ts`) and handlers
in `src/lib/actions/mbos.ts`:

| Entity | Required | Optional |
|---|---|---|
| `expense_day` | `day` | `departedAt` `returnedAt` `departedFromHometown` `destinationCity` `arrivedAtDestinationAt` `stayedInHotel` `tourId` |
| `travel_leg` | `expenseDayId` `modeKey` `startedAt` | `fromLabel` `toLabel` `from/to lat/lng` `endedAt` `purpose` `customerId` `visitId` `manualMetres` `odometerStart` `odometerEnd` `odometerPhotoId` `ticketAmountPaise` `ticketPhotoId` `ticketReference` `note` |
| `expense_day_submit` | `expenseDayId` `clientTotalPaise` | `note` |
| `expense` (existing, extended) | `category` `claimedPaise` `expenseDate` | `+ kind` `expenseDayId` `vendorName` `billNumber` `billDate` `exceptionReason` |

New pull channels: `expensePolicy` (the resolved rules for *this* person,
today — never the whole policy table), `travelModes`, `expenseDays`,
`expenseExceptions`. Each is upsert-by-id except `expensePolicy`, which is
**replaced wholesale** for the same reason the price list is: a withdrawn rule
has to disappear, and a per-row upsert leaves a rate nobody pays any more.

Three protocol rules that already bit this codebase and will bite here:

1. **Never bind a JS `Date` into a raw query.** It has cost this repo three
   separate production incidents (`handleOrder`, `handleVisit`, the pull
   cursor). Pass `.toISOString()`. There is a grep test; keep it passing.
2. **Idempotency.** A leg re-sent from a market must not become two legs. The
   key is `<entityId>:<op>:<payloadHash>`, already handled by
   `mbos_sync_receipts` — the new handlers must go through the same path.
3. **`onConflictDoNothing` on the id**, as every existing handler does.

**Every accepted expense write gets an `mbos_activity_locations` row for
free** — the dispatcher writes it and no handler mentions it. So "where was
this expense claimed" is answered by existing machinery, which matters for
#48: a fuel bill claimed from home at 11pm is a different fact to one claimed
at the pump.

### 4.2 The server recomputes, and disagreement is a fact

The handset computes eligible amounts offline so the salesman sees them
(#24, #39). The server recomputes on receipt with the authoritative policy.
Where the two differ — the handset had a stale policy, the clock was off — the
**server's answer wins and the difference is RECORDED**, not silently
overwritten: an `expense_client_disagreement` exception, exactly the way
`sync_conflicts` records the sheet disagreeing with the app. A salesman told
₹450 who is paid ₹250 with nothing on any screen explaining it is how people
stop trusting the handset.

---

## 5. The handset (`mbos-app`)

Everything below works fully offline and syncs later. That is not a nice-to-
have here: the whole point of the module is capture at the moment of spending.

### 5.1 New and changed screens

| Screen | What it is | Requirements |
|---|---|---|
| `app/day.tsx` **(new)** | Start the day: departed at, from hometown?, destination. Ends the day: returned at, stayed in hotel?. This is what makes food automatic. | 26, 28, 29 |
| `app/travel.tsx` **(new)** | The day's legs as a ledger — mode, from→to, KM, rate, eligible ₹. Add a leg. | 21, 25 |
| `app/leg.tsx` **(new)** | One leg: mode picker, from/to (prefilled from the last visit and the next one), purpose, customer, KM block. | 9–23 |
| `app/expenses.tsx` **(rework)** | Category-driven form: it asks only what the *active policy* requires for that category (#36). Claimed / Eligible / Excess on the same line (#41). Exception reason box appears only when over (#43). | 36–43 |
| `app/eod.tsx` **(new)** | The day's summary — visits, KM, travel, food, hotel, other — and the Submit that locks it. | 52, 53, 54 |
| `app/policy.tsx` **(new)** | "What am I allowed?" — the active policy in plain sentences, with its version and effective date. | 3, 5 (read side) |

The KM block on `leg.tsx` is the delicate one:

- GPS distance appears on its own as soon as the leg is closed, labelled with
  its method and coverage — "8.4 km along your day's track, 82% covered".
- Manual KM is always available and always asked for a reason when GPS exists
  and disagrees.
- Odometer start/end appear only for modes with `requiresOdometer`. Start is
  prefilled from the previous leg's end, so a day is a chain and a gap in the
  chain is itself visible.
- The odometer photo is requested when the policy says so — always, randomly
  at N%, or when variance exceeds the band (#20). The random draw is made on
  the **server** and pushed down as a flag on the day, not rolled on the
  handset: a random check a device can decline to roll is not a check.
- Zero-rated modes show "₹0 — recorded, not reimbursed" *before* he saves,
  never after (#14, #15). A salesman who logs 40 km on a customer's van and
  finds out at month end that it paid nothing has been told nothing.

### 5.2 Local schema (`mbos-app/src/db/schema.ts`)

New SQLite tables mirroring §2: `expense_days`, `travel_legs`, `travel_modes`,
`expense_exceptions`, plus new columns on `expenses`. Registered in the
`schema-usage.test.ts` list. Local `state` columns follow the existing
convention (`Pending` / server states), and nothing may imply a queued expense
is money the office has seen — PROTOCOL.md §2's rule.

### 5.3 Where the policy comes from

`src/data/config.ts` today reads flat `mbos.*` keys. It gains
`getActivePolicy()` reading the `expensePolicy` pull channel, with the
version and effective date, and the screens print them. **If the handset has
no policy at all** — a fresh install that has never synced — the expense form
records the claim and says the eligible amount will be worked out when it
reaches the office, rather than showing a confident ₹0. A capture path that
refuses to capture is the one failure this module cannot afford.

---

## 6. The Manager Dashboard (`src/app/sales`)

New modules in `lib/modules.ts` (each is a sidebar destination, so each can be
withheld — house rule):

| Module | Screen | Requirements |
|---|---|---|
| `sales.travel` | Travel ledger: every leg, by salesman and day, with the three KM figures side by side and the variance called out. | 19, 25, 48 |
| `sales.expenses` **(rework)** | Claimed / Eligible / Approved in three columns, exceptions inline, decide in place. Keeps the existing month-to-date column — it is the thing that makes a cap mean anything. | 38–41, 46 |
| `sales.exceptions` | The one worklist: everything flagged, strongest first, each resolvable with a reason. | 42–46, 69 |
| `sales.expense-policy` *(read-only mirror)* | Which policy applies to whom, and from when. Authoring lives in the Admin Console. | 5, 7, 8 |
| `sales.roi` | Per salesman: sales, KM, expense, expense/sales, sales/KM, new customers, total cost, return. | 57–61, 68, 70 |

The existing `Decide` component already does approve / part-approve / refuse
with a note against `mbos_approvals`; it gains the eligible figure as the
default approved amount, so the ordinary case is one tap and the manager is
overriding the policy rather than doing its arithmetic (#40, #45).

### 6.1 Admin Console — the policy builder (§A and §N)

`src/app/admin/expense-policy-section.tsx`, beside the existing Catalogue and
Components sections.

1. **Upload** (#1) — the PDF/Excel/Word attaches to the version. Validated on
   its bytes via `sniffContentType`, never its extension (house rule). It is
   the source of record and nothing parses it in Phase 1.
2. **Build** (#2, #3) — a form per rule kind. Rates, times and limits only.
3. **Assign** (#7, #8) — grade × city class, with the residual enforced.
4. **Simulate** (#73, #74) — see §7.
5. **Publish** (#4, #5, #75) — a separate capability, an effective-from date,
   and it closes the previous version's `effectiveTo` in the same transaction.

**A draft is edited freely; a published version is never edited.** Same shape
as `sales_targets`: a draft nobody has promised anything on can change without
ceremony, and once it is published the only move is a new version. Nothing
reaches a handset until it is published.

### 6.2 Owner Dashboard (§M) — in the Reports app

`src/app/reports/expenses/page.tsx`, narrowed by scope exactly like every
other Reports screen (a reporting screen that skips the narrowing is a way
around it, not a report).

- Total monthly sales-team expense (#66), broken down travel / food / hotel /
  local / other (#67)
- Salesman comparison table (#68) and top/bottom (#70)
- Exception dashboard (#69) — **only what needs a decision**, which means the
  unresolved `block_route` and `warn` rows, not the count of everything ever
  flagged. A dashboard that shows every info-level flag is a dashboard nobody
  opens twice.
- 6–12 month trend (#72), reading a monthly snapshot the nightly job writes,
  the same way `customer_health_snapshots` already works — a trend read off
  live data would restate history every time an old claim was corrected.

### 6.3 Owner's five KPIs stay where they are

Do not fold expense into `lib/engines/owner-kpis.ts`. That engine answers a
funnel question (leads → conversion → bill size → frequency → retention) and
this is a cost question. They meet on one screen, not in one function.

### 6.4 #71 — "AI alerts", honestly

The alerts are produced by `expense-fraud.ts` — deterministic, explainable,
testable, and the same number every time it runs. What a model may do is
**write the sentence**: turn "leg 4, gps 6.2 km, odometer 31 km, variance
400%, own 30-day median 84 km/day, claimed 240 km" into a paragraph an owner
reads in three seconds. `lib/writing-model.ts` already exists for exactly this
shape of job and already falls through providers.

A model must not be the thing that decides an expense is suspicious. It
cannot explain itself, it cannot be tested, it is not the same twice, and this
is somebody's salary. Say this to the client plainly — it is a better product
and it is also the only defensible one.

---

## 7. The simulator (§N)

Falls out of §1.3 for almost nothing, which is the payoff for the pure engine.

```
simulate(draftPolicy, { from, to }) ->
  { perSalesman: [...], byCategory: {...}, total, vsActual }
```

It replays every stored `mbos_expense_days`, `mbos_travel_legs` and expense
line in the window through `computeDay` with the **draft** policy and compares
the total to what the policy actually in force produced (#74). Facts are
never rewritten; nothing is stored; it is a read.

Two honesty rules on that screen:

- It says how many days it replayed and over what window. "+₹42,000/month" on
  eleven days of data is not a monthly figure.
- Legs with no KM and lines with no category rule are **counted and named**,
  not silently zeroed — otherwise a policy that fails to cover half the book
  simulates as cheap.

---

## 8. Configuration (`lib/config/registry.ts`)

New category `expenses` (distinct from `mbos-expenses`, which stays and
becomes the no-policy fallback). These are the things that are *not* policy —
platform behaviour rather than reimbursement terms:

| Key | Default | What |
|---|---|---|
| `expenses.policyFallbackToConfig` | `true` | Whether a date with no policy falls back to `mbos.expenses.*` or refuses. |
| `expenses.gpsRoadFactor` | `1.25` | Straight-line → estimated road distance, where the trail did not cover a leg. Labelled as an estimate on every screen. |
| `expenses.gpsMinCoveragePct` | `60` | Below this the trail figure is offered as evidence but never as the payable source. |
| `expenses.odometerPhotoRandomPct` | `10` | #20's random draw, made server-side. |
| `expenses.duplicateWindowDays` | `30` | How far back #47 looks. |
| `expenses.anomalyLookbackDays` | `90` | The history #49 compares against. |
| `expenses.eodReopenWindowDays` | `7` | How long a locked day may be reopened at all (#50). |
| `expenses.trendMonths` | `12` | #72. |

`checkConsistency()` gains: no two published policies may overlap; every
policy must have a residual assignment; a `meal_slab` set must be
monotonically increasing in hours (a longer trip cannot be worth less — the
same check `sales_targets` mix bands already have); the KM variance band must
be above zero or every leg is an exception.

---

## 9. Phases

Estimates are **working days for one developer** and are estimates. Each phase
is independently shippable and leaves the product working.

### Phase 0 — Foundations — **DONE**

| Shipped | Where |
|---|---|
| The rule vocabulary, thirteen kinds, and the whole calculator | `src/lib/engines/expense-policy.ts` |
| Distance from the day's GPS trail, with its method and coverage | `src/lib/engines/travel-distance.ts` |
| 51 golden tests, including §E on the client's own ₹100/₹250/₹450 | `src/lib/engines/expense-policy.test.ts` |
| Policy, rules, grades, the grade map and city classes | `src/db/schema.ts` |
| Tables, constraints and version 1 seeded from `app_settings` | `drizzle/0086_expense_policy.sql` |
| The handset copy, and the test that fails when it goes stale | `scripts/sync-mbos-engines.mjs`, `shared-engines.test.ts` |

`npm run test` — 577 pass, 0 fail. `npm run test:db` applies all 86 migrations
clean. `npx eslint` clean. Verified against a real Postgres: the overlap
constraint refuses two published versions covering one date (including a
shared boundary day) and allows an adjacent one and a draft; the rule index
refuses a second applies-to-everybody rule of one kind; the residual index
refuses a second residual grade.

Nothing reads any of it yet, which was the point: no screen moved.
*Covers: the groundwork for everything, and #6 outright.*

### Phase 1 — Policy authoring and publishing — **DONE**
Admin Console section (`admin/expense-policy-section.tsx`): versions, the rule
builder rendered from one declaration for all thirteen kinds, grades and the
HRMS-position mapping, city classes, readiness checks, and publish behind its
own capability. Read-only mirror at `/sales/expense-policy`. Policy and travel
modes go down the sync to the handset; `app/policy.tsx` shows a salesman what
he is allowed, as sentences.
*Covers: 1, 2 (typed by hand), 3, 4, 5, 6, 7, 8, 75.*

### Phase 2 — Travel and KM — **DONE**
`mbos_travel_modes` (a table, not an enum), `mbos_travel_legs` with all three
distances kept, the `travel_leg` sync entity, GPS distance from the day's trail
with its method and coverage, odometer pair and photo, variance flagging.
Handset `app/travel.tsx`; manager `/sales/travel`.
`lib/s3-signing.ts` and the S3 backend in `lib/storage.ts` cover §11.8, checked
against AWS's published signing vectors offline — no SDK, because the container
registry quota is already what breaks deploys here.
*Covers: 9–25.*

### Phase 3 — Food, lodging and the day — **DONE**
`mbos_expense_days`, `app/day.tsx`, automatic meals from the departure and
return times, the no-breakfast rule, the dormitory rule, hotel ceilings, day
hotel at zero, claimed/eligible/excess.
*Covers: 26–35.*

### Phase 4 — Claims, exceptions and approval routing — **DONE**
`mbos_expense_exceptions`, `approval_route` rules, `stepIndex` on
`mbos_approvals`, auto-approval of a clean day, `/sales/exceptions`, and the
three-figure claim list at `/sales/expenses`.
*Covers: 36–46.*

### Phase 5 — Daily closing and the lock — **DONE**
`app/eod.tsx`, `submitDay`, the lock, the authorised reopen with its reason and
its window, and `audit_log` over every decision.
*Covers: 50–54.*

### Phase 6 — Fraud and leakage — **DONE**
`lib/engines/expense-fraud.ts` with 33 tests: duplicate candidates
strongest-first, KM anomalies against the person's own median, spend anomalies
against their own and the team's. `submitDay` runs the KM and spend passes.
`attachments.content_hash` is taken on upload (`0088`), and `duplicatesForDay`
runs at submission — asked once of the finished day rather than at every entry,
because a salesman typing the third of four fares should not be interrupted
three times. A certain match blocks the day to a person; a possible one is a
note.
*Covers: 47, 48, 49, and 51 via the audit trail.*

### Phase 7 — ROI, COCA and the owner's screens — **DONE**
`lib/engines/sales-roi.ts`, `expense-roi-service.ts`, and `/sales/roi` — sales
per km, per visit, travel-to-sales, total cost from HRMS pay plus approved
expenses, COCA and servicing cost kept apart, and the unattributed remainder
printed rather than hidden.
`/reports/expenses` is the owner's screen: the month's cost broken down, only
the exceptions that need a decision, the salesman comparison with its two ends,
the two customer costs kept apart, and the trend. `expense_month_snapshots`
(`0089`) is written by the nightly pass for the current month only.
*Covers: 55–68, 70, 72. Ships #61 and #64 on **revenue**, said in words on
screen.*

### Phase 8 — Simulator and narration — **DONE**
`simulatePolicy` replays submitted days through a draft and compares the answer
to what the policy in force at the time allowed — a read, and it could not be
anything else with a pure engine. Its own tab in the console. The narrator turns
the deterministic findings into three sentences and never decides anything.
*Covers: 71, 73, 74.*

**All eight phases are built and tested.** What remains is one environment
variable and one deliberate limitation, both in §13.

Phases 2 and 3 both touch the handset heavily and still need real device
testing on 2G — everything below is verified by tests and typechecking, not by
a phone in a market.

---

## 10. Requirement coverage

| # | Requirement | Phase | Where it lives |
|---|---|---|---|
| 1 | Policy upload | 1 | `attachments` on `expense_policies` |
| 2 | Convert/edit into rules | 1 | Admin rule builder (typed by hand; AI extraction is a later option, §11) |
| 3 | No coding required | 1 | Closed rule vocabulary, §1.2 |
| 4 | Draft until published | 1 | `status` + `expense.policy.publish` |
| 5 | Version + effective dates | 1 | `expense_policies` |
| 6 | Old policy protection | 0/1 | Immutable published versions + stamped resolution, §1.4 |
| 7 | Employee-wise | 1 | `expense_policy_rules.grade` + `expense_grades` |
| 8 | Location-wise | 1 | `cityClass` + `expense_city_classes` |
| 9–10 | Own bike / car ₹/KM | 2 | `per_km` rule |
| 11–13 | Bus / train / auto | 2 | `actuals` rule |
| 14–15 | Customer vehicle / walking = ₹0 | 2 | `zero_rated` rule, told before saving |
| 16 | GPS distance | 2 | `travel-distance.ts` over `mbos_positions` |
| 17 | Manual KM | 2 | `manualMetres` |
| 18 | Odometer | 2 | `odometerStart/End`, chained across legs |
| 19 | GPS vs odometer check | 2 | `varianceBps` + exception |
| 20 | Odometer photo | 2 | Always / random (server-drawn) / on variance |
| 21 | From/To/Date/Time | 2 | `mbos_travel_legs` |
| 22 | Customer link | 2 | `customerId`, `visitId` |
| 23 | Purpose | 2 | `purpose` |
| 24 | Automatic calculation | 2 | Shared engine, on the handset too |
| 25 | Daily travel ledger | 2 | `app/travel.tsx` + `sales.travel` |
| 26–30 | Food and allowances | 3 | `meal_slab`, `meal_disqualifier`, `dormitory` |
| 31–35 | Hotel | 3 | `lodging` rule |
| 36–41 | Expense claim | 4 | Policy-driven form; claimed/eligible/approved |
| 42–46 | Exception and approval | 4 | `mbos_expense_exceptions`, `approval_route`, `stepIndex` |
| 47–49 | Fraud and leakage | 6 | `expense-fraud.ts` |
| 50 | Post-EOD editing control | 5 | Lock + authorised reopen + superseding rows |
| 51 | Audit trail | 5 | `audit_log`, already company-wide |
| 52–54 | Daily closing | 5 | `mbos_expense_days` + `app/eod.tsx` |
| 55–56 | Link to visit / order | 2/7 | `visitId`, `orderId` on the leg |
| 57–59 | Sales per KM / visit / ratio | 7 | `sales-roi.ts` |
| 60 | Total salesman cost | 7 | HRMS pay + approved expenses |
| 61 | Salesman ROI | 7 | **Revenue-based — see §0** |
| 62–63 | COCA / servicing cost | 7 | Purpose + first-order date split |
| 64 | Customer ROI | 7 | **Revenue-based — see §0** |
| 65 | Do not mix costs | 7 | One rule, one place, residual named |
| 66–70, 72 | Owner dashboard | 7 | Reports app + monthly snapshot |
| 71 | AI alerts | 8 | Deterministic engine, model narration only |
| 73–75 | Simulator and publish | 8 / 1 | `simulate()` over real history |

---

## 11. Decisions taken

These were the eight open questions. They are decided. Every one of them is
implemented as a **default the client can change on a screen** rather than a
constant, which is the star rule — so a decision made here is a starting
position, never a lock-in. Where a decision costs money in one direction, the
reasoning for the direction is written down.

### 11.1 Grades — a mapping table, not the HRMS column

HRMS holds `employees.position` (free text, typed by HR on the workbook) and
`employees.department` (the sheet's "Position Type": Sales, Office Staff,
Other, Owner). Neither is a grade, and `position` is free text with no
vocabulary — keying reimbursement rates on it would mean four spellings of
"ASM" getting four different hotel limits, silently.

**Decided:** `expense_grades` (Sales Executive, Senior Executive, ASM, Manager
— editable) plus `expense_grade_map` from the HRMS position **as written**,
normalised, to a grade. Exactly one grade is the residual, enforced by a
partial unique index, the same way the mix categories are.

A position with no mapping falls to the residual **and is listed on the
console screen as unmapped**. It is never silently residual-ed: an unmapped
person is somebody being paid on a rule nobody chose for them, and the
catalogue's Duplicates screen already sets the precedent — a row nobody can
account for is listed, not dropped on the floor.

### 11.2 City class — a property of the destination

**Decided:** four classes — `metro`, `tier1`, `tier2`, `other`, with `other`
as the residual. The class is resolved from the **destination** of the day,
not the employee's posting.

Why the destination: the rules it feeds are a hotel limit and a food
allowance, and both are about what things cost *where you are standing*. An
executive posted in Nagpur pays Mumbai prices in Mumbai. On a local day the
destination is the home city, so the same rule resolves it and there is no
branch to get wrong.

### 11.3 Approval routing — the manager decides, the owner is escalated to

**Decided, three rules:**

1. **A clean day is auto-approved at submission.** Every line within eligible,
   no `warn` or `block_route` exception, day total under
   `autoApproveUpToPaise`. This is requirement 45 taken literally, and it is
   the decision that makes the module usable — a manager asked to tap approve
   on forty ₹40 auto fares stops reading any of them, and then the exceptions
   go through too.
2. **Anything flagged goes to the manager** — step 0.
3. **The owner is escalated to, not substituted for** — step 1, where the
   route rule says so. Sending an exception straight past the manager would
   put the owner in the middle of routine work, which is exactly what #45
   forbids, and it would remove the person who actually knows whether that
   salesman was in Pune on Tuesday.

**The high-value threshold is per DAY, not per line.** A person can split a
line; they cannot split a day, because the day is EOD-locked and unique on
`(userId, day)`. Per-line is the grain that a threshold is trivially evaded
at, and evading it requires no dishonesty at all — just two entries.

### 11.4 Which KM own-vehicle is paid on — the odometer

**Decided:** odometer where a valid pair exists → GPS where it does not →
manual last. Manual always raises an exception where a GPS figure exists and
disagrees beyond the band.

This is the single biggest lever on what the module costs, so the reasoning
matters. GPS **structurally under-reads**: a fix every five minutes cuts every
corner, so paying on it systematically short-pays people who did nothing
wrong, and the shortfall is largest for the salesman covering the most ground.
The odometer is what the vehicle actually did, and unlike GPS it can be
photographed — requirement 20 exists precisely to keep it honest, and
requirement 19's variance check is the cross-examination.

Paying on GPS would be cheaper and would be a quiet, permanent deduction
nobody could see. It is stored as the `km_source` rule so the client can
change it in an afternoon without a deploy.

### 11.5 Dormitory arrival time — entered, cross-checked

**Decided:** the salesman enters the arrival time and that is what the
allowance is computed from. Where the day's trail covered the arrival, the
first fix inside the destination city is compared to it and a disagreement
beyond the band raises an exception.

Deriving it from GPS instead fails exactly where tracking is off or the phone
is dead — and refusing somebody ₹250 because their battery ran out on an
overnight bus is the wrong failure. Captured value pays, evidence flags: the
same shape as every other cross-check in this module.

### 11.6 Requirement 2's ambition — a person types the rates

**Decided:** Phase 1 is an admin reading the document and typing the rates,
with the document attached to the version as the source of record. Machine
extraction is Phase 8 and **proposal-only** — it fills a draft an admin edits
and publishes.

An auto-published extracted policy is a set of rates nobody read paying money
to everybody, and the failure is silent: a mis-parsed "₹4.00/km" as "₹400/km"
looks exactly like a correct policy until payday.

### 11.7 Margin — ship on revenue, with the seam already cut

**Decided:** #61 and #64 ship as revenue ratios. Every screen says "revenue"
in words rather than "return" or "contribution".

`sales-roi.ts` takes an **optional** `marginBps` per formulation from the
start. The day a cost source exists — a price list, or one flat margin
percentage per formulation, which is a single afternoon's work for the client
to supply — it is one argument to one function, not a rewrite, and the same
screens become true ROI.

### 11.8 Attachment storage — S3-compatible, not Vercel Blob

**Decided:** add a DigitalOcean Spaces (S3-compatible) backend to
`lib/storage.ts` before Phase 2, as a prerequisite task inside that phase
(+1–2 d).

The volume is real: bill photos plus odometer photos at field scale run to
roughly 20 MB a day for ten people, ~600 MB a month, and bytes in Postgres are
bytes in every backup, every restore and every replica. `AGENTS.md` already
says Postgres stops being right at volume, and this module is the thing that
crosses that line.

The existing switch is `BLOB_READ_WRITE_TOKEN` → `@vercel/blob`. That was the
right answer when the app ran on Vercel and is the wrong one now: production
is a DigitalOcean droplet, and paying Vercel to hold files for a droplet is a
cross-cloud dependency and a bill for nothing. `FileStorage` is already an
interface with two implementations behind one constant — a third is one file,
and no caller changes.

### 11.9 Who may write a policy, and who may publish one

**Decided:** `expense.policy.write` sits in `ACCOUNTS_ONLY` (which is accounts
+ admin). `expense.policy.publish` is **admin only**, which needs a new
`ADMIN_ONLY` set in `lib/access-control.ts` — there is not one today.

Writing and publishing are deliberately different capabilities because
requirement 4 says a policy is verified by an authorised person before it goes
live, and verification by the person who typed it is not verification.

A manager is deliberately excluded from both. A manager authoring the policy
that governs their own team's reimbursements is the same conflict
`order.approve` and `customer.reassign` already exist to avoid, one level up:
the person chasing the target must not write the rules for what the chase
costs. A manager still decides individual claims (`expense.approve`).

Holding `expense.approve` alongside being a field salesman is a hat
combination worth naming in `lib/role-conflicts.ts`, beside the two that are
there already.

### 11.10 One consequence for the phases

11.1 adds a grade table and a mapping screen to Phase 1 (+1 d). 11.8 adds the
storage backend to Phase 2 (+1–2 d). Revised total: **roughly 50–61 working
days.** Nothing else moves.

---

## 12. Risks

| Risk | Why it matters | What we do about it |
|---|---|---|
| Handset and server compute different eligible amounts | The salesman argues with a number and stops trusting the app | One engine, mechanically copied, byte-identical test in CI (§1.3); disagreement recorded as an exception, never silently overwritten (§4.2) |
| GPS KM under-reads and gets treated as truth | Every salesman quietly short-paid | The trail figure is evidence, not the payable source, unless the policy says so; method and coverage printed everywhere (§3.2) |
| Policy edited instead of versioned | Requirement 6 broken silently; old claims restate | Published versions immutable at the database, not by convention (§2.1) |
| Rule builder becomes an expression language | Unreviewable, untestable, one typo from paying nothing | Closed vocabulary, one form and one validator per kind (§1.2) |
| Migration numbering collides across branches | A branch's migrations carry `when` values below main's and get skipped on prod | Hand-write the SQL (never `drizzle-kit generate` in this repo), renumber on merge, verify on the droplet |
| Enum for travel modes | Postgres refuses a new enum value in the transaction that adds it; drizzle-kit runs all pending migrations in one | Travel modes are a table (§2.3) |
| A `Date` bound into a raw query in a new sync handler | Every write from every handset retries for ever with no cause named | `.toISOString()`, and send a real payload through the HTTP endpoint in the test — the only way the last three of these were ever found |
| Attachment volume | Bill and odometer photos at field scale — ~600 MB/month into Postgres backups | S3-compatible backend in `lib/storage.ts`, shipped inside Phase 2 (§11.8) |
| Scope creep into HR | Expense touches attendance, tours, leave and pay | Salary stays read-only from HRMS; this module never writes pay |

---

## 13. What is left

**Nothing from the original plan.** All eight phases are built. What is listed
here is what a person still has to do, and one thing the module deliberately
does not attempt.

### One environment variable, and then it is live

`R2_ATTACHMENTS_BUCKET`. Attachments currently live in Postgres, which is right
until volume says otherwise, and field photographs are what says otherwise —
roughly 600 MB a month for a small team, in every backup and every replica.

It reuses the R2 credentials already set for offsite backups, so it is one
variable rather than a second copy of a token. **Give it its own bucket**:
`R2_BUCKET` is where database dumps go and has a retention policy that deletes
old objects, so attachments put there would vanish on a schedule nobody
connects to attachments. The app refuses to use the store at all if the two
names match, logs why, and falls back to Postgres — slow and correct — rather
than to a bucket that eats what it is given.

**`npm run check:storage` proves it before anything depends on it.** It writes
a file, reads it back, compares the bytes, deletes it, and names which backend
answered. Worth running at the moment the variable is set, because the failure
otherwise is silent for days: uploads throw inside a request nobody is
watching, the salesman sees "could not be stored", and the cause is a region
string. A 403 and a 404 each get the three things they usually mean, since
neither says so on its own.

### The duplicate check, and a constraint that turned out to be wrong

It is an exact content hash. It catches the same FILE claimed twice — a retried
submission, one photograph on two days, one bill sent by two people — which is
the commonest duplicate there is. It does not catch the same bill photographed
a second time.

**The reason first given for that was wrong.** It said a perceptual hash needs
an image decoder in the container, and the registry quota argues against one.
The decoder does not have to be in the container: the HANDSET already decodes
and resizes every photograph through `expo-image-manipulator` before queueing
it (`mbos-app/src/sync/media.ts`), so a perceptual hash can be computed at that
moment, on the phone, and sent as one more field. Nothing reaches the server
image, nothing reaches the container, and the registry is untouched.

What it does still cost is a small PNG decode step on the handset — the
manipulator returns an encoded image rather than pixels — and a release, since
a handset change only reaches phones on the next APK build. That is the reason
it is not built rather than the container weight, and it is an honest reason
rather than a technical impossibility.

### The build

`npm run build` passes, `tsc --noEmit` is clean across the repo and `eslint src`
reports nothing. Getting there needed three things beyond this module:

- **Two errors in the working tree's in-progress work**, both fixed to the
  author's evident intent rather than guessed at: `sales/live/page.tsx` read
  `mbos.location.trackEverySeconds`, which does not exist — the setting is in
  MINUTES and there is no seconds setting, because the registry's floor is a
  minute; and `actions/secrets.ts` was missing the `olamaps.apiKey` label the
  modified `lib/secrets.ts` requires. Plus one unescaped apostrophe.
- **A stale `node_modules`**, which failed as `Cannot find module
  '@vercel/turbopack/postcss'` and an unresolvable `@ai-sdk/gateway`. That is
  Next's own bundler failing to resolve its internal modules — Turbopack
  carries the `@vercel/` namespace even on a fully self-hosted deployment, so
  it is not evidence of a Vercel coupling. `npm install` repaired it.
- **`@vercel/blob` removed.** This deployment is not on Vercel anywhere, so
  that backend was 916 KB of image weight no code path could reach — and a full
  container registry is already what breaks deploys here. The Admin Console's
  storage line now asks `fileStorage.kind` rather than an environment variable,
  so it cannot go on describing a backend the code no longer selects.

### One thing worth knowing about the verification

`tsconfig.json` includes `.next/dev/types/**`, and a stale generated file there
had a syntax error that made `tsc` abort before checking `src/` at all. It
reported errors and exited 0, so it looked like it was working. Deleting
`.next/dev` restored real typechecking — and immediately surfaced three genuine
errors. Worth remembering the next time `tsc` looks suspiciously quiet.
