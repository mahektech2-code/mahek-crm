import type {
  BlueprintDefinition,
  BriefingPoint,
  CalcRule,
  Competency,
  FixedOption,
  Question,
  RubricCriterion,
  Stage,
  StageType,
} from "../blueprint-types";

/* ---------------------------------------------------------------------------
 * THE SEEDED BLUEPRINTS (PRD §4.1).
 *
 * Sales Executive v3 is the AppSheet "Sales_Hire_App" rebuilt: its stages,
 * its three scored levels, the normalised formula and the 70 threshold, with
 * the defects the client's own document lists resolved the way the design
 * resolved them —
 *   D4  one threshold (70) for status, message and progression
 *   D7  "ask the team" scores 6; salary below ₹15,000 scores 6; achievement
 *       60–90% scales 4→10 instead of scoring nothing
 *   D8  the ₹7.5 lakh target and 4–5 outstation days are BLOCKING points
 *   D11 last-company salary is INR, explicitly
 *   D12 growth is ONE definition (10% a promotion), read by the briefing and
 *       the offer letter alike
 *   D13 a boss rating of 10 still scores 0 — kept, and named as an open
 *       question rather than silently "fixed"
 *
 * Every value below is the rule Mahek hires by. Level 1's options, the
 * boss-rating curve (a 10 scores 0, on purpose: a perfect rating from a
 * former manager is read as inflated), the capped efficiency formula and the
 * growth ladder are settled, not provisional — a change is a new blueprint
 * version, published from the studio, and the diff shows what moved.
 * ------------------------------------------------------------------------- */

const ANCH = {
  low: "Describes the task in general terms; no example.",
  mid: "Gives one specific example with what they did.",
  high: "Gives specific examples, the result, and what they changed afterwards.",
};

const comp = (key: string, name: string, weight: number, definition: string): Competency => ({ key, name, weight, definition, anchors: ANCH });

const R = (key: string, tier: RubricCriterion["tier"], points: number, descriptor: string, indicators: string[] = []): RubricCriterion => ({
  key,
  tier,
  points,
  descriptor,
  indicators,
});

const opt = (key: string, label: string, points: number | null): FixedOption => ({ key, label, points });

type QArgs = Partial<Question> & Pick<Question, "key" | "text" | "competencyKeys">;
const q = (a: QArgs): Question => ({
  type: "behavioural",
  maxPoints: 10,
  weight: 1,
  mode: "ai_rubric",
  idealAnswer: "",
  probes: [],
  rubric: [],
  mandatory: true,
  knockout: false,
  approved: true,
  ai: false,
  ...a,
});

const ai = (key: string, text: string, comps: string[], ideal: string, probe: string, rubric?: RubricCriterion[]) =>
  q({
    key,
    text,
    competencyKeys: comps,
    idealAnswer: ideal,
    probes: [probe],
    rubric: rubric ?? [
      R("r0", "zero", 0, "No example; answers in general terms"),
      R("r1", "partial", 4, "One specific example of what they did"),
      R("r2", "partial", 8, "A specific example with its result"),
      R("r3", "full", 10, "Specific examples, the result, and what they changed afterwards"),
    ],
  });

const fixed = (key: string, text: string, comps: string[], options: FixedOption[], extra: Partial<Question> = {}) =>
  q({ key, text, competencyKeys: comps, type: "factual", mode: "fixed_choice", options, ...extra });

const calc = (key: string, text: string, comps: string[], rule: CalcRule, extra: Partial<Question> = {}) =>
  q({ key, text, competencyKeys: comps, type: "calculated", mode: "calculated", calc: rule, ...extra });

type SArgs = Partial<Stage> & Pick<Stage, "key" | "name" | "type">;
const stage = (a: SArgs): Stage => {
  const questions = a.questions ?? [];
  return {
    maxPoints: questions.reduce((n, x) => n + x.maxPoints, 0),
    passThreshold: 70,
    autoRejectFloor: null,
    strongSignal: null,
    graceRange: 5,
    slaHours: 48,
    questions,
    approved: true,
    ai: false,
    ...a,
  };
};
const plain = (key: string, name: string, type: StageType, slaHours: number, extra: Partial<Stage> = {}) => stage({ key, name, type, slaHours, ...extra });

const point = (key: string, title: string, body: string, responseType: BriefingPoint["responseType"], blocking: boolean): BriefingPoint => ({
  key,
  title,
  body,
  responseType,
  blocking,
  commentOnDisagree: responseType !== "told_only",
  approved: true,
  ai: false,
});

const RUPEE = 100;

/* ===================================================== Sales Executive v3 */

const SE_COMPS = [
  comp("c1", "Territory planning", 0.2, "Organises a territory into a repeatable visit plan and adapts it when the day changes."),
  comp("c2", "Dealer relationships", 0.2, "Builds and recovers dealer accounts through regular, specific contact."),
  comp("c3", "Target orientation", 0.15, "Knows the number, tracks it, and changes what they do when behind."),
  comp("c4", "Resilience", 0.15, "Keeps working the plan after refusal, loss or a bad month."),
  comp("c5", "Honesty", 0.1, "Does not promise what the company has not approved, and reports what actually happened."),
  comp("c6", "Communication", 0.1, "Explains a product in the customer’s terms and language."),
  comp("c7", "Field readiness", 0.1, "Can travel, has or can use a two-wheeler, and accepts outstation days."),
];

