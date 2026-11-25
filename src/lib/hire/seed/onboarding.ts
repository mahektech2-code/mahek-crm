import type { BlueprintDefinition, Stage } from "../blueprint-types";
import type { ContentBlock, McqQuestion, ModuleDefinition, TrackDefinition, TrainingCategory } from "@/lib/training/types";
import { ACCOUNTS_EXECUTIVE, SALES_EXECUTIVE, TELECALLER } from "./blueprints";

/* ---------------------------------------------------------------------------
 * THE ONBOARDING PRD, SEEDED. New versions of the role blueprints in the PRD's
 * order, the incentive plan the Sales Executive offers use, the employment
 * document templates, and the training modules and tracks of PRD §13–17.
 *
 * PRODUCT, POLICY AND CREDIT WORDING IS NOT WRITTEN HERE. The PRD asks for
 * "approved training material" and says no employee may promise unapproved
 * terms, so every block that would state a fact about a product or a policy
 * is a bracketed placeholder for the person who owns it to fill. The
 * questions are about the process and the CRM — things this codebase knows —
 * and every one is UNAPPROVED until a person reads it, except in the demo.
 * On a real deployment all of this lands as DRAFTS; nothing is published
 * behind HR's back.
 * ------------------------------------------------------------------------- */

const plain = (key: string, name: string, type: Stage["type"], slaHours: number): Stage => ({
  key,
  name,
  type,
  maxPoints: 0,
  passThreshold: 70,
  autoRejectFloor: null,
  strongSignal: null,
  graceRange: 5,
  slaHours,
  questions: [],
  approved: true,
  ai: false,
});

const EMPLOYMENT_DOCS: NonNullable<BlueprintDefinition["employmentDocs"]> = [
  { key: "offer", label: "Offer letter", templateKey: "offer-letter", hardCopy: true, required: true },
  { key: "contract", label: "Appointment contract", templateKey: "appointment-contract", hardCopy: true, required: true },
  { key: "rr", label: "Roles & responsibilities", templateKey: "roles-responsibilities", hardCopy: false, required: true },
  { key: "growth", label: "Company growth plan", templateKey: "growth-plan", hardCopy: false, required: true },
  { key: "rulebook", label: "Rule-book acknowledgement", templateKey: "policy-acknowledgement", hardCopy: true, required: true },
];

const INTROS = [
  { key: "accounts", label: "Accounting" },
  { key: "logistics", label: "Logistics" },
  { key: "hr", label: "HR" },
  { key: "sales-head", label: "Sales Head" },
  { key: "rm", label: "Relationship Manager" },
  { key: "production", label: "Production" },
];

/** PRD §7's checklist, added to what each role already collects. */
function prdDocuments(base: BlueprintDefinition["documents"]): BlueprintDefinition["documents"] {
  const extra: BlueprintDefinition["documents"] = [
    { key: "resume", label: "Resume / CV", kind: "resume", mandatory: true, verify: false, retentionMonths: 24, pii: "personal", approved: true, ai: false },
    { key: "education", label: "Education certificates", kind: "education", mandatory: true, verify: true, retentionMonths: 84, pii: "personal", approved: true, ai: false },
    { key: "experience", label: "Experience letter · previous employer", kind: "experience", mandatory: false, verify: true, retentionMonths: 84, pii: "personal", approved: true, ai: false },
  ];
  return [
    ...extra,
    ...base.map((d) => (d.key === "payslips" ? { ...d, label: "Salary slips · last 6 months", retentionMonths: 24 } : d.key === "bank" ? { ...d, label: "Cancelled cheque (or one month’s bank statement)" } : d)),
  ];
}

