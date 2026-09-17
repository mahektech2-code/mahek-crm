import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import type { LeadSalesType, LeadStage } from "../lead-labels";
import { leadsVisible, managerScope } from "./sales-service";

/* ---------------------------------------------------------------------------
 * §11 §12 — one distributor candidate, whole.
 *
 * The queue at `/sales/leads/appointments` answers "what is waiting on a
 * signature". It cannot answer "and should I sign it", because that question is
 * thirty conditions, a warehouse, a dealer network, two sets of commercial
 * numbers and whatever the sales manager wrote when he put them up — none of
 * which fits in a row. This file is every read behind the record that does.
 *
 * **Its own service rather than more of `lead-console-service.ts`.** That file
 * is the funnel's QUEUES: list questions, scoped, capped, one row per waiting
 * thing. This is one candidate read in full, which has almost no SQL in common
 * with any of them — and folding it in would give every queue a `to_jsonb(dp.*)`
 * it pays for and never reads.
 *
 * **Scope is resolved HERE and never passed in**, the same rule the console
 * service states: `managerScope()` reads the session inside the function, so
 * there is no call site that can forget the filter. A forgotten filter is
 * silent, looks like working software, and shows a regional manager the whole
 * country.
 *
 * **Raw SQL, every outer column qualified, no bare casts.** Drizzle renders
 * `${customers.id}` as a bare `"id"`, which inside a correlated subquery binds
 * to the INNER table and makes the condition silently false. Every date column
 * here comes back `::text` rather than as an instant, because a stored DATE is
 * not an instant until something names the midnight and the session's zone is
 * not a property of the row.
 * ------------------------------------------------------------------------- */

/**
 * The thirty answers, as they stand.
 *
 * Every column of `distributor_profiles`, because the record's whole job is to
 * show a director what somebody is asking him to sign — a panel that showed the
 * seven that fit would be a summary of an application, and the point of §11 is
 * that appointing a distributor is not a summary decision.
 *
 * The two nullable booleans are carried as `boolean | null` rather than
 * defaulted to false on the way out. See the note on them in `schema.ts`: a
 * candidate with no godown is ordinary, and reading "unanswered" as "no" would
 * put a fact on the screen that nobody established.
 */
export type DistributorProfileRow = {
  /* business and legal */
  gstVerified: boolean;
  panNumber: string | null;
  panVerified: boolean;
  businessAddressVerified: boolean;
  businessType: string | null;
  yearsInBusiness: number | null;
  decisionMaker: string | null;

  /* distribution capability */
  hasDealerNetwork: boolean | null;
  activeDealerCount: number | null;
  territoryCovered: string | null;
  citiesCovered: string | null;
  salesTeamSize: number | null;
  deliveryCapability: string | null;
  hasWarehouse: boolean | null;
  /** Litres, the unit every capacity in MahekOne is measured in. */
  storageCapacityLitres: number | null;

  /* commercial capability */
  productPortfolio: string | null;
  competitorBrands: string | null;
  monthlyPotentialPaise: number | null;
  initialOrderPotentialPaise: number | null;
  investmentCapacityPaise: number | null;
  expectedMonthlyPurchasePaise: number | null;
  creditDaysRequired: number | null;
  /** What they ASKED for. `agreedCreditLimitPaise` is what we offered. */
  creditLimitRequiredPaise: number | null;

  /* territory */
  proposedTerritory: string | null;
  existingDistributorChecked: boolean;
  territoryConflict: boolean | null;
  territoryConflictNote: string | null;
  /** Asking for it. `exclusivityGranted` is a different fact entirely. */
  exclusivityRequested: boolean | null;

  /* commitment */
  initialStockCommitmentPaise: number | null;
  monthlyPurchaseCommitmentPaise: number | null;
  dealerDevelopmentCommitment: string | null;
  expectedStartDate: string | null;

  /* §12 — the three that decide whether one signature is enough */
  specialDiscountPercent: number | null;
  agreedCreditLimitPaise: number | null;
  exclusivityGranted: boolean | null;
  commercialTermsNote: string | null;
  commercialTermsAgreedAt: Date | string | null;
};

