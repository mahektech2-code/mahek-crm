import { randomUUID } from "node:crypto";
import { APP_TIMEZONE } from "@/lib/business-date";
import { db, sql as client } from "./index";
import {
  appAccess,
  appSettings,
  attendance,
  auditLog,
  bills,
  bugReports,
  feedback,
  calls,
  complaintStatusHistory,
  complaints,
  customers,
  interactionProductLines,
  migrationExceptions,
  products,
  productAliases,
  productBrands,
  productFormulations,
  finishedGoods,
  catalogueExceptions,
  quickNotes,
  eodReports,
  followUpAttempts,
  followUpStates,
  helpArticles,
  inactiveWatchItems,
  jobRuns,
  monthlyTargets,
  notifications,
  orders,
  paymentReceipts,
  payments,
  reminders,
  sessions,
  passwordResets,
  users,
  waMessages,
  waReplies,
  waRuns,
  waTemplates,
} from "./schema";
import { hashPassword } from "../lib/password";
import { initialsOf } from "../lib/format";
import { SETTINGS } from "../lib/config/registry";
import { eq } from "drizzle-orm";
import { seedCatalogue } from "./seed-catalogue";

/* ---------------------------------------------------------------------------
 * Seed: around fifty realistic customers with six months of orders, bills and
 * calls. The engines cannot be tested meaningfully without this shape of data.
 * ------------------------------------------------------------------------- */

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const now = new Date();
const DAY = 86_400_000;