/** Rebuild a role in the PRD's order: everything up to the gate as it was, then the onboarding flow. */
function onboardingFlow(base: BlueprintDefinition, opts: { trackKey: string; planKeys: string[]; incentive: boolean; assets: BlueprintDefinition["onboarding"]["assets"]; components: { key: string; label: string }[] }): BlueprintDefinition {
  const d = structuredClone(base);
  const gate = d.stages.findIndex((s) => s.type === "decision_gate");
  const setup = d.stages.find((s) => s.type === "system_setup");
  d.stages = [
    ...d.stages.slice(0, gate + 1),
    plain("comp", "Compensation", "compensation", 72),
    plain("doc", "Documents & verification", "document_collection", 120),
    plain("empdocs", "Employment documents", "employment_docs", 168),
    { ...(setup ?? plain("setup", "Provision", "system_setup", 24)), name: "Provision" },
    plain("kit", "Assets & induction", "checklist", 72),
    plain("training", "Training", "training", 24 * 30),
  ];
  d.documents = prdDocuments(d.documents);
  d.offer = { ...d.offer, incentiveApplicable: opts.incentive, incentivePlanKeys: opts.planKeys, components: opts.components, incentive: opts.incentive ? d.offer.incentive : "Not applicable" };
  d.employmentDocs = EMPLOYMENT_DOCS;
  d.onboarding = { ...d.onboarding, assets: opts.assets, intros: INTROS, modules: [] };
  d.training = { trackKey: opts.trackKey, trainerId: null };
  return d;
}

export const SALES_EXECUTIVE_V4: BlueprintDefinition = onboardingFlow(SALES_EXECUTIVE, {
  trackKey: "sales-executive-onboarding",
  planKeys: ["sales-executive-monthly"],
  incentive: true,
  components: [
    { key: "ta", label: "Travel allowance" },
    { key: "mobile", label: "Mobile reimbursement" },
  ],
  assets: [
    { key: "sim", label: "SIM card", serial: true, acknowledge: true },
    { key: "orderbook", label: "Order book", serial: true, acknowledge: true },
    { key: "cards", label: "Visiting cards", serial: false, acknowledge: true },
    { key: "idcard", label: "Employee ID card", serial: true, acknowledge: true },
    { key: "vouchers", label: "Product vouchers", serial: true, acknowledge: true },
    { key: "phone", label: "Handset for MBOS", serial: true, acknowledge: true },
    { key: "bag", label: "Sample bag", serial: false, acknowledge: true, applicableByDefault: false },
  ],
});

export const TELECALLER_V2: BlueprintDefinition = onboardingFlow(TELECALLER, {
  trackKey: "telecaller-onboarding",
  planKeys: [],
  incentive: false,
  components: [],
  assets: [
    { key: "headset", label: "Headset", serial: true, acknowledge: true },
    { key: "idcard", label: "Employee ID card", serial: true, acknowledge: true },
  ],
});

export const ACCOUNTS_EXECUTIVE_V3: BlueprintDefinition = onboardingFlow(ACCOUNTS_EXECUTIVE, {
  trackKey: "accountant-onboarding",
  planKeys: [],
  incentive: false,
  components: [],
  assets: [{ key: "idcard", label: "Employee ID card", serial: true, acknowledge: true }],
});

/* -------------------------------------------------------- incentive plan */

const L = 100 * 100_000;
export const SEED_INCENTIVE_PLANS = [
  {
    key: "sales-executive-monthly",
    title: "Sales Executive · monthly slabs",
    designations: ["Sales Executive (S1)", "Senior Sales Executive (S2)"],
    basis: "Monthly invoiced sales, net of returns",
    mode: "whole" as const,
    /* The PRD's thresholds. The RATES are placeholders until the Sales Head sets them. */
    slabs: [
      { fromPaise: 0, toPaise: 5 * L, kind: "percent" as const, value: 0 },
      { fromPaise: 5 * L, toPaise: 7.5 * L, kind: "percent" as const, value: 1 },
      { fromPaise: 7.5 * L, toPaise: 10 * L, kind: "percent" as const, value: 1.5 },
      { fromPaise: 10 * L, toPaise: 12.5 * L, kind: "percent" as const, value: 2 },
      { fromPaise: 12.5 * L, toPaise: 15 * L, kind: "percent" as const, value: 2.5 },
      { fromPaise: 15 * L, toPaise: null, kind: "percent" as const, value: 3 },
    ],
    conditions: "[The Sales Head’s conditions — when it is paid, what disqualifies a month.]",
  },
];

