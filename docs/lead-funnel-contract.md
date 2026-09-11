# The lead funnel — the build contract

Working notes, not documentation. This file exists so five parallel workstreams
agree on names before any of them writes a caller. Delete it when the funnel
lands.

The specification is "Mahek One — Sales Lead Funnel & Management Rules", §1–§28.
Section references throughout are to it.

## What already exists (commit `b448d40`)

**Schema.** One lead is one `customers` row. New columns: `lead_sales_type`,
`lead_stage_since`, `lead_next_action{,_date,_owner_id,_outcome}`,
`lead_manager_id`, `lead_manager_assigned_at`, `lead_verified_at`,
`lead_verified_by_id`, `lead_monthly_litres`, `lead_competitor`,
`lead_required_product_id`, `lead_decision_maker`, `lead_credit_days_wanted`,
`lead_application`, `lead_qualification` (jsonb), `lead_suspect_decided_at`,
`lead_distributor_salesman_id`, `lead_expected_order_date`,
`lead_expected_order_value_paise`.

New tables: `lead_stage_transitions`, `lead_manager_calls`,
`distributor_profiles`, `distributor_salesmen`, `sample_feedback`.
`mbos_samples` gained a `state` machine and dispatch/courier/review columns.
`customer_distributors` gained `distributor_salesman_id`. `mbos_leads` is gone.

**Engines, pure, no I/O, no clock.**

- `src/lib/engines/lead-ladder.ts` — `ladderFor`, `nextStage`, `previousStage`,
  `directionOf`, `bandOf`, `isTerminal`, `promotesToCustomerAt`, `isOnTheBookAt`.
- `src/lib/engines/lead-gates.ts` — `gateTo`, `gateForNext`, `checklistFor`,
  `mustDecideSuspect`, `approvalRouteReason`, `ladderVerdicts`, and the three
  condition lists.
- `src/lib/lead-labels.ts` — client-safe vocabulary: `LeadStage`,
  `LeadSalesType`, `SampleState`, stage labels, the four reason lists, the
  twelve verification questions, the seven feedback fields, the fifteen-row
  `NURTURE_SEQUENCE`, the eleven `COMMUNICATION_ACTIONS`, the eight
  `FIRST_ORDER_QUESTIONS`.

**Config**, in `lib/config/registry.ts`: `leads.suspectMaxVisits`,
`leads.requireNextAction`, `leads.allowManagerOverride`,
`leads.prospectReasons`, `leads.sampleReasons`, `leads.lostReasons`,
`leads.overrideReasons`, `leads.sampleReviewChaseDays`,
`leads.verificationDueDays`, `leads.distributorDiscountApprovalPercent`,
`leads.distributorCreditLimitApprovalPaise`.

## Decisions already taken — do not relitigate

1. **`kind` flips at the FIRST order**, not the second. `promotesToCustomerAt()`
   is the one place that is decided. The ladder keeps its own `second_order` and
   `customer` rungs. §22's word and MahekOne's word are separated, not merged.
2. **§20 renders the existing order and payment state on the lead.** There is no
   second order-status ladder. `orders.status` comes from the sheet and from
   accounts' approval and must not be written from here.
3. **"Management" is a new capability**, `distributor.approve`, held by admin.
   `stepIndex` 0 is the sales manager, 1 is management.
4. **A distributor becomes billable at `distributor_approval`.**
5. **Gate overrides are allowed, recorded and manager-only**, behind
   `leads.allowManagerOverride`.

## House rules that will fail review if broken

- Reads in `lib/queries.ts` or a `lib/services/*`; writes in `lib/actions/*`.
  Every action returns the `Result` type from `lib/result.ts`.
- Capabilities are checked **in the action**, never only by hiding a control.
  Disabled controls carry a `title` saying why.
- Money is paise, integers. Quantity is cans.
- Never cast a stored timestamp to a date without naming the zone; never
  `toISOString().slice(0,10)`; never a local-zone getter in `src/`. Use
  `calendarDate()`, `APP_TIMEZONE`, `stamp`/`stampDate`/`clock`.
- **Never bind a JS `Date` into a raw `sql` template** — the driver throws on
  Node 25 and it comes back as a *retry*, so the queue resends for ever. Pass
  `.toISOString()`.
- Never put backticks inside a `` sql`` `` template literal.
- Do not run `drizzle-kit generate`. Migrations are hand-written; 0096 and 0097
  are taken, start at 0098 and add a `_journal.json` entry with `when` above
  `1787502280000`.
- React Compiler is on: no state reset in an effect on a prop change (give the
  component a `key`), and no clock read during render.