/** The candidate itself — who they are, and where on the ladder they stand. */
export type AppointmentCandidate = {
  customerId: string;
  name: string;
  companyName: string | null;
  city: string | null;
  area: string | null;
  mobile: string | null;
  contactPerson: string | null;
  gstin: string | null;
  kind: string;
  salesType: LeadSalesType | null;
  stage: LeadStage;
  stageSince: string | null;
  archived: boolean;
  salesmanId: string | null;
  salesmanName: string | null;
  leadManagerId: string | null;
  leadManagerName: string | null;
  /* §24 — what is owed on this lead, which every upward move demands. */
  nextAction: string | null;
  nextActionDate: string | null;
  nextActionOwnerId: string | null;
  nextActionOwnerName: string | null;
};

/**
 * One step of §12's chain, decided or waiting.
 *
 * `stepIndex` 0 is the sales manager, who knows whether that territory already
 * has somebody in it. 1 is management, and it exists because a discount, a
 * credit limit or exclusivity is a decision with a cost — the person carrying
 * the target must not be the person allowing it, which is the same reasoning
 * that keeps `order.approve` away from managers entirely.
 *
 * Decided rows are read as well as pending ones, unlike the queue: the queue
 * asks what is waiting, and a record has to be able to say that step 0 was
 * refused in March and by whom. A step with no row at all is a step nobody has
 * ASKED for, which is a third state and is said in those words.
 */
export type AppointmentStep = {
  approvalId: string;
  stepIndex: number;
  state: string;
  /** Why this step exists, as the row recorded it when it was raised. */
  routeReason: string | null;
  reason: string | null;
  requestedAt: Date | string;
  requestedByName: string | null;
  approverName: string | null;
  decidedAt: Date | string | null;
  decisionNote: string | null;
};

/**
 * §23 — the distributor's own salesman.
 *
 * DELIBERATELY NOT A `users` ROW, and this is the thing somebody will one day
 * try to "fix". Rahul works for the distributor. He has no MahekOne login, he
 * will never sign in, and giving him one would put him in every person picker
 * in the product — the salesperson dropdown, the reassignment dialog, the
 * target screen, the approval chain — as somebody who can never answer any of
 * them. He is a fact about how a shop is served, exactly as
 * `sales_person_name` is, and the chain Mahek → distributor → his salesman →
 * the shop is recorded from the first visit rather than reconstructed at
 * conversion.
 */
export type DistributorSalesmanRow = {
  id: string;
  name: string;
  mobile: string | null;
  territory: string | null;
  active: boolean;
  /** How many shops this record says he serves. Real rows, never a guess. */
  shopCount: number;
};

/** §25 — when each rung was entered, for the ladder to date itself from. */
export type StageMove = {
  id: string;
  toStage: LeadStage;
  fromStage: LeadStage | null;
  kind: string;
  note: string | null;
  actorName: string | null;
  at: Date | string;
};

export type DistributorAppointmentRecord = {
  candidate: AppointmentCandidate;
  /** Null where nobody has started the application. A named gap, not an empty panel. */
  profile: DistributorProfileRow | null;
  steps: AppointmentStep[];
  salesmen: DistributorSalesmanRow[];
  moves: StageMove[];
};

/* ------------------------------------------------------------ resolution */

/**
 * The id in the URL is the CUSTOMER's, and an approval id resolves to it.
 *
 * The queue draws one row per approval and a candidate with two steps has two
 * approval ids, so a link built from the row somebody was looking at would open
 * one of two URLs for one distributor — two addresses for one record, with the
 * browser's history and anybody's bookmark unable to say they are the same
 * thing. The customer is the subject; both steps are panels on it.
 *
 * An approval id is still accepted and redirected in meaning rather than
 * refused, because that is the id the queue has in its hand and a 404 on it
 * would read as the record not existing.
 */
async function subjectIdFor(id: string): Promise<string> {
  const rows = (await db.execute(sql`
    select a.subject_id as "customerId"
      from mbos_approvals a
     where a.id = ${id}
       and a.type = 'distributor_appointment'
       and a.subject_type = 'customers'
     limit 1
  `)) as unknown as { customerId: string }[];
  return rows[0]?.customerId ?? id;
}