/* -------------------------------------------------------------- templates */

export const SEED_TEMPLATES = [
  {
    key: "offer-letter",
    title: "Offer letter",
    body: `Mahek Marketing India Pvt. Ltd.
{{today}}

Dear {{name}},

We are pleased to offer you the position of {{role}} at the grade of {{grade}}, based in {{location}}.

Basic salary: {{basic}}, from {{effective_date}}.
Total cost to company: {{ctc}}.
Other pay:
{{components}}

Incentive: {{incentive}}
{{incentive_slabs}}

Growth plan
{{growth_plan}}

We would like you to join on {{joining_date}}.

For Mahek Marketing India Pvt. Ltd.
Human Resources`,
  },
  {
    key: "appointment-contract",
    title: "Appointment contract",
    body: `APPOINTMENT CONTRACT

Between Mahek Marketing India Pvt. Ltd. and {{name}}, appointed as {{role}} ({{grade}}) at {{location}} from {{joining_date}}, on a basic salary of {{basic}}.

[The approved terms of employment — probation, notice period, confidentiality, conduct — as settled by the company’s legal adviser.]

Signed for the company: ____________   Signed by the employee: ____________   Date: ________`,
  },
  {
    key: "roles-responsibilities",
    title: "Roles & responsibilities",
    body: `ROLES & RESPONSIBILITIES — {{role}}

{{name}}, {{location}}

[The approved responsibilities for this role, one per line.]

I have read and understood my responsibilities.
Signature: ____________   Date: ________`,
  },
  {
    key: "growth-plan",
    title: "Company growth plan",
    body: `YOUR GROWTH PLAN — {{role}}

{{name}}, you join at {{grade}} on {{basic}}. The ladder from here:
{{growth_plan}}

The criteria above are the same ones your offer letter and briefing used.

Signature: ____________   Date: ________`,
  },
  {
    key: "policy-acknowledgement",
    title: "Rule-book acknowledgement",
    body: `RULE-BOOK ACKNOWLEDGEMENT

I, {{name}}, joining as {{role}} on {{joining_date}}, confirm I have received and read Mahek Marketing India’s rule book.

[The rule book’s version and the policies it covers.]

Signature: ____________   Date: ________`,
  },
];

/* ---------------------------------------------------------------- modules */

const T = (key: string, title: string, body: string, tone: "normal" | "safety" = "normal"): ContentBlock => ({ key, kind: "text", title, body, tone });
const PH = (what: string) => `[${what} — the approved wording from its owner.]`;

let qn = 0;
function Q(text: string, options: string[], correct: number, explanation: string, tags: string[], difficulty: McqQuestion["difficulty"] = "medium"): McqQuestion {
  qn += 1;
  const opts = options.map((t, i) => ({ key: String.fromCharCode(97 + i), text: t }));
  return { key: `q${qn}`, text, options: opts, correctKey: opts[correct].key, explanation, difficulty, tags, active: true, ai: false, approved: true };
}

function mod(definition: Partial<ModuleDefinition> & Pick<ModuleDefinition, "content" | "questions">): ModuleDefinition {
  return { passMarkPercent: 80, questionsPerAttempt: null, timerMinutes: 15, shuffleQuestions: true, shuffleOptions: true, feedback: "after_submit", minStudyMinutes: 5, ...definition };
}