const SE_SCREEN = stage({
  key: "scr",
  name: "AI voice screen",
  type: "ai_screen",
  passThreshold: 60,
  autoRejectFloor: 40,
  slaHours: 48,
  questions: [
    ai("s1", "Tell me about your last job — what you sold, to whom, and where.", ["c6"], "Names the products, the customer type and the territory.", "Which towns did you cover?"),
    ai("s2", "Describe a sale you are proud of.", ["c2", "c3"], "A specific dealer, what they did, and the result in numbers.", "What did the dealer order, and how much?"),
    ai("s3", "How do you plan which shops you visit in a week?", ["c1"], "A repeatable plan with a rule for priorities.", "What happens to the plan when a shop is closed?"),
    ai("s4", "What was your monthly target, and how close did you get?", ["c3"], "States the number and the achievement precisely.", "What did you do in the month you were furthest behind?"),
    ai("s5", "Can you travel outstation, and how do you get around in the field?", ["c7"], "Confirms days away and a vehicle or licence.", "How many days a month could you be away from home?"),
    ai("s6", "Why do you want to work in field sales at Mahek?", ["c5", "c6"], "A reason about the work rather than only the salary.", "What would make you stay three years?"),
  ],
});

const SE_L1 = stage({
  key: "l1",
  name: "Level 1",
  type: "scored_interview",
  autoRejectFloor: 50,
  slaHours: 72,
  questions: [
    fixed("q1", "Tell me about yourself and your last job.", ["c6"], [opt("a", "Clear — last job, duties and why leaving", 10), opt("b", "Some detail, prompted", 6), opt("c", "Unclear or off topic", 2)]),
    fixed(
      "q2",
      "What responsibilities did you have? (select all)",
      ["c3"],
      [opt("a", "Dealer visits", 4), opt("b", "Order booking", 3), opt("c", "Collections", 3), opt("d", "Opening new counters", 3), opt("e", "Billing / dispatch follow-up", 2)],
      { type: "multi_select", cumulative: true, cap: 10, floor: 0, note: "Multi-select, capped at 10 — preserved from the AppSheet app." },
    ),
    fixed("q3", "How many years in field sales?", ["c3"], [opt("a", "More than 3 years", 10), opt("b", "1–3 years", 7), opt("c", "Less than a year", 4), opt("d", "None", 2)]),
    calc(
      "q4",
      "What salary do you expect? (₹ a month, INR)",
      ["c7"],
      { kind: "bands", input: { key: "expected", label: "Expected salary", unit: "₹/month" }, bands: [{ min: null, max: 15000, points: 6 }, { min: 15000, max: 22001, points: 10 }, { min: 22001, max: null, points: 4 }], uncovered: null },
      { note: "Below ₹15,000 was uncovered in the AppSheet app (D7); v3 scores it 6." },
    ),
    fixed("q5", "Do you have a two-wheeler?", ["c7"], [opt("a", "Own two-wheeler", 10), opt("b", "Can arrange one", 6), opt("c", "No", 0)]),
    fixed("q6", "Which areas do you know well?", ["c1"], [opt("a", "Three or more talukas in the territory", 10), opt("b", "One or two", 6), opt("c", "None yet", 2)]),
    fixed("q7", "Why do you want this job?", ["c5"], [opt("a", "A career in sales", 10), opt("b", "Better salary", 6), opt("c", "Any job will do", 2)]),
    fixed("q8", "When can you join?", ["c7"], [opt("a", "Within 15 days", 10), opt("b", "Within 30 days", 7), opt("c", "More than 30 days", 4)]),
  ],
});

const SE_L2 = stage({
  key: "l2",
  name: "Level 2",
  type: "scored_interview",
  autoRejectFloor: 50,
  slaHours: 72,
  questions: [
    ai("q1", "Walk me through how you planned a normal working day at your last job.", ["c1"], "A fixed route with a rule for second visits, and how it adapts when the day changes.", "What did you do the day a dealer on your route was shut?", [
      R("r0", "zero", 0, "No plan; visits as calls come in"),
      R("r1", "partial", 4, "A repeatable route or schedule"),
      R("r2", "partial", 8, "A route plus a rule for second visits or priorities"),
      R("r3", "full", 10, "All of that and a stated way of adapting when the day changes"),
    ]),
    ai("q2", "Tell me about a dealer who stopped ordering from you. What did you do?", ["c2"], "Went in person, found the cause, fixed what went wrong.", "What was the actual reason he stopped?"),
    ai("q3", "Describe a month when you missed your target.", ["c4"], "Owns the miss, names a cause, and a specific recovery action.", "What exactly did you do differently the next month?"),
    ai("q4", "A dealer asks for a rate below the price list to place a big order. What do you do?", ["c5"], "Refuses the unapproved rate, offers the escalation without promising its outcome.", "What do you tell him if your manager says no?"),
    ai("q5", "How would you explain a new thinner to a painter who uses another brand?", ["c6"], "Explains in the painter’s terms, ideally by demonstration.", "What would you show him, rather than tell him?"),
    ai("q6", "You are in a town and your next three visits cancel. What do you do with the day?", ["c1"], "Redirects the day to nearby counters or pending work, in an order.", "Your three visits cancel at eleven. Walk me through eleven to six."),
    fixed(
      "q7",
      "When you get stuck on a problem in the field, what do you do first?",
      ["c4"],
      [opt("a", "Solve it myself", 10), opt("b", "Ask my manager", 6), opt("c", "Ask the team for help", 6), opt("d", "Wait for instructions", 0)],
      { note: "“Ask the team for help” scored nothing in the AppSheet app (D7); v3 scores it 6." },
    ),
    calc(
      "q8",
      "Salary at your last company (₹ a month, INR)",
      ["c7"],
      { kind: "bands", input: { key: "salary", label: "Last salary", unit: "₹/month" }, bands: [{ min: null, max: 15000, points: 6 }, { min: 15000, max: 22001, points: 10 }, { min: 22001, max: null, points: 6 }], uncovered: null },
      { note: "Calculated against the S1 band ₹15,000–₹22,000. The AppSheet app displayed this field in dollars (D11); it is INR, explicitly." },
    ),
    fixed("q9", "How many days a week can you travel outstation?", ["c7"], [opt("a", "5 or more", 10), opt("b", "4 days", 8), opt("c", "3 days", 4), opt("d", "Fewer than 3", 0)]),
  ],
});