/* ----------------------------------------------------------------- reads */

/**
 * The candidate and their application, or null.
 *
 * Null covers both "no such customer" and "not in this manager's territory",
 * and the two are deliberately one answer: a 404 that distinguished them would
 * make the URL a way to find out whose book an id belongs to.
 */
export async function appointmentCandidate(
  customerId: string,
): Promise<{ candidate: AppointmentCandidate; profile: DistributorProfileRow | null } | null> {
  const scope = await managerScope();

  const rows = (await db.execute(sql`
    select c.id as "customerId", c.name, c.company_name as "companyName",
           c.city, c.area, c.phone as mobile,
           c.contact_person as "contactPerson", c.gstin,
           c.kind::text as kind,
           c.lead_sales_type::text as "salesType",
           c.lead_stage::text as stage,
           c.lead_stage_since::text as "stageSince",
           c.lead_archived as archived,
           c.owner_id as "salesmanId", u.name as "salesmanName",
           c.lead_manager_id as "leadManagerId", m.name as "leadManagerName",
           c.lead_next_action as "nextAction",
           c.lead_next_action_date::text as "nextActionDate",
           c.lead_next_action_owner_id as "nextActionOwnerId",
           na.name as "nextActionOwnerName",

           p.id as "profileId",
           p.gst_verified as "gstVerified",
           p.pan_number as "panNumber",
           p.pan_verified as "panVerified",
           p.business_address_verified as "businessAddressVerified",
           p.business_type as "businessType",
           p.years_in_business as "yearsInBusiness",
           p.decision_maker as "decisionMaker",
           p.has_dealer_network as "hasDealerNetwork",
           p.active_dealer_count as "activeDealerCount",
           p.territory_covered as "territoryCovered",
           p.cities_covered as "citiesCovered",
           p.sales_team_size as "salesTeamSize",
           p.delivery_capability as "deliveryCapability",
           p.has_warehouse as "hasWarehouse",
           p.storage_capacity_litres as "storageCapacityLitres",
           p.product_portfolio as "productPortfolio",
           p.competitor_brands as "competitorBrands",
           p.monthly_potential_paise as "monthlyPotentialPaise",
           p.initial_order_potential_paise as "initialOrderPotentialPaise",
           p.investment_capacity_paise as "investmentCapacityPaise",
           p.expected_monthly_purchase_paise as "expectedMonthlyPurchasePaise",
           p.credit_days_required as "creditDaysRequired",
           p.credit_limit_required_paise as "creditLimitRequiredPaise",
           p.proposed_territory as "proposedTerritory",
           p.existing_distributor_checked as "existingDistributorChecked",
           p.territory_conflict as "territoryConflict",
           p.territory_conflict_note as "territoryConflictNote",
           p.exclusivity_requested as "exclusivityRequested",
           p.initial_stock_commitment_paise as "initialStockCommitmentPaise",
           p.monthly_purchase_commitment_paise as "monthlyPurchaseCommitmentPaise",
           p.dealer_development_commitment as "dealerDevelopmentCommitment",
           p.expected_start_date::text as "expectedStartDate",
           p.special_discount_percent as "specialDiscountPercent",
           p.agreed_credit_limit_paise as "agreedCreditLimitPaise",
           p.exclusivity_granted as "exclusivityGranted",
           p.commercial_terms_note as "commercialTermsNote",
           p.commercial_terms_agreed_at as "commercialTermsAgreedAt"
      from customers c
      left join distributor_profiles p on p.customer_id = c.id
      left join users u on u.id = c.owner_id
      left join users m on m.id = c.lead_manager_id
      left join users na on na.id = c.lead_next_action_owner_id
     where c.id = ${customerId}
       ${leadsVisible(scope)}
     limit 1
  `)) as unknown as Record<string, unknown>[];

  const r = rows[0];
  if (!r) return null;

  const candidate: AppointmentCandidate = {
    customerId: String(r.customerId),
    name: String(r.name),
    companyName: (r.companyName as string | null) ?? null,
    city: (r.city as string | null) ?? null,
    area: (r.area as string | null) ?? null,
    mobile: (r.mobile as string | null) ?? null,
    contactPerson: (r.contactPerson as string | null) ?? null,
    gstin: (r.gstin as string | null) ?? null,
    kind: String(r.kind),
    salesType: (r.salesType as LeadSalesType | null) ?? null,
    stage: r.stage as LeadStage,
    stageSince: (r.stageSince as string | null) ?? null,
    archived: Boolean(r.archived),
    salesmanId: (r.salesmanId as string | null) ?? null,
    salesmanName: (r.salesmanName as string | null) ?? null,
    leadManagerId: (r.leadManagerId as string | null) ?? null,
    leadManagerName: (r.leadManagerName as string | null) ?? null,
    nextAction: (r.nextAction as string | null) ?? null,
    nextActionDate: (r.nextActionDate as string | null) ?? null,
    nextActionOwnerId: (r.nextActionOwnerId as string | null) ?? null,
    nextActionOwnerName: (r.nextActionOwnerName as string | null) ?? null,
  };

  /* The LEFT JOIN is what makes the gap detectable: no `profileId` means no
     application has been started, which is a different fact from thirty blank
     answers and reads differently on the screen. */
  const profile: DistributorProfileRow | null = r.profileId
    ? {
        gstVerified: Boolean(r.gstVerified),
        panNumber: (r.panNumber as string | null) ?? null,
        panVerified: Boolean(r.panVerified),
        businessAddressVerified: Boolean(r.businessAddressVerified),
        businessType: (r.businessType as string | null) ?? null,
        yearsInBusiness: numOrNull(r.yearsInBusiness),
        decisionMaker: (r.decisionMaker as string | null) ?? null,
        hasDealerNetwork: boolOrNull(r.hasDealerNetwork),
        activeDealerCount: numOrNull(r.activeDealerCount),
        territoryCovered: (r.territoryCovered as string | null) ?? null,
        citiesCovered: (r.citiesCovered as string | null) ?? null,
        salesTeamSize: numOrNull(r.salesTeamSize),
        deliveryCapability: (r.deliveryCapability as string | null) ?? null,
        hasWarehouse: boolOrNull(r.hasWarehouse),
        storageCapacityLitres: numOrNull(r.storageCapacityLitres),
        productPortfolio: (r.productPortfolio as string | null) ?? null,
        competitorBrands: (r.competitorBrands as string | null) ?? null,
        monthlyPotentialPaise: numOrNull(r.monthlyPotentialPaise),
        initialOrderPotentialPaise: numOrNull(r.initialOrderPotentialPaise),
        investmentCapacityPaise: numOrNull(r.investmentCapacityPaise),
        expectedMonthlyPurchasePaise: numOrNull(r.expectedMonthlyPurchasePaise),
        creditDaysRequired: numOrNull(r.creditDaysRequired),
        creditLimitRequiredPaise: numOrNull(r.creditLimitRequiredPaise),
        proposedTerritory: (r.proposedTerritory as string | null) ?? null,
        existingDistributorChecked: Boolean(r.existingDistributorChecked),
        territoryConflict: boolOrNull(r.territoryConflict),
        territoryConflictNote: (r.territoryConflictNote as string | null) ?? null,
        exclusivityRequested: boolOrNull(r.exclusivityRequested),
        initialStockCommitmentPaise: numOrNull(r.initialStockCommitmentPaise),
        monthlyPurchaseCommitmentPaise: numOrNull(r.monthlyPurchaseCommitmentPaise),
        dealerDevelopmentCommitment: (r.dealerDevelopmentCommitment as string | null) ?? null,
        expectedStartDate: (r.expectedStartDate as string | null) ?? null,
        specialDiscountPercent: numOrNull(r.specialDiscountPercent),
        agreedCreditLimitPaise: numOrNull(r.agreedCreditLimitPaise),
        exclusivityGranted: boolOrNull(r.exclusivityGranted),
        commercialTermsNote: (r.commercialTermsNote as string | null) ?? null,
        commercialTermsAgreedAt: (r.commercialTermsAgreedAt as Date | string | null) ?? null,
      }
    : null;

  return { candidate, profile };
}