const productModule = (name: string, match: string): ModuleDefinition =>
  mod({
    content: [
      T("overview", "Product overview and application", PH(`What ${name} is, where it is used and the customer who buys it`)),
      { key: "facts", kind: "product_facts", title: "Price list and packing", match },
      T("position", "Positioning and use case", PH(`${name}’s positioning against the alternatives`)),
      T("terms", "Discounts, terms and conditions", `${PH(`The discount rules and terms for ${name}`)}\n\nAnything outside these is the Sales Head’s decision — never promise it on the spot.`),
      T("points", "Sales points", PH(`${name}’s approved sales points`)),
      T("safety", "Usage, safety and handling", PH(`Storage, ventilation and handling of ${name} from its safety data sheet`), "safety"),
    ],
    questions: [
      Q(`A customer asks for a discount on ${name} beyond the published rules. What do you do?`, ["Give it if the order is large", "Promise it and tell the office later", "Say you will check, and ask the Sales Head", "Refuse to sell"], 2, "Discounts outside the published rules are the Sales Head’s decision, never the salesperson’s.", ["policy", "pricing"]),
      Q(`Where does the price you quote for ${name} come from?`, ["The last price the customer paid", "The price book in force today", "Your own judgement", "The competitor’s price"], 1, "Rates come from the price book in force — the same one the training module shows live.", ["pricing"], "easy"),
      Q(`A customer asks a technical question about ${name} you cannot answer. What is right?`, ["Guess, so the sale is not lost", "Say you will find out and come back", "Tell them it works for everything", "Change the subject"], 1, "Never guess about application or safety. Find out from the product team and come back.", ["application"], "easy"),
    ],
  });

export type SeedModule = { key: string; title: string; category: TrainingCategory; definition: ModuleDefinition };