const SE_BRIEF = plain("brf", "Briefing · Level 2A", "briefing", 48, {
  briefing: [
    point("p1", "Company profile", "Who Mahek is, what we sell, where.", "told_only", false),
    point("p2", "Monthly target ₹7.5 lakh", "The sales target for an S1 executive from the second month.", "agree_disagree", true),
    point("p3", "4–5 days outstation every month", "Travel within the territory, with daily allowance.", "agree_disagree_willtry", true),
    point("p4", "Pay and incentive", "₹15,000–₹22,000 basic by grade, incentive by slab.", "agree_disagree", false),
    point("p5", "Growth path", "10% increment at each promotion, from one definition shared with the offer letter.", "told_only", false),
    point("p6", "Rules", "Daily reporting, visit photos, no rate promises.", "agree_disagree", false),
  ],
});

const SE_L3 = stage({
  key: "l3",
  name: "Level 3",
  type: "scored_interview",
  autoRejectFloor: 50,
  slaHours: 72,
  questions: [
    ai("q1", "You are given a new district with forty counters. How do you plan your first month?", ["c1"], "Listens before selling, then groups counters by distance and size with a rule for order.", "Which group do you visit first, and why?"),
    ai("q2", "A dealer complains that our delivery came three days late. What do you do that day?", ["c2"], "Goes the same day with proof; owns it without blaming the dealer.", "What do you say to him in the first minute?"),
    ai("q3", "Tell me how you got a new counter to stock a brand they had never sold.", ["c2", "c4"], "Creates pull through the influencer, persists after refusal.", "What happened when the owner still refused?"),
    ai("q4", "How do you recover a payment that is sixty days overdue without losing the dealer?", ["c5", "c3"], "Private, specific, a part payment and a date — and what happens if the date is missed.", "What do you do if he misses the date he gave you?"),
    ai("q5", "Explain the difference between NC thinner and PU thinner to a dealer.", ["c6"], "Knows which finish each is for and what goes wrong when they are swapped.", "What do you tell a dealer when a painter uses NC thinner on a PU finish?"),
    calc(
      "q6",
      "Sales achievement last year (% of target)",
      ["c3"],
      { kind: "bands", input: { key: "pct", label: "Achievement", unit: "%" }, bands: [{ min: null, max: 60, points: 0 }, { min: 60, max: 90, points: 4, to: 10 }, { min: 90, max: null, points: 10 }], uncovered: null },
      { note: "v3: 90% and above scores 10, 60–90% scales from 4 to 10, below 60% scores 0. The AppSheet app scored 60–90% as zero (D7)." },
    ),
    calc(
      "q8",
      "Field efficiency — visits a day and hours in the field",
      ["c1"],
      {
        kind: "formula",
        inputs: [
          { key: "visits", label: "Visits a day" },
          { key: "hours", label: "Hours in the field" },
        ],
        expression: "(visits * hours / 8) * 10",
        cap: 10,
        floor: 0,
      },
      { note: "Formula preserved exactly: (visits × hours ÷ 8) × 10, capped at 10. The AppSheet app left it uncapped, so 9 visits × 9 hours scored 101 of 10." },
    ),
    fixed(
      "q9",
      "How do you travel in the field? (select all)",
      ["c7"],
      [opt("a", "Two-wheeler", 10), opt("b", "Bus or train", 5), opt("c", "Private car", -10)],
      { type: "multi_select", cumulative: true, cap: 10, floor: -10, note: "Cumulative: two-wheeler +10, bus or train +5, private car −10 — preserved from the AppSheet app." },
    ),
    fixed(
      "q10",
      "How would your last manager rate you, out of 10?",
      ["c5"],
      [opt("a", "6 or below", 0), opt("b", "7", 6), opt("c", "8", 10), opt("d", "9", 10), opt("e", "10", 0)],
      { note: "8 and 9 score 10; a 10 scores 0 — deliberately: a perfect rating from a former manager is read as inflated. Kept from the AppSheet app." },
    ),
    ai("q11", "Why are you leaving your current company?", ["c5"], "A reason about the work rather than blaming the employer.", "What would your current manager say about why you are leaving?"),
    fixed("q12", "Can we speak to your last manager?", ["c5"], [opt("a", "Yes, with contact", 10), opt("b", "Yes, later", 6), opt("c", "No", 0)]),
    ai("q13", "What would you like to ask us?", ["c6"], "Asks about the job itself — the beat, the incentive, the product.", "Leave five minutes at the end for their questions."),
    fixed("q14", "Do you hold a two-wheeler licence?", ["c7"], [opt("a", "Yes", 10), opt("b", "Applied", 5), opt("c", "No", 0)], { knockout: false }),
  ],
});