const IST = new Intl.DateTimeFormat("en-CA", {
  timeZone: APP_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const iso = (offsetDays: number) =>
  IST.format(new Date(now.getTime() + offsetDays * DAY));
const at = (offsetDays: number, hour = 10, minute = 0) => {
  const d = new Date(now.getTime() + offsetDays * DAY);
  d.setHours(hour, minute, 0, 0);
  return d;
};
const TODAY = iso(0);
const rupees = (n: number) => n * 100;

/** Deterministic pseudo-randomness, so a reseed produces the same book. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}
const rand = rng(20260803);
const pick = <T>(list: T[]): T => list[Math.floor(rand() * list.length)];
const between = (lo: number, hi: number) =>
  lo + Math.floor(rand() * (hi - lo + 1));

const TEAM = [
  {
    name: "Priya Sharma",
    email: "priya@mahek.in",
    phone: "9820011001",
    role: "telecaller" as const,
    apps: ["crm"],
  },
  {
    name: "Rakesh Yadav",
    email: "rakesh@mahek.in",
    phone: "9820011002",
    role: "telecaller" as const,
    apps: ["crm"],
  },
  {
    name: "Anjali Patel",
    email: "anjali@mahek.in",
    phone: "9820011003",
    role: "telecaller" as const,
    apps: ["crm"],
  },
  {
    name: "Suresh Kumar",
    email: "suresh@mahek.in",
    phone: "9820011004",
    role: "telecaller" as const,
    apps: ["crm"],
  },
  {
    name: "Neha Joshi",
    email: "neha@mahek.in",
    phone: "9820011005",
    role: "telecaller" as const,
    apps: ["crm", "reports"],
  },
  {
    name: "Vikram Rao",
    email: "vikram@mahek.in",
    phone: "9820011006",
    role: "manager" as const,
    apps: ["crm", "orders", "reports", "people", "hrms", "admin"],
  },
  {
    name: "Mahesh Parab",
    email: "mahesh@mahek.in",
    phone: "9820011007",
    role: "telecaller" as const,
    apps: ["field"],
  },
  {
    // Accounts accept orders and do nothing else. Deliberately without the
    // CRM: the person deciding whether a customer may take more credit is not
    // the person chasing them for the next order.
    name: "Deepa Nair",
    email: "deepa@mahek.in",
    phone: "9820011008",
    role: "accounts" as const,
    apps: ["orders"],
  },
];

const CITIES: Array<[string, string]> = [
  ["Nashik", "Nashik City"],
  ["Nashik", "Nashik–Sinnar"],
  ["Pune", "Pune West"],
  ["Pune", "Pune East"],
  ["Mumbai", "Mumbai Central"],
  ["Thane", "Thane"],
  ["Nagpur", "Nagpur"],
  ["Aurangabad", "Marathwada"],
  ["Kolhapur", "Kolhapur"],
  ["Sangli", "Sangli"],
  ["Satara", "Satara"],
  ["Jalgaon", "Khandesh"],
  ["Ahmednagar", "Ahmednagar"],
  ["Amravati", "Vidarbha"],
  ["Ratnagiri", "Konkan"],
];

const PREFIX = [
  "Shree",
  "Om Sai",
  "Krishna",
  "Balaji",
  "Ganesh",
  "Deccan",
  "Sai",
  "Jai Bhavani",
  "Maharashtra",
  "New India",
  "Ratnadeep",
  "Vishwas",
  "Shivneri",
  "Anand",
  "Laxmi",
  "Sagar",
  "Konkan",
  "Mumbai",
  "Vasai",
  "Bharat",
  "Sharda",
  "Tapti",
  "Girna",
  "Vidarbha",
  "Orange City",
  "Wardha",
  "Amravati",
  "Godavari",
  "Panchvati",
  "Sahyadri",
];
const SUFFIX = [
  "Paints & Hardware",
  "Traders",
  "Paint House",
  "Coatings",
  "Hardware Mart",
  "Paint Suppliers",
  "Enterprises",
  "Hardware",
  "Paint Depot",
  "Colours",
  "Chemicals",
  "Colour House",
  "Hardware Stores",
  "Paint Centre",
];
const FIRST = [
  "Mahesh",
  "Ganesh",
  "Sunil",
  "Rohit",
  "Amit",
  "Prakash",
  "Nitin",
  "Santosh",
  "Vijay",
  "Kiran",
  "Anil",
  "Deepak",
  "Manoj",
  "Sachin",
  "Ravi",
  "Pravin",
  "Suhas",
  "Farhan",
  "Dinesh",
  "Yogesh",
  "Nilesh",
  "Ashok",
  "Rahul",
  "Sandeep",
];
const LAST = [
  "Shah",
  "Pawar",
  "Deshmukh",
  "Jadhav",
  "Kulkarni",
  "More",
  "Bhosale",
  "Gaikwad",
  "Shinde",
  "Salunkhe",
  "Chavan",
  "Patil",
  "Kadam",
  "Thorat",
  "Mane",
  "Sawant",
  "Naik",
  "Shaikh",
  "Raut",
  "Tambe",
  "Wagh",
  "Borse",
  "Ingle",
  "Dhole",
];

const TEMPLATES = [
  {
    name: "Order confirmation",
    category: "order_confirmation" as const,
    stage: null,
    appliesTo: "personal" as const,
    body: "Namaste {{contact}} ji,\n\nThank you for your order with Mahek Marketing.\n\nOrder value: {{last_order_value}}\nWe will confirm the dispatch date shortly.\n\n- {{owner}}, Mahek Marketing India",
  },
  {
    name: "Payment reminder · stage 1",
    category: "payment_reminder" as const,
    stage: 1,
    appliesTo: "personal" as const,
    body: "Namaste {{contact}} ji,\n\nA gentle reminder that {{outstanding}} is pending against {{customer}}.\n\nOldest bill {{bill_no}} was due on {{bill_due}}.\n\nKindly arrange the payment at your convenience.\n\n- {{owner}}, Mahek Marketing India",
  },
  {
    name: "Payment reminder · stage 2",
    category: "payment_reminder" as const,
    stage: 2,
    appliesTo: "personal" as const,
    body: "Namaste {{contact}} ji,\n\n{{outstanding}} is now overdue against {{customer}}.\n\nBill {{bill_no}} was due on {{bill_due}}. Please confirm a date by which we can expect the payment.\n\n- {{owner}}, Mahek Marketing India",
  },
  {
    name: "Payment reminder · stage 3",
    category: "payment_reminder" as const,
    stage: 3,
    appliesTo: "personal" as const,
    body: "Namaste {{contact}} ji,\n\nDespite earlier reminders, {{outstanding}} remains unpaid against {{customer}}.\n\nWe would like to settle this before further supplies. Please call us today.\n\n- {{owner}}, Mahek Marketing India",
  },
  {
    name: "Reorder nudge",
    category: "reactivation" as const,
    stage: null,
    appliesTo: "group" as const,
    body: "Namaste {{contact}} ji,\n\nIt has been a while since your last order on {{last_order_date}}. Stock is ready and rates are unchanged this month.\n\nShall I book your usual quantity?\n\n- {{owner}}, Mahek Marketing India",
  },
  {
    name: "Routine check-in",
    category: "routine_check_in" as const,
    stage: null,
    appliesTo: "personal" as const,
    body: "Namaste {{contact}} ji,\n\nChecking in from Mahek Marketing. Do you need any thinner stock this week?\n\n- {{owner}}",
  },
];

const HELP = [
  {
    title: "Opening a cold call",
    category: "Call scripts",
    type: "call_script" as const,
    roles: ["telecaller", "manager"],
    scriptBody:
      "Namaste, am I speaking to {contact name}? This is {your name} calling from Mahek Marketing India, Nashik. We supply thinners and coatings.\n\nIs this a good time to speak for two minutes?",
    body: "Say the company name in the first sentence. Most shopkeepers take the call if they recognise the supplier.\n\nIf they say it is a bad time, ask for a specific time later the same day and set a reminder before you hang up. Do not leave it at 'I will call back'.",
  },
  {
    title: "Asking for an overdue payment",
    category: "Call scripts",
    type: "call_script" as const,
    roles: ["telecaller", "manager"],
    scriptBody:
      "Namaste {contact name} ji. I am calling about bill {bill number} for {amount}, which was due on {due date}.\n\nCan you tell me a date by which we can expect the payment?",
    body: "Never ask 'when can you pay'. Ask for a date, and repeat it back. A date is a promise you can record; 'soon' is not.\n\nAlways record the promise in the app before the call ends - it creates the chase reminder for the day after.",
  },
  {
    title: "Handling a short supply complaint",
    category: "Call scripts",
    type: "call_script" as const,
    roles: ["telecaller", "manager"],
    scriptBody:
      "I am sorry that happened. Let me note exactly what was short - which product and how many drums?\n\nI am logging it now and our operations team will come back to you. You will hear from us either way.",
    body: "Log the complaint while the customer is still on the line, in their words. Do not promise a resolution date you cannot control - promise a call back instead.",
  },
  {
    title: "Why a customer is held back from the queue",
    category: "SOPs",
    type: "sop" as const,
    roles: ["telecaller", "manager"],
    body: "A customer is held back when:\n\n· a WhatsApp message was CONFIRMED sent inside the cooldown window\n· they were already called today, by anybody\n· they are active in the order system\n· they are marked do not contact\n\nA message you copied but never confirmed does NOT hold anyone back - the system cannot know it was sent. Held-back customers are always listed under the queue with the reason.",
  },
  {
    title: "Closing the day properly",
    category: "SOPs",
    type: "sop" as const,
    roles: ["telecaller", "manager"],
    body: "Before you submit the EOD report:\n\n1. Every reminder due today must be closed or carried forward.\n2. Every call you made must have an outcome.\n3. Any order taken must have a value against it.\n\nThe EOD text is generated from what you logged, so a thin report means thin logging, not a thin day.",
  },
  {
    title: "Reading the payment stages",
    category: "SOPs",
    type: "sop" as const,
    roles: ["telecaller", "manager"],
    body: "Stage 1 → WhatsApp only. The system will refuse a call attempt at this stage.\nStage 2 → alternates. If the last touch was WhatsApp, call; otherwise message.\nStage 3 → call.\n\nA disputed account holds at its current stage rather than escalating.",
  },
  {
    title: "Deciding on an inactive customer",
    category: "SOPs",
    type: "sop" as const,
    roles: ["manager"],
    body: "A customer reaches the watch after twice their OWN buying cycle with no order. A 14-day buyer going quiet for a month matters more than a 45-day buyer doing the same.\n\nDecide within two weeks: contact, set a reminder, request deactivation, or mark them not actually inactive. A row sitting without a decision is the one that quietly leaves.",
  },
  {
    title: "Setting monthly targets",
    category: "SOPs",
    type: "sop" as const,
    roles: ["manager"],
    body: "Where no target is set, the trailing average of recent achievement is applied and the row is badged 'Default'.\n\nDefaults are honest but unambitious. Review them at the start of the month and set real numbers on the accounts that can grow.",
  },
];

/** Where a lead came from. Free text in the schema; these are the common ones. */
const LEAD_SOURCES = [
  "Walk-in",
  "Referral",
  "Exhibition, Nashik",
  "Cold list",
  "Existing customer's contact",
];

async function main() {
  console.log("Clearing…");
  for (const table of [
    auditLog,
    jobRuns,
    notifications,
    eodReports,
    bugReports,
    feedback,
    attendance,
    waReplies,
    waMessages,
    waRuns,
    waTemplates,
    complaintStatusHistory,
    complaints,
    inactiveWatchItems,
    followUpAttempts,
    followUpStates,
    reminders,
    calls,
    orders,
    interactionProductLines,
    migrationExceptions,
    quickNotes,
    // The catalogue, bottom up: SKUs refer to finished goods, which refer to
    // brands, which refer to formulations.
    catalogueExceptions,
    productAliases,
    products,
    finishedGoods,
    productBrands,
    productFormulations,
    payments,
    paymentReceipts,
    bills,
    monthlyTargets,
    customers,
    appAccess,
    passwordResets,
    sessions,
    users,
    helpArticles,
    appSettings,
  ]) {
    await db.delete(table);
  }

  console.log("Seeding configuration…");
  await db.insert(appSettings).values(
    SETTINGS.map((s) => ({
      key: s.key,
      value: s.default as never,
      valueType: s.type,
      category: s.category,
      label: s.label,
      description: s.description,
    })),
  );

  console.log("Seeding products and quick notes…");
  const cat = await seedCatalogue();

  // What an external order line names, read back OUT of the catalogue that was
  // just imported. Hard-coding a few names here would be a second copy of the
  // product master that drifts the moment the document is revised — and the
  // product history matches external lines by NAME, so a name that has drifted
  // makes a working join look broken.
  const externalProductNames = (
    await db
      .select({ name: products.name })
      .from(products)
      .where(eq(products.active, true))
      .orderBy(products.displayOrder)
      .limit(40)
  ).map((p) => p.name);
  console.log(
    `  ${cat.productsAdded} products · ${cat.quickNotesAdded} quick notes`,
  );

  console.log("Creating the team…");
  const passwordHash = await hashPassword("mahek1234");
  const managerId = id("usr");
  const userRows = TEAM.map((t) => ({
    id: t.role === "manager" ? managerId : id("usr"),
    name: t.name,
    email: t.email,
    phone: t.phone,
    passwordHash,
    role: t.role,
    initials: initialsOf(t.name),
    reportsToId: null as string | null,
  }));
  // Telecallers report to the manager, which is what a manager's scope reads.
  for (const u of userRows) if (u.id !== managerId) u.reportsToId = managerId;
  await db.insert(users).values(userRows);

  await db.insert(appAccess).values(
    TEAM.flatMap((t, i) =>
      t.apps.map((app) => ({
        id: id("acc"),
        userId: userRows[i].id,
        app: app as never,
        grantedById: managerId,
      })),
    ),
  );

  console.log("Creating customers…");
  const crmUsers = userRows.filter((u) => u.name !== "Mahesh Parab");
  type SeedCustomer = typeof customers.$inferInsert & {
    cycle: number;
    paysIn: number;
  };
  const customerRows: SeedCustomer[] = [];

  for (let i = 0; i < 52; i++) {
    const [city, route] = CITIES[i % CITIES.length];
    const cycle = pick([14, 18, 21, 25, 28, 30, 35, 45, 60]);
    const paysIn = between(18, 70);
    const avg = between(45, 380) * 1000;
    const owner = crmUsers[i % crmUsers.length];
    const usesGroup = i % 5 === 0;

    customerRows.push({
      id: id("cus"),
      externalCode: `MM-C${String(1000 + i)}`,
      name: `${PREFIX[i % PREFIX.length]} ${SUFFIX[i % SUFFIX.length]}`,
      contactPerson: `${FIRST[i % FIRST.length]} ${LAST[(i * 3) % LAST.length]}`,
      phone: `9${between(600000000, 899999999)}`,
      city,
      region: route,
      route,
      status: "active",
      // Every seventh record is a lead: never ordered, no account managers,
      // so the modal's two header layouts and the lead notice are both
      // reachable without hand-editing the database.
      kind: (i % 7 === 3 ? "lead" : "customer") as "lead" | "customer",
      leadSource: i % 7 === 3 ? LEAD_SOURCES[i % LEAD_SOURCES.length] : null,
      ownerId: owner.id,
      salesAmId: i % 7 === 3 ? null : owner.id,
      // Back office is left unassigned on some, which the modal flags.
      backOfficeAmId:
        i % 7 === 3
          ? null
          : i % 4 === 0
            ? null
            : crmUsers[(i + 2) % crmUsers.length].id,
      gstin: `27AAB${String(1000 + i)}M1Z${i % 10}`,
      creditTermDays: 30,
      customerSince: iso(-between(200, 1500)),
      cycleDays: cycle,
      cycleIsDefault: true,
      avgOrderValue: rupees(avg),
      whatsappGroupName: usesGroup
        ? `${PREFIX[i % PREFIX.length]} order group`
        : null,
      whatsappDest: usesGroup ? "group" : "personal",
      // A handful are live in the order system, to exercise suppression.
      activeInOrderSystem: i % 17 === 0,
      doNotContact: i === 33,
      cycle,
      paysIn,
    });
  }
  await db.insert(customers).values(
    customerRows.map((c) => {
      const { cycle, paysIn, ...rest } = c;
      void cycle;
      void paysIn;
      return rest;
    }),
  );

  console.log("Creating six months of orders…");
  const orderRows: Array<typeof orders.$inferInsert> = [];
  for (const c of customerRows) {
    // Walk backwards at roughly their cycle; a quarter are deliberately stale.
    let offset = -between(
      1,
      Math.max(2, Math.round(c.cycle * (rand() < 0.25 ? 2.6 : 0.8))),
    );
    for (let n = 0; n < 12 && offset > -190; n++) {
      const avgRupees = Math.round((c.avgOrderValue ?? 10_000_000) / 100);
      orderRows.push({
        id: id("ord"),
        customerId: c.id!,
        userId: c.ownerId,
        source: n % 6 === 0 ? "external" : "crm",
        externalRef: n % 6 === 0 ? `EXT-${randomUUID().slice(0, 8)}` : null,
        orderedAt: at(offset, between(10, 17), between(0, 59)),
        totalAmount: rupees(
          between(Math.round(avgRupees * 0.6), Math.round(avgRupees * 1.4)),
        ),
        status: "confirmed",
        lineItems: [
          {
            product: pick(externalProductNames),
            quantity: between(2, 12),
            unitPrice: 0,
            amount: 0,
          },
        ],
      });
      offset -= Math.max(5, c.cycle + between(-3, 3));
    }
  }
  await db.insert(orders).values(orderRows);

  console.log("Creating bills and payments…");
  const billRows: Array<typeof bills.$inferInsert> = [];
  const receiptRows: Array<typeof paymentReceipts.$inferInsert> = [];
  const paymentRows: Array<typeof payments.$inferInsert> = [];
  let billSeq = 4000;

  for (const c of customerRows) {
    const avgRupees = Math.round((c.avgOrderValue ?? 10_000_000) / 100);
    for (let n = 0; n < between(3, 6); n++) {
      const raisedDaysAgo = between(5, 150);
      const amount = rupees(
        between(Math.round(avgRupees * 0.5), Math.round(avgRupees * 1.3)),
      );
      const billId = id("bil");
      const settled =
        raisedDaysAgo > c.paysIn && rand() > (c.paysIn > 45 ? 0.55 : 0.2);
      const partial = !settled && rand() > 0.8;
      const paid = settled ? amount : partial ? Math.round(amount * 0.4) : 0;

      billRows.push({
        id: billId,
        customerId: c.id!,
        billNo: `MM/${TODAY.slice(0, 4)}/${++billSeq}`,
        billDate: iso(-raisedDaysAgo),
        // Some bills carry no due date, so the default credit period is used.
        dueDate: n % 9 === 0 ? null : iso(-raisedDaysAgo + 30),
        amount,
        paidAmount: paid,
        disputed: rand() > 0.97,
        externalRef: `EXT-B${billSeq}`,
      });

      if (paid > 0) {
        const receiptId = id("rcp");
        const paidAt = iso(-Math.max(0, raisedDaysAgo - c.paysIn));
        const mode = pick(["Bank transfer", "Cheque", "UPI", "Cash"]);
        const reference = `UTR${900000 + billSeq}`;
        receiptRows.push({
          id: receiptId,
          customerId: c.id!,
          amount: paid,
          receivedAt: paidAt,
          mode,
          reference,
          // Money already in the ledger is money accounts have seen. Seeding it
          // as reported would open the demo with a confirmation queue of
          // history nobody remembers.
          status: "confirmed",
          source: "accounts",
          reportedById: c.ownerId,
          confirmedById: c.ownerId,
          confirmedAt: new Date(`${paidAt}T11:00:00+05:30`),
          idempotencyKey: `SEED-RCP-${billSeq}`,
        });
        paymentRows.push({
          id: id("pay"),
          receiptId,
          billId,
          customerId: c.id!,
          amount: paid,
          paidAt,
          mode,
          reference,
          recordedById: c.ownerId,
        });
      }
    }
  }
  await db.insert(bills).values(billRows);
  await db.insert(paymentReceipts).values(receiptRows);
  await db.insert(payments).values(paymentRows);

  console.log("Creating calls…");
  // Most calls connect. The ones that do not are "No Answer" — an OUTCOME
  // now, not a connection status, which is what the EOD missed count reads.
  const CONNECTS = [true, true, true, true, false] as const;
  const OUTCOMES = [
    "order_taken",
    "no_order",
    "payment_promised",
    "follow_up",
  ] as const;
  const NOTES = [
    "Wants the revised 200L drum rate before committing.",
    "Stock is sufficient until month end, will reorder after that.",
    "Cheque ready, asked us to collect on Friday.",
    "Comparing rates with another supplier, wants a call on Monday.",
    "Confirmed the usual quantity, dispatch this week.",
    "Owner was travelling - spoke to the accountant instead.",
  ];

  const callRows: Array<typeof calls.$inferInsert> = [];
  for (const c of customerRows) {
    for (let n = 0; n < between(2, 7); n++) {
      const daysAgo = n === 0 && rand() > 0.6 ? 0 : between(1, 45);
      const connected = pick([...CONNECTS]);
      callRows.push({
        id: id("call"),
        customerId: c.id!,
        userId: c.ownerId!,
        direction: "outbound",
        interactionType: "outbound_call",
        startedAt: at(-daysAgo, between(10, 18), between(0, 59)),
        durationSeconds: connected ? between(45, 420) : 0,
        outcome: connected ? pick([...OUTCOMES]) : "no_answer",
        notes: connected ? pick(NOTES) : "Phone rang",
        sourceModule: pick([
          "call_queue",
          "call_queue",
          "payment_follow_up",
          "ad_hoc",
        ] as const),
      });
    }
  }
  await db.insert(calls).values(callRows);

  console.log("Creating reminders, complaints and messages…");
  const reminderRows: Array<typeof reminders.$inferInsert> = [];
  for (const [i, c] of customerRows.entries()) {
    const offsets =
      i % 4 === 0 ? [-4, 0, 5] : i % 4 === 1 ? [0] : i % 4 === 2 ? [3] : [];
    for (const offset of offsets) {
      reminderRows.push({
        id: id("rem"),
        customerId: c.id!,
        createdByUserId: c.ownerId!,
        assignedUserId: c.ownerId!,
        dueDate: iso(offset),
        note:
          offset < 0
            ? "Chase the cheque promised last week"
            : offset === 0
              ? "Call back with the revised drum rate"
              : "Confirm the dispatch schedule for next week",
        type: offset < 0 ? "payment_promise" : "call_back",
        status: "pending",
        createdAt: at(offset - 5, 12),
      });
    }
    if (i % 7 === 0) {
      reminderRows.push({
        id: id("rem"),
        customerId: c.id!,
        createdByUserId: c.ownerId!,
        assignedUserId: c.ownerId!,
        dueDate: iso(-3),
        note: "Sent the rate list as promised",
        type: "send_information",
        status: "completed",
        closedAt: at(-3, 16),
        closedById: c.ownerId,
        createdAt: at(-8, 10),
      });
    }
  }
  await db.insert(reminders).values(reminderRows);

  const COMPLAINTS = [
    {
      cat: "delivery" as const,
      sev: "high" as const,
      desc: "Last consignment was two drums short of the invoice.",
      status: "open" as const,
      ago: 9,
    },
    {
      cat: "product_quality" as const,
      sev: "medium" as const,
      desc: "NC thinner from the last batch is drying too slowly.",
      status: "in_progress" as const,
      ago: 6,
    },
    {
      cat: "billing_issue" as const,
      sev: "medium" as const,
      desc: "GST rate on the bill is 18% but the order was quoted at 12%.",
      status: "open" as const,
      ago: 3,
    },
    {
      cat: "pricing" as const,
      sev: "low" as const,
      desc: "Competitor is quoting eight rupees per litre less on 200L drums.",
      status: "open" as const,
      ago: 14,
    },
    {
      cat: "service" as const,
      sev: "low" as const,
      desc: "Nobody called back after the last complaint was raised.",
      status: "resolved" as const,
      ago: 20,
    },
    {
      cat: "shortage" as const,
      sev: "high" as const,
      desc: "Delivery arrived a day late and the shop was shut.",
      status: "in_progress" as const,
      ago: 4,
    },
    {
      cat: "packaging_damage" as const,
      sev: "medium" as const,
      desc: "Two drums had damaged seals on arrival.",
      status: "open" as const,
      ago: 11,
    },
  ];
  const SLA = { low: 120, medium: 48, high: 24 };

  const complaintRows: Array<typeof complaints.$inferInsert> = [];
  const historyRows: Array<typeof complaintStatusHistory.$inferInsert> = [];
  COMPLAINTS.forEach((cm, n) => {
    const customer = customerRows[n * 6];
    const cid = id("cmp");
    const created = at(-cm.ago, 11);
    complaintRows.push({
      id: cid,
      customerId: customer.id!,
      loggedByUserId: customer.ownerId!,
      category: cm.cat,
      description: cm.desc,
      severity: cm.sev,
      assignedTo: n % 2 === 0 ? "Operations" : "Accounts",
      status: cm.status,
      resolutionNotes:
        cm.status === "resolved"
          ? "Called the owner and agreed a credit note."
          : null,
      customerInformed: cm.status === "resolved",
      resolvedAt: cm.status === "resolved" ? at(-2, 15) : null,
      resolvedById: cm.status === "resolved" ? managerId : null,
      slaDueAt: new Date(created.getTime() + SLA[cm.sev] * 3_600_000),
      createdAt: created,
    });
    historyRows.push({
      id: id("csh"),
      complaintId: cid,
      fromStatus: null,
      toStatus: "open",
      changedById: customer.ownerId,
      note: "Logged during a call",
      at: created,
    });
  });
  await db.insert(complaints).values(complaintRows);
  await db.insert(complaintStatusHistory).values(historyRows);

  const templateRows = TEMPLATES.map((t, i) => ({
    id: id("tpl"),
    name: t.name,
    category: t.category,
    escalationStage: t.stage,
    body: t.body,
    appliesTo: t.appliesTo,
    usageCount: between(5, 60),
    updatedAt: at(-14 + i, 12),
  }));
  await db.insert(waTemplates).values(templateRows);

  // A spread of states, including copies never confirmed — the watch metric.
  const messageRows: Array<typeof waMessages.$inferInsert> = [];
  customerRows.slice(0, 22).forEach((c, i) => {
    const template = templateRows[i % templateRows.length];
    const state = i % 6;
    const confirmed = state < 3;
    const sentAt = at(-(i % 5), 9 + (i % 8), (i * 11) % 60);
    messageRows.push({
      id: id("wam"),
      customerId: c.id!,
      templateId: template.id,
      templateName: template.name,
      userId: c.ownerId!,
      mode: "manual",
      destKind: c.whatsappGroupName ? "group" : "personal",
      resolvedDestination: c.whatsappGroupName ?? c.phone!,
      body: template.body,
      edited: i % 7 === 0,
      status: confirmed
        ? "sent_manually"
        : state === 3
          ? "copied"
          : state === 4
            ? "prepared"
            : "cancelled",
      preparedAt: sentAt,
      copiedAt: state <= 3 ? sentAt : null,
      confirmedSentAt: confirmed ? sentAt : null,
    });
  });
  await db.insert(waMessages).values(messageRows);

  // Only CONFIRMED sends drive suppression, so only those touch the customer.
  for (const m of messageRows) {
    if (m.confirmedSentAt) {
      await client`
        update customers
           set last_confirmed_whatsapp_date = ${m.confirmedSentAt.toISOString().slice(0, 10)}
         where id = ${m.customerId}`;
    }
  }

  await db.insert(waReplies).values(
    [0, 5, 9, 12].map((i, n) => ({
      id: id("rep"),
      customerId: customerRows[i].id!,
      message: [
        "Send the rate list for 200L drums please.",
        "Payment done today by NEFT.",
        "Delivery still not received. Please check.",
        "Call me after 4 pm tomorrow.",
      ][n],
      receivedAt: at(0, 8 + n * 2, 15),
    })),
  );

  console.log("Creating help articles and notifications…");
  await db.insert(helpArticles).values(
    HELP.map((h) => ({
      id: id("hlp"),
      title: h.title,
      body: h.body,
      category: h.category,
      type: h.type,
      roles: h.roles,
      scriptBody: h.scriptBody ?? null,
    })),
  );

  await db.insert(notifications).values([
    {
      id: id("ntf"),
      userId: userRows[0].id,
      title: "Promise date passed",
      body: `${customerRows[1].name} promised payment and nothing has arrived.`,
      kind: "warn",
      href: "/crm/payments",
      createdAt: at(0, 8, 5),
    },
    {
      id: id("ntf"),
      userId: userRows[0].id,
      title: "Reply needs action",
      body: `${customerRows[9].name} says delivery has still not arrived.`,
      kind: "danger",
      href: "/crm/whatsapp",
      createdAt: at(0, 8, 30),
    },
    {
      id: id("ntf"),
      userId: managerId,
      title: "Complaint ageing",
      body: "A pricing complaint has been open for 14 days without a decision.",
      kind: "danger",
      href: "/crm/complaints",
      createdAt: at(0, 9, 15),
    },
  ]);

  console.log("\nRunning the engines over the seeded book…");
  const { recomputeEverything } = await import("../lib/recompute");
  const counts = await recomputeEverything();

  // The previous working day's queue, so "N carried over" has something to
  // compare against on a fresh clone. Without it the line correctly says it
  // does not know, which is right but shows nobody what the feature does.
  const { snapshotQueue } = await import("../lib/jobs");
  const { previousWorkingDay } = await import("../lib/business-date");
  const { getConfig } = await import("../lib/config/store");
  const cfg = await getConfig();
  const seedDay = await (await import("../lib/recompute")).today();
  for (const d of [
    previousWorkingDay(seedDay, {
      timezone: cfg["workingDay.timezone"],
      dayBoundaryHour: cfg["workingDay.dayBoundaryHour"],
      workingDays: cfg["workingDay.workingDays"],
    }),
    seedDay,
  ]) {
    await snapshotQueue(d);
  }

  console.log("\nSeeded:");
  console.log(`  users          ${userRows.length}`);
  console.log(`  customers      ${customerRows.length}`);
  console.log(`  orders         ${orderRows.length}`);
  console.log(`  bills          ${billRows.length}`);
  console.log(`  payments       ${paymentRows.length}`);
  console.log(`  calls          ${callRows.length}`);
  console.log(`  reminders      ${reminderRows.length}`);
  console.log(`  complaints     ${complaintRows.length}`);
  console.log(`  messages       ${messageRows.length}`);
  console.log("\nEngines:");
  for (const [k, v] of Object.entries(counts))
    console.log(`  ${k.padEnd(14)} ${v}`);

  console.log("\nSign in with the email or the work number:");
  for (const u of TEAM) {
    console.log(
      `  ${u.email.padEnd(20)} ${u.phone}  ${u.role.padEnd(11)} ${u.apps.join(", ")}`,
    );
  }
  console.log("\nPassword for every seeded account: mahek1234\n");

  await client.end();
}

main().catch(async (error) => {
  console.error(error);
  await client.end();
  process.exit(1);
});