export const SEED_MODULES: SeedModule[] = [
  {
    key: "thinner-basics",
    title: "What is Thinner · basic knowledge",
    category: "product",
    definition: mod({
      content: [T("what", "What is thinner?", PH("What thinner is")), T("why", "Why is it used?", PH("Why thinner is used and where")), T("compat", "Paint compatibility basics", PH("Which thinners go with which paints")), T("safety", "Handling and safety", PH("Handling and safety awareness"), "safety")],
      questions: [
        Q("Where should product and compatibility answers you give a customer come from?", ["Approved training material", "What another salesperson said", "The customer’s own experience", "Whatever sounds right"], 0, "Only approved material — the PRD is explicit that salespeople do not improvise product claims.", ["policy"], "easy"),
        Q("A shop asks which thinner to use with a paint you have not been trained on. You…", ["Recommend the cheapest", "Say you will check with the product team", "Recommend our best seller", "Tell them any thinner works"], 1, "Wrong thinner, wrong finish. Check before recommending.", ["application"]),
        Q("Before handling a drum at a customer’s site, what matters first?", ["Speed", "The safety and handling guidance", "The customer’s opinion", "Nothing"], 1, "Safety and handling first, every time.", ["safety"], "easy"),
      ],
    }),
  },
  { key: "product-universal", title: "Product Overview — Mahek Universal", category: "product", definition: productModule("Mahek Universal", "universal") },
  { key: "product-nc", title: "Product Overview — Mahek NC", category: "product", definition: productModule("Mahek NC", "nc") },
  { key: "product-nano", title: "Product Overview — Nano", category: "product", definition: productModule("Nano", "nano") },
  { key: "product-pu", title: "Product Overview — PU Thinner", category: "product", definition: productModule("PU Thinner", "pu") },
  { key: "product-mylac", title: "Product Overview — Mylac", category: "product", definition: productModule("Mylac", "mylac") },
  {
    key: "company-induction",
    title: "Company Induction",
    category: "induction",
    definition: mod({
      passMarkPercent: 70,
      content: [
        T("history", "Company history", PH("Mahek’s history")),
        T("mission", "Mission, vision and values", PH("The mission, vision and values")),
        T("rules", "The rule book", PH("The rule book’s main rules")),
        T("structure", "Organisation and departments", PH("The organisation structure and what each department does")),
        { key: "directory", kind: "directory", title: "Who to contact" },
        T("escalation", "Communication and escalation", PH("How and when to escalate")),
      ],
      questions: [
        Q("A customer’s payment question is best answered by…", ["Accounting", "Production", "Logistics", "HR"], 0, "Payments and statements are Accounting’s — the directory says who.", ["departments"], "easy"),
        Q("A delivery date question goes to…", ["HR", "Logistics", "Production", "Accounting"], 1, "Dispatch and delivery dates are Logistics’.", ["departments"], "easy"),
        Q("Where do you find who to contact for each desk?", ["Ask around", "The Contacts tab in the Training app", "The customer", "Nowhere"], 1, "The directory is kept in the Training app and the induction module.", ["departments"], "easy"),
      ],
    }),
  },
  {
    key: "customer-classification",
    title: "Customer Classification",
    category: "sales",
    definition: mod({
      content: [T("stages", "Customer stages", "Leads in MahekOne move up a ladder: Suspect, Prospect, Sample, and on to an active customer. Each step has its own gate in the CRM — you cannot skip one by typing.\n\n" + PH("The qualifying criteria for each stage")), T("hv", "Spotting a high-value customer", PH("The approved criteria for a potential or high-value customer"))],
      questions: [
        Q("A shop you have just found and not yet spoken to is a…", ["Suspect", "Active customer", "Sample", "Distributor"], 0, "A name not yet qualified is a Suspect.", ["lead stages"], "easy"),
        Q("Can you move a lead past a stage gate by editing its stage?", ["Yes", "Only on weekends", "No — the gate is enforced", "Only with a photo"], 2, "Stages move through their gates; an override is a manager’s, with a reason.", ["lead stages", "crm"]),
        Q("What decides that a customer is high-value?", ["Your instinct", "The approved criteria", "How friendly they are", "Their shop size alone"], 1, "Approved criteria, applied the same way by everybody.", ["lead stages"]),
      ],
    }),
  },
  {
    key: "prospecting",
    title: "Prospecting & Customer Search",
    category: "sales",
    definition: mod({
      content: [T("targets", "Who to look for", PH("Target customers: paint shops, counters, dealers")), T("search", "Finding new customers", "Capture every new shop as a lead in MBOS while you are there, with a photo and its location, so it is in the book the same day.\n\n" + PH("The approved prospecting method"))],
      questions: [
        Q("You find a new paint shop on your beat. When do you add it?", ["At the end of the month", "There and then, in MBOS", "Only once it orders", "Never — the office adds them"], 1, "Capture it there and then, with its location — tomorrow it is forgotten.", ["crm"], "easy"),
        Q("Which of these is a prospect worth recording?", ["A paint counter that sells thinner", "A grocery shop", "A tea stall", "A bank"], 0, "Paint shops, counters and dealers are the target.", ["prospecting"], "easy"),
      ],
    }),
  },
  {
    key: "relationship",
    title: "Customer Relationship & Follow-Up",
    category: "sales",
    definition: mod({
      content: [T("visit", "Conducting a visit", PH("How a visit is conducted")), T("followup", "Follow-up and repeat business", "Every visit and call is logged with its outcome and the next step, so the follow-up is on your list on the right day.\n\n" + PH("The approved follow-up rhythm"))],
      questions: [
        Q("After a visit, what must be recorded?", ["Nothing", "The outcome and the next step", "Only orders", "Only complaints"], 1, "Outcome and next step — that is what puts the follow-up on the right day.", ["crm"], "easy"),
        Q("A customer asked you to call back on Friday. Where does that live?", ["In your memory", "As the next step on the visit in MBOS", "On paper", "With your manager"], 1, "As the next step, so the reminder finds you.", ["crm"]),
      ],
    }),
  },
  {
    key: "objections",
    title: "Objection Handling",
    category: "objection",
    definition: mod({
      content: [
        T("approved", "What you may and may not promise", "Approved company policy is what you can say. Credit, pricing, exclusivity, discounts and delivery terms outside it are NOT yours to promise — say you will check."),
        T("price", "Price and low-cost requests", PH("How to answer a price objection")),
        T("credit", "Credit", PH("The credit policy")),
        T("delivery", "Transport and delivery", PH("Delivery and transport terms")),
        T("gst", "GST questions", PH("GST verification and questions")),
        T("competitor", "Competitor comparison", PH("The approved competitor comparison")),
        T("territory", "Territory and exclusivity requests", PH("The policy on territory and exclusivity")),
      ],
      questions: [
        Q("A dealer asks for exclusivity in his area. You…", ["Grant it to win the account", "Say it is company policy and you will ask", "Refuse rudely", "Promise it next month"], 1, "Exclusivity is a company decision, never the salesperson’s.", ["territory", "policy"]),
        Q("A customer wants 60 days’ credit. What can you promise?", ["60 days", "Whatever wins the order", "Only what the credit policy allows", "Unlimited credit"], 2, "Only what the approved policy allows — anything else, ask.", ["credit", "policy"]),
        Q("A customer insists a competitor is cheaper. You…", ["Match it immediately", "Use the approved comparison and check before changing price", "Agree and leave", "Criticise the competitor"], 1, "Use the approved comparison; prices change only through the price desk.", ["competitor", "pricing"]),
      ],
    }),
  },
  {
    key: "commercial",
    title: "Commercial Terms / GST / Credit / Logistics",
    category: "commercial",
    definition: mod({
      content: [T("terms", "Commercial terms", PH("Commercial terms")), T("gst", "GST verification", "A customer’s GSTIN is verified before a bill carries it.\n\n" + PH("GST rules for orders")), T("logistics", "Logistics", PH("Dispatch and transport rules"))],
      questions: [
        Q("Before an order is billed with a GSTIN, the GSTIN must be…", ["Typed carefully", "Verified", "Approved by the customer", "Left blank"], 1, "Verified first — a wrong GSTIN is a wrong bill.", ["gst"], "easy"),
        Q("Who decides a credit limit?", ["The salesperson", "The customer", "Accounting, under the credit policy", "Logistics"], 2, "Credit is Accounting’s, under the policy.", ["credit"]),
      ],
    }),
  },
  {
    key: "sales-readiness",
    title: "Final Sales Readiness Assessment",
    category: "final",
    definition: mod({
      passMarkPercent: 85,
      timerMinutes: 25,
      content: [T("about", "About this assessment", "This last test covers everything in the track. Review any module you are unsure of before you start.")],
      questions: [
        Q("Which of these may a salesperson promise on the spot?", ["Extra credit", "An unpublished discount", "What the approved policy and price book say", "Exclusivity"], 2, "Only approved terms.", ["policy"]),
        Q("A new shop found today should be in the book…", ["Today, from MBOS", "Next week", "When it orders", "Never"], 0, "Today.", ["crm"], "easy"),
        Q("A delivery date question goes to…", ["Logistics", "HR", "Production", "Nobody"], 0, "Logistics.", ["departments"], "easy"),
        Q("A customer’s GSTIN must be ___ before it is billed.", ["Verified", "Guessed", "Rounded", "Skipped"], 0, "Verified.", ["gst"], "easy"),
      ],
    }),
  },
];