export const SALES_EXECUTIVE: BlueprintDefinition = {
  competencies: SE_COMPS,
  stages: [
    plain("app", "Application", "application", 24),
    SE_SCREEN,
    SE_L1,
    SE_L2,
    SE_BRIEF,
    SE_L3,
    plain("gate", "Decision gate", "decision_gate", 24, { gateRole: "Hiring Manager" }),
    plain("doc", "Documents & offer", "document_collection", 120),
    plain("kit", "Assets & induction", "checklist", 72),
    plain("setup", "Field setup", "system_setup", 48),
  ],
  documents: [
    { key: "aadhaar", label: "Aadhaar card", kind: "aadhaar", mandatory: true, verify: true, retentionMonths: 84, pii: "restricted", approved: true, ai: false },
    { key: "pan", label: "PAN card", kind: "pan", mandatory: true, verify: true, retentionMonths: 84, pii: "restricted", approved: true, ai: false },
    { key: "bank", label: "Bank statement or cancelled cheque", kind: "bank", mandatory: true, verify: true, retentionMonths: 84, pii: "sensitive", approved: true, ai: false },
    { key: "photo", label: "Passport photograph", kind: "photo", mandatory: true, verify: false, retentionMonths: 84, pii: "personal", approved: true, ai: false },
    { key: "payslips", label: "Last three payslips", kind: "payslip", mandatory: false, verify: true, retentionMonths: 24, pii: "sensitive", approved: true, ai: false },
    { key: "licence", label: "Driving licence (two-wheeler)", kind: "certificate", mandatory: true, verify: true, retentionMonths: 84, pii: "sensitive", approved: true, ai: false },
  ],
  offer: {
    currency: "INR",
    grades: [
      { key: "S1", label: "Sales Executive (S1)", basicMinPaise: 15000 * RUPEE, basicMaxPaise: 22000 * RUPEE },
      { key: "S2", label: "Senior Sales Executive (S2)", basicMinPaise: 22000 * RUPEE, basicMaxPaise: 28000 * RUPEE },
      { key: "S3", label: "Area Sales Officer (S3)", basicMinPaise: 28000 * RUPEE, basicMaxPaise: 36000 * RUPEE },
    ],
    incentive: "Monthly incentive by slab on sales above target: 1% to 110%, 1.5% to 125%, 2% beyond.",
    growth: [
      { fromGrade: "S1", toGrade: "S2", criterion: "Cumulative sales of ₹10,00,000", incrementType: "percentage", value: 10 },
      { fromGrade: "S2", toGrade: "S3", criterion: "Cumulative sales of ₹25,00,000 and a new territory opened", incrementType: "percentage", value: 10 },
    ],
    approved: true,
    ai: false,
  },
  onboarding: {
    assets: [
      { key: "bag", label: "Sample bag", serial: false },
      { key: "price", label: "Price list and scheme sheet", serial: false },
      { key: "cards", label: "Visiting cards", serial: false },
      { key: "idcard", label: "Company ID card", serial: true },
      { key: "orderbook", label: "Order book", serial: true },
      { key: "phone", label: "Handset for MBOS", serial: true },
    ],
    modules: [
      { key: "induction", name: "Company induction", topics: [{ key: "t1", title: "Who Mahek is and where we sell" }, { key: "t2", title: "Reporting, attendance and leave" }, { key: "t3", title: "Rules: rates, schemes and visit photos" }] },
      {
        key: "product",
        name: "Product training",
        topics: [
          { key: "t1", title: "NC thinner and where it is used" },
          { key: "t2", title: "PU thinner and the polyurethane finish" },
          { key: "t3", title: "Pack sizes: 1 L, 5 L, 20 L and drums" },
          { key: "t4", title: "What goes wrong when products are swapped" },
        ],
      },
      { key: "field", name: "Field process", topics: [{ key: "t1", title: "Planning a beat and a week" }, { key: "t2", title: "Taking an order and a payment in MBOS" }, { key: "t3", title: "Checking in at a shop, with a photo" }] },
    ],
    setup: [
      { key: "mbos", system: "MBOS Field Sales", steps: [{ key: "s1", label: "App installed on the handset" }, { key: "s2", label: "Signed in and device bound" }, { key: "s3", label: "Territory allocated" }, { key: "s4", label: "Test visit checked in" }] },
      { key: "hrms", system: "HRMS", steps: [{ key: "s1", label: "Employee record linked" }, { key: "s2", label: "Office and timings set" }, { key: "s3", label: "First attendance selfie taken" }] },
    ],
    approved: true,
    ai: false,
  },
  provisioning: { apps: ["field", "hrms"], level: "associate", roleLabel: "Field Sales Executive", device: true, approved: true, ai: false },
  fairness: {
    masked: ["name", "gender_markers", "age", "photo", "institution"],
    unmaskedJustification: { location: "Territory knowledge is a genuine job requirement for field sales; masking it destroys signal (PRD §9.2)." },
    monitor: { gender: true, age: true, location: true },
    adverseImpactThreshold: 0.8,
    redactBeforeTransmission: true,
    approved: true,
    ai: false,
  },
  coolingOff: [
    { reasonCode: "below_pass", days: 120 },
    { reasonCode: "blocking_briefing", days: 60 },
    { reasonCode: "no_show", days: 30 },
  ],
  openQuestions: [],
};