/**
 * Both steps, decided or waiting, oldest step first.
 *
 * Ordered by `step_index` rather than by date, because the chain is a sequence
 * and drawing it newest-first would put management above the sales manager who
 * has not answered yet — which reads as management having gone first.
 */
export async function appointmentSteps(customerId: string): Promise<AppointmentStep[]> {
  return db.execute<AppointmentStep>(sql`
    select a.id as "approvalId",
           a.step_index as "stepIndex",
           a.state::text as state,
           a.route_reason as "routeReason",
           a.reason,
           a.requested_at as "requestedAt",
           r.name as "requestedByName",
           d.name as "approverName",
           a.decided_at as "decidedAt",
           a.decision_note as "decisionNote"
      from mbos_approvals a
      left join users r on r.id = a.requested_by_user_id
      left join users d on d.id = a.approver_user_id
     where a.type = 'distributor_appointment'
       and a.subject_type = 'customers'
       and a.subject_id = ${customerId}
     order by a.step_index asc, a.requested_at asc, a.id asc
     limit 20
  `) as unknown as AppointmentStep[];
}

/**
 * The distributor's own people, and how many shops each of them serves.
 *
 * The count comes from `customer_distributors`, which is where the chain is
 * actually recorded — a shop naming this distributor AND naming him. Counted in
 * SQL rather than by loading the shops, because the record wants the number and
 * a screen listing four hundred counters is a different screen.
 *
 * Inactive ones are read too and said to be inactive. A salesman who has left
 * the distributor is still who served those shops, and dropping him from the
 * list would leave the shops he served pointing at nobody.
 */