/* ----------------------------------------------------------------- tracks */

const seq = (keys: string[], parallel: string[] = []): TrackDefinition["items"] => keys.map((k) => ({ moduleKey: k, required: true, after: parallel.includes(k) ? [] : null }));

export const SEED_TRACKS: { key: string; title: string; definition: TrackDefinition }[] = [
  {
    key: "sales-executive-onboarding",
    title: "Sales Executive onboarding",
    definition: {
      designations: ["Sales Executive (S1)", "Senior Sales Executive (S2)"],
      sequential: true,
      completeWithinDays: 30,
      items: [
        ...seq(["thinner-basics", "product-universal", "product-nc", "product-nano", "product-pu", "product-mylac"]),
        { moduleKey: "company-induction", required: true, after: [] },
        { moduleKey: "customer-classification", required: true, after: ["product-mylac"] },
        ...seq(["prospecting", "relationship", "objections", "commercial"]),
        { moduleKey: "sales-readiness", required: true, after: ["commercial", "company-induction"] },
      ],
    },
  },
  {
    key: "telecaller-onboarding",
    title: "Telecaller onboarding",
    definition: { designations: ["Telecaller"], sequential: true, completeWithinDays: 21, items: seq(["thinner-basics", "company-induction", "customer-classification", "relationship", "objections"], ["company-induction"]) },
  },
  {
    key: "accountant-onboarding",
    title: "Accountant onboarding",
    definition: { designations: ["Accounts Executive"], sequential: false, completeWithinDays: 14, items: seq(["company-induction"], ["company-induction"]) },
  },
];