/* ================================================== Telecaller, Accounts */

const TC_COMPS = [
  comp("t1", "Call control", 0.25, "Opens, steers and closes a call without losing the customer."),
  comp("t2", "Listening", 0.2, "Picks up what the customer actually needs and plays it back."),
  comp("t3", "Persistence", 0.2, "Keeps a follow-up promise and calls back when they said they would."),
  comp("t4", "Product recall", 0.15, "Answers product questions without putting the customer on hold."),
  comp("t5", "Accuracy", 0.2, "Logs orders and outcomes correctly the first time."),
];

const basicDocs = SALES_EXECUTIVE.documents.filter((d) => d.key !== "licence");

export const TELECALLER: BlueprintDefinition = {
  ...SALES_EXECUTIVE,
  competencies: TC_COMPS,
  stages: [
    plain("app", "Application", "application", 24),
    stage({
      key: "scr",
      name: "AI voice screen",
      type: "ai_screen",
      passThreshold: 60,
      questions: [
        ai("s1", "Tell me about a call that went badly. What happened?", ["t1"], "A specific call, what they did, and what they would do differently.", "What did you say next?"),
        ai("s2", "Which languages can you speak on the phone, and how comfortably?", ["t2"], "Names the languages and gives an example of using each.", "Tell me one sentence you would open a Marathi call with."),
        ai("s3", "How do you make sure you call back when you promised?", ["t3"], "A concrete habit — alarm, list, CRM reminder.", "What happened the last time you missed one?"),
        ai("s4", "Why do you want to work on the phones?", ["t1"], "A reason about the work.", "What part of calling do you enjoy?"),
        ai("s5", "How do you note down an order while you are talking?", ["t5"], "Repeats quantities back before ending the call.", "What do you read back to the customer?"),
      ],
    }),
    stage({
      key: "rp",
      name: "Role-play call",
      type: "work_sample",
      passThreshold: 65,
      slaHours: 72,
      questions: [
        ai("r1", "Role-play: a dealer wants a rate below the list.", ["t1"], "Holds the rate politely and offers the right escalation.", "He says Asian gives him less. What now?"),
        ai("r2", "Role-play: log this order back to me.", ["t5"], "Repeats every item in cans and litres.", "Read the second line back again."),
        ai("r3", "Role-play: the customer says “the same as last time”.", ["t2"], "Reads last month’s order back and confirms changes.", "What do you check before confirming?"),
        ai("r4", "Role-play: he is angry about a late delivery.", ["t1", "t2"], "Lets him finish, owns it, gives a date.", "What date do you give him?"),
      ],
    }),
    stage({
      key: "int",
      name: "Interview",
      type: "scored_interview",
      slaHours: 72,
      questions: [
        ai("i1", "How do you keep a promise to call back?", ["t3"], "A system, and an example of it working.", "Tell me about the last callback you made."),
        ai("i2", "What is the difference between NC and PU thinner?", ["t4"], "Which finish each is for.", "What goes wrong if they are swapped?"),
        ai("i3", "Tell me about a mistake you made logging something.", ["t5"], "Owns the mistake and the check they added.", "How did you find out?"),
        ai("i4", "A customer keeps talking about cricket. What do you do?", ["t1"], "Lets one sentence finish, then brings it back.", "What exactly do you say?"),
        ai("i5", "How many calls a day have you handled?", ["t3"], "A number and how they kept up quality.", "What dropped first when the number went up?"),
        ai("i6", "What would you like to ask us?", ["t2"], "Asks about the job itself.", "Leave time at the end."),
      ],
    }),
    plain("brf", "Briefing", "briefing", 48, {
      briefing: [
        point("p1", "Company profile", "Who Mahek is, what we sell.", "told_only", false),
        point("p2", "Calls a day", "Around 120 calls a day on the Call Log.", "agree_disagree", true),
        point("p3", "Pay", "₹14,000–₹18,000 basic, incentive on orders.", "agree_disagree", false),
        point("p4", "Rules", "Every call logged; no rate promises.", "agree_disagree", false),
      ],
    }),
    plain("gate", "Decision gate", "decision_gate", 24, { gateRole: "Hiring Manager" }),
    plain("doc", "Documents & offer", "document_collection", 120),
    plain("kit", "Induction", "checklist", 72),
    plain("setup", "CRM setup", "system_setup", 24),
  ],
  documents: basicDocs,
  offer: {
    currency: "INR",
    grades: [
      { key: "T1", label: "Telecaller (T1)", basicMinPaise: 14000 * RUPEE, basicMaxPaise: 18000 * RUPEE },
      { key: "T2", label: "Senior Telecaller (T2)", basicMinPaise: 18000 * RUPEE, basicMaxPaise: 23000 * RUPEE },
    ],
    incentive: "Monthly incentive on approved orders logged from the Call Log.",
    growth: [{ fromGrade: "T1", toGrade: "T2", criterion: "Six months at or above the order target", incrementType: "percentage", value: 10 }],
    approved: true,
    ai: false,
  },
  onboarding: {
    assets: [
      { key: "headset", label: "Headset", serial: true },
      { key: "desk", label: "Desk and login", serial: false },
      { key: "idcard", label: "Company ID card", serial: true },
    ],
    modules: [
      { key: "induction", name: "Company induction", topics: [{ key: "t1", title: "Who Mahek is" }, { key: "t2", title: "Reporting and leave" }] },
      { key: "crm", name: "Call Log training", topics: [{ key: "t1", title: "Working the queue" }, { key: "t2", title: "Logging an order" }, { key: "t3", title: "Payment follow-up" }] },
      { key: "product", name: "Product training", topics: [{ key: "t1", title: "NC and PU thinners" }, { key: "t2", title: "Pack sizes" }] },
    ],
    setup: [{ key: "crm", system: "Telecaller CRM", steps: [{ key: "s1", label: "Signed in" }, { key: "s2", label: "Queue assigned" }, { key: "s3", label: "Test call logged" }] }],
    approved: true,
    ai: false,
  },
  // role-name-ok: "Telecaller" here is a blueprint's job title, not the retired account role
  provisioning: { apps: ["crm", "hrms"], level: "associate", roleLabel: "Telecaller", device: false, approved: true, ai: false },
  fairness: { ...SALES_EXECUTIVE.fairness, masked: ["name", "gender_markers", "age", "photo", "location", "institution"], unmaskedJustification: {} },
  openQuestions: [],
};