export async function distributorSalesmen(
  customerId: string,
): Promise<DistributorSalesmanRow[]> {
  return db.execute<DistributorSalesmanRow>(sql`
    select s.id, s.name, s.mobile, s.territory, s.active,
           (select count(*)::int
              from customer_distributors cd
             where cd.distributor_salesman_id = s.id) as "shopCount"
      from distributor_salesmen s
     where s.distributor_customer_id = ${customerId}
     order by s.active desc, s.name asc, s.id asc
     limit 100
  `) as unknown as DistributorSalesmanRow[];
}

/**
 * §25 — every rung this candidate has entered, newest first.
 *
 * The ladder panel dates each rung from this rather than from
 * `lead_stage_since`, which only knows about the rung they are standing on. A
 * manager reading a stalled appointment is asking when it stopped, and that is
 * a question about the rung BELOW the current one.
 */
export async function appointmentStageMoves(customerId: string): Promise<StageMove[]> {
  return db.execute<StageMove>(sql`
    select t.id, t.to_stage::text as "toStage", t.from_stage::text as "fromStage",
           t.kind::text as kind, t.note, u.name as "actorName", t.at
      from lead_stage_transitions t
      left join users u on u.id = t.actor_id
     where t.customer_id = ${customerId}
     order by t.at desc, t.id desc
     limit 60
  `) as unknown as StageMove[];
}

/**
 * The whole record, in one call.
 *
 * The four reads run together rather than in sequence — none of them depends on
 * another, and a record page that costs the sum of its panels is a record page
 * somebody stops opening.
 */
export async function distributorAppointmentRecord(
  id: string,
): Promise<DistributorAppointmentRecord | null> {
  const customerId = await subjectIdFor(id);

  const head = await appointmentCandidate(customerId);
  if (!head) return null;

  const [steps, salesmen, moves] = await Promise.all([
    appointmentSteps(customerId),
    distributorSalesmen(customerId),
    appointmentStageMoves(customerId),
  ]);

  return { candidate: head.candidate, profile: head.profile, steps, salesmen, moves };
}

/* --------------------------------------------------------------- helpers */

/**
 * `db.execute` hands back a bigint as a string whatever the type says, so a
 * paise column arrives as `"4500000"` and `"4500000" > threshold` compares
 * lexically. Coerced once here rather than at every reader — money that is a
 * string somewhere in the middle of a screen is how a credit limit of ninety
 * lakh sorts below one of a lakh.
 */
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Three-valued, and it has to stay that way. See the note on the columns. */
function boolOrNull(v: unknown): boolean | null {
  if (v === null || v === undefined) return null;
  return Boolean(v);
}