- A paged read needs a tiebreaker in its sort.
- In raw SQL, qualify every column of the outer table (`customers.id`, not
  `${customers.id}`) inside a correlated subquery.

## The server actions — signatures are fixed, workstream A owns the file

`src/lib/actions/leads.ts`:

```ts
advanceLeadStage(input: {
  customerId: string;
  to: LeadStage;
  reasonCode?: string;
  note?: string;
  override?: { reasonCode: string; note?: string };
  nextAction?: { action: string; date: string; ownerId: string; outcome?: string };
}): Promise<Result<{ stage: LeadStage; promoted: boolean }>>

setLeadSalesType(customerId, salesType, reason?): Promise<Result<null>>
saveLeadQualification(customerId, answers: Record<string, boolean | string>): Promise<Result<null>>
saveProspectFields(customerId, fields): Promise<Result<null>>
setLeadNextAction(customerId, { action, date, ownerId, outcome? }): Promise<Result<null>>
decideSuspect(customerId, { prospect: boolean; reasonCode: string; note?: string }): Promise<Result<null>>
assignLeadManager(customerId, managerId?): Promise<Result<null>>
recordVerificationCall(customerId, { answers, verified, followUpNote? }): Promise<Result<null>>
recordCommunication(customerId, { actionCode, documentId?, note? }): Promise<Result<null>>
askForFirstOrder(customerId, { answers, expectedDate, expectedValuePaise? }): Promise<Result<null>>
```

`src/lib/actions/lead-samples.ts` (workstream B):

```ts
requestSample(customerId, { productId, quantityCans, application, reasonCode }): Promise<Result<{ id: string }>>
decideSample(sampleId, { approve: boolean; note?: string }): Promise<Result<null>>
dispatchSample(sampleId, { courierName, courierDocket, expectedDeliveryDate }): Promise<Result<null>>
confirmSampleReceived(sampleId, { at?: string }): Promise<Result<null>>
recordSampleFeedback(sampleId, { fields, trialOutcome }): Promise<Result<null>>
cancelSample(sampleId, reason): Promise<Result<null>>
```

`src/lib/actions/distributor-appointment.ts` (workstream B):

```ts
saveDistributorProfile(customerId, patch): Promise<Result<null>>
submitForManagementReview(customerId, note?): Promise<Result<null>>
agreeCommercialTerms(customerId, { discountPercent, creditLimitPaise, exclusivity, note }): Promise<Result<null>>
decideDistributorAppointment(approvalId, { approve, note }): Promise<Result<null>>
recordDistributorAgreement(customerId, { attachmentId? }): Promise<Result<null>>
createDistributorSalesman(distributorCustomerId, { name, mobile?, territory? }): Promise<Result<{ id: string }>>
```

## Reads

- Workstream A owns `src/lib/services/lead-service.ts` — one lead with
  everything the gate engine needs (`leadGateInput(customerId)`), its
  transitions, its manager calls.
- Workstream D owns `src/lib/services/lead-console-service.ts` — the console's
  lists: verification queue, funnel by sales type, leads with no next action,
  the distributor appointment queue, the sample desk.
- Nobody else edits either file.

## Capabilities to add in `src/lib/access-control.ts` (workstream A)

- `lead.work` — salesman and manager. Move a lead up its ladder.
- `lead.override` — manager only. Pass a shut gate.
- `lead.verify` — manager only. Record the verification call.
- `distributor.approve` — admin only. The second approval step.

`sample.approve` reuses the existing approvals machinery; route it through
`mbos_approvals` with `type = 'sample'`.

## File ownership — do not edit outside your list

| Stream | Owns |
|---|---|
| A server-lead | `src/lib/actions/leads.ts`, `src/lib/services/lead-service.ts`, `src/lib/access-control.ts`, `src/lib/actions/mbos.ts` |
| B server-sample | `src/lib/actions/lead-samples.ts`, `src/lib/actions/distributor-appointment.ts`, `src/lib/engines/lead-nurture.ts`, `src/lib/services/sample-service.ts`, `src/lib/services/distributor-service.ts`, `src/lib/mbos-jobs.ts` |
| C handset | `mbos-app/**` only |
| D console | `src/app/sales/**`, `src/lib/services/lead-console-service.ts` |
| E tests + CRM | `src/lib/engines/*.test.ts`, `src/lib/queries.ts`, `src/lib/services/owner-dashboard-service.ts` |

If you need something outside your list, write it in your own file and leave a
`TODO(integration)` comment naming what you need. Do not edit another stream's
file.