const AC_COMPS = [
  comp("a1", "Reconciliation", 0.3, "Matches bank, ledger and bills and explains every difference."),
  comp("a2", "Accuracy", 0.25, "Gets entries right first time and checks their own work."),
  comp("a3", "Tally fluency", 0.2, "Uses Tally for vouchers, GST and reports without help."),
  comp("a4", "Integrity", 0.25, "Handles money and refusals honestly, and escalates what they cannot fix."),
];

export const ACCOUNTS_EXECUTIVE: BlueprintDefinition = {
  ...TELECALLER,
  competencies: AC_COMPS,
  stages: [
    plain("app", "Application", "application", 24),
    stage({
      key: "scr",
      name: "Screen",
      type: "ai_screen",
      passThreshold: 60,
      questions: [
        ai("s1", "Walk me through a bank reconciliation you did.", ["a1"], "Names the difference found and its cause.", "What was the biggest difference, and why?"),
        ai("s2", "Which version of Tally have you used, and for what?", ["a3"], "Vouchers, GST and reports, specifically.", "How do you pass a debit note?"),
        ai("s3", "How do you check your own entries?", ["a2"], "A habit that catches errors before posting.", "When did that catch something?"),
        ai("s4", "Why accounts, and why Mahek?", ["a4"], "A reason about the work.", "What would make you stay?"),
      ],
    }),
    stage({
      key: "xl",
      name: "Tally & Excel test",
      type: "work_sample",
      slaHours: 72,
      questions: [
        calc("x1", "Tally test: vouchers posted correctly (of 5)", ["a3"], { kind: "formula", inputs: [{ key: "correct", label: "Correct vouchers" }], expression: "correct * 5", cap: 25, floor: 0 }, { maxPoints: 25 }),
        calc("x2", "Excel test: mismatched bills found (of 3)", ["a2", "a1"], { kind: "bands", input: { key: "found", label: "Mismatches found" }, bands: [{ min: null, max: 1, points: 0 }, { min: 1, max: 2, points: 10 }, { min: 2, max: 3, points: 18 }, { min: 3, max: null, points: 25 }], uncovered: null }, { maxPoints: 25 }),
      ],
    }),
    stage({
      key: "int",
      name: "Interview",
      type: "scored_interview",
      questions: [
        ai("i1", "A dealer asks you to back-date a receipt. What do you do?", ["a4"], "Refuses and tells the manager the same day.", "What if your manager asks you to?"),
        ai("i2", "Tell me about an error you found in your own work.", ["a2"], "Owns it and names the check added.", "How did you find it?"),
        ai("i3", "How do you handle month-end when the bank and Tally disagree?", ["a1"], "Works line by line and explains every difference.", "What was the strangest difference you found?"),
        ai("i4", "How do you reconcile GSTR-2B against purchases?", ["a3"], "Knows the match and what to do with mismatches.", "What do you do with a bill the supplier never uploaded?"),
        ai("i5", "A senior tells you to skip a check to save time. What do you do?", ["a4", "a2"], "Does the check, or escalates.", "What would you say to him?"),
        ai("i6", "What would you like to ask us?", ["a4"], "Asks about the job itself.", "Leave time at the end."),
      ],
    }),
    stage({ key: "ref", name: "Reference check", type: "reference_check", passThreshold: 60, slaHours: 96, questions: [ai("f1", "Referee: how did they handle month-end?", ["a1"], "Specific corroboration from the referee.", "Can you give an example?"), ai("f2", "Referee: did they ever handle money they could not account for?", ["a4"], "A clear answer with context.", "How was it resolved?")] }),
    plain("gate", "Decision gate", "decision_gate", 24, { gateRole: "Hiring Manager" }),
    plain("doc", "Documents & offer", "document_collection", 120),
    plain("kit", "Induction", "checklist", 72),
    plain("setup", "System setup", "system_setup", 24),
  ],
  offer: {
    currency: "INR",
    grades: [
      { key: "A1", label: "Accounts Executive (A1)", basicMinPaise: 20000 * RUPEE, basicMaxPaise: 28000 * RUPEE },
      { key: "A2", label: "Senior Accounts Executive (A2)", basicMinPaise: 28000 * RUPEE, basicMaxPaise: 36000 * RUPEE },
    ],
    incentive: "No incentive; an annual review.",
    growth: [{ fromGrade: "A1", toGrade: "A2", criterion: "Twelve months with clean month-end closes", incrementType: "percentage", value: 12 }],
    approved: true,
    ai: false,
  },
  onboarding: {
    assets: [
      { key: "laptop", label: "Laptop", serial: true },
      { key: "tally", label: "Tally licence seat", serial: false },
      { key: "idcard", label: "Company ID card", serial: true },
    ],
    modules: [
      { key: "induction", name: "Company induction", topics: [{ key: "t1", title: "Who Mahek is" }, { key: "t2", title: "Reporting and leave" }] },
      { key: "ledger", name: "The ledger desk", topics: [{ key: "t1", title: "Order approvals" }, { key: "t2", title: "Confirming payments" }, { key: "t3", title: "Credit notes" }] },
    ],
    setup: [{ key: "acc", system: "Accounts", steps: [{ key: "s1", label: "Signed in" }, { key: "s2", label: "Approvals queue visible" }] }],
    approved: true,
    ai: false,
  },
  provisioning: { apps: ["accounts", "hrms"], level: "associate", roleLabel: "Accounts", device: false, approved: true, ai: false },
};

const WS_COMPS = [
  comp("w1", "Stock control", 0.3, "Keeps counts right and finds the cause of a variance."),
  comp("w2", "Safety", 0.25, "Handles solvents and drums by the rule, every time."),
  comp("w3", "People", 0.25, "Runs a loading crew and settles disputes on the floor."),
  comp("w4", "Dispatch discipline", 0.2, "Gets the right drums on the right truck on time."),
];

/** A DRAFT, deliberately left part-approved with real validator findings — the state the studio is designed for. */
export const WAREHOUSE_SUPERVISOR: BlueprintDefinition = {
  ...ACCOUNTS_EXECUTIVE,
  competencies: WS_COMPS.map((c) => ({ ...c })),
  stages: [
    plain("app", "Application", "application", 24),
    stage({
      key: "scr",
      name: "AI voice screen",
      type: "ai_screen",
      passThreshold: 60,
      ai: true,
      approved: true,
      questions: [
        { ...ai("s1", "Tell me about the largest crew you have supervised.", ["w3"], "Names the crew size and a dispute they settled.", "What did you do when two loaders disagreed?"), ai: true },
        { ...ai("s2", "How do you store solvent drums?", ["w2"], "Names the rules: away from heat, upright, no rolling.", "Who checks it?"), ai: true },
        { ...ai("s3", "Tell me about a stock count that did not match.", ["w1"], "Finds the cause, not only the difference.", "What was the cause?"), ai: true },
        { ...ai("s4", "How do you make sure the right drums go on the right truck?", ["w4"], "Checks against the challan with the driver.", "What do you do if the count is short?"), ai: true },
      ],
    }),
    stage({
      key: "ws",
      name: "Floor walk",
      type: "work_sample",
      ai: true,
      approved: false,
      questions: [
        { ...calc("f1", "Floor walk: stock problems found in this bay (of 3)", ["w1"], { kind: "bands", input: { key: "found", label: "Problems found" }, bands: [{ min: 0, max: 1, points: 0 }, { min: 1, max: 2, points: 10 }, { min: 2, max: 3, points: 18 }], uncovered: null }, { maxPoints: 25 }), ai: true, approved: false },
        { ...ai("f2", "Floor walk: what is unsafe here?", ["w2"], "Names hazards and stops work.", "What do you do first?"), maxPoints: 25, ai: true, approved: false },
      ],
    }),
    stage({
      key: "int",
      name: "Interview",
      type: "scored_interview",
      ai: true,
      approved: false,
      questions: [
        { ...ai("i1", "How do you keep the floor safe during a rush dispatch?", ["w2"], "Names the rules, who checks them, and stops work when they are broken.", "When did you last stop the loading?", [R("r0", "zero", 0, "Does not mention any safety step"), R("r1", "partial", 4, "Shows a good attitude to safety"), R("r2", "partial", 4, "Names one rule, such as no rolling drums near the boiler"), R("r3", "full", 10, "Names the rules, who checks them, and stops work when they are broken")]), ai: true, approved: false },
        { ...ai("i2", "A count is six drums short. What do you do?", ["w1"], "Checks transfers before suspecting theft.", "Where do you look first?"), ai: true, approved: true },
        { ...ai("i3", "How do you handle a driver who arrives drunk?", [], "Refuses the load and escalates.", "Who do you call?"), ai: true, approved: false },
        { ...fixed("i4", "Years supervising a loading crew", ["w3"], [opt("a", "0–2 years", 4), opt("b", "3–5 years", 8), opt("c", "6 years or more", null)]), ai: true, approved: false },
      ],
    }),
    plain("brf", "Safety briefing", "briefing", 48, {
      ai: true,
      approved: false,
      briefing: [
        { ...point("p1", "Shift pattern", "Two shifts, rotating weekly.", "agree_disagree", true), ai: true, approved: false },
        { ...point("p2", "Night shifts in dispatch season", "Up to ten nights a month from October to December.", "agree_disagree", false), ai: true, approved: true },
        { ...point("p3", "Safety rules", "Solvent handling, no rolling drums, stop-work authority.", "agree_disagree", true), ai: true, approved: true },
        { ...point("p4", "Pay", "₹24,000–₹30,000 basic.", "agree_disagree", false), ai: true, approved: true },
      ],
    }),
    plain("gate", "Decision gate", "decision_gate", 24, { gateRole: "Hiring Manager" }),
    plain("doc", "Documents & offer", "document_collection", 120),
    plain("kit", "Induction", "checklist", 72, { ai: true, approved: false }),
    plain("setup", "ERP setup", "system_setup", 24),
  ],
  offer: {
    currency: "INR",
    grades: [{ key: "W1", label: "Warehouse Supervisor (W1)", basicMinPaise: 24000 * RUPEE, basicMaxPaise: 30000 * RUPEE }],
    incentive: "Dispatch-season allowance per night shift.",
    growth: [],
    approved: false,
    ai: true,
  },
  onboarding: {
    assets: [
      { key: "ppe", label: "Safety shoes, gloves and goggles", serial: false },
      { key: "idcard", label: "Company ID card", serial: true },
    ],
    modules: [{ key: "safety", name: "Solvent safety", topics: [{ key: "t1", title: "Storing drums" }, { key: "t2", title: "Stop-work authority" }, { key: "t3", title: "Spill drill" }] }],
    setup: [{ key: "erp", system: "ERP", steps: [{ key: "s1", label: "Signed in" }, { key: "s2", label: "Godown assigned" }] }],
    approved: false,
    ai: true,
  },
  provisioning: { apps: ["erp", "hrms"], level: "associate", roleLabel: "Godown supervisor", device: false, approved: true, ai: true },
  fairness: { ...SALES_EXECUTIVE.fairness, approved: false, ai: true },
  openQuestions: [],
};

export type SeedBlueprint = {
  key: string;
  title: string;
  family: string;
  department: string;
  level: string;
  employmentType: string;
  locations: string[];
  headcount: number;
  version: number;
  status: "published" | "draft";
  definition: BlueprintDefinition;
  ai: boolean;
  source: string;
};

export const SEED_BLUEPRINTS: SeedBlueprint[] = [
  {
    key: "sales-executive",
    title: "Sales Executive",
    family: "Field sales",
    department: "Sales",
    level: "Executive",
    employmentType: "Full time",
    locations: ["Nagpur", "Pune", "Indore", "Raipur", "Nashik"],
    headcount: 12,
    version: 3,
    status: "published",
    definition: SALES_EXECUTIVE,
    ai: false,
    source: "Seeded from the AppSheet Sales_Hire_App v1.000412 — seven stages, three scored levels, threshold 70.",
  },
  {
    // role-name-ok: "Telecaller" here is a blueprint's job title, not the retired account role
    key: "telecaller",
    // role-name-ok: "Telecaller" here is a blueprint's job title, not the retired account role
    title: "Telecaller",
    family: "Desk sales",
    department: "Sales",
    level: "Executive",
    employmentType: "Full time",
    locations: ["Bhiwandi HQ"],
    headcount: 6,
    version: 1,
    status: "published",
    definition: TELECALLER,
    ai: true,
    source: "Generated from a job description for the Call Log desk, reviewed by HR.",
  },
  {
    key: "accounts-executive",
    title: "Accounts Executive",
    family: "Finance",
    department: "Accounts",
    level: "Executive",
    employmentType: "Full time",
    locations: ["Bhiwandi HQ"],
    headcount: 2,
    version: 2,
    status: "published",
    definition: ACCOUNTS_EXECUTIVE,
    ai: true,
    source: "Generated from a job description for the ledger desk, reviewed by HR.",
  },
  {
    key: "warehouse-supervisor",
    title: "Warehouse Supervisor",
    family: "Operations",
    department: "Operations",
    level: "Supervisor",
    employmentType: "Full time",
    locations: ["Ambernath Plant", "Taloja Godown"],
    headcount: 3,
    version: 1,
    status: "draft",
    definition: WAREHOUSE_SUPERVISOR,
    ai: true,
    source: "Generated from a job description; partly reviewed.",
  },
];
