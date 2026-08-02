


import { randomUUID } from "node:crypto";
import { db, sql as client } from "./index";
import {
  appAccess,
  attendance,
  auditLog,
  bills,
  complaintEvents,
  complaints,
  customers,
  eodReports,
  helpArticles,
  interactions,
  notifications,
  orders,
  payments,
  promises,
  queueItems,
  reminders,
  sessions,
  settings,
  targets,
  users,
  waMessages,
  waReplies,
  waRuns,
  waTemplates,
} from "./schema";
import { hashPassword } from "../lib/password";
import { initialsOf, shortDate, today as istToday } from "../lib/format";

/* ---------------------------------------------------------------------------
 * Seed. Shapes the database like a real Mahek Marketing day so every screen has
 * something to show on first run. Dates are relative to today, so the demo does
 * not go stale.
 *
 *   npm run db:seed
 * ------------------------------------------------------------------------- */

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

const now = new Date();
const DAY = 86_400_000;

/**
 * Dates are anchored to Asia/Kolkata, the same clock the app uses. Seeding in
 * UTC puts "today's" queue on the wrong date for half of every Indian morning.
 */
const IST = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata",
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
const TODAY = istToday();
const PERIOD = TODAY.slice(0, 7);
const rupees = (n: number) => n * 100;

/**
 * `apps` is what a person can open after the single MahekOne sign-in. The three
 * shapes are deliberate: one app goes straight in, several land on the
 * launcher, and the field salesman proves an account can exist with no CRM.
 */
const TEAM = [
  { name: "Priya Sharma", email: "priya@mahek.in", phone: "9820011001", role: "telecaller" as const, apps: ["crm"] },
  { name: "Rakesh Yadav", email: "rakesh@mahek.in", phone: "9820011002", role: "telecaller" as const, apps: ["crm"] },
  { name: "Anjali Patel", email: "anjali@mahek.in", phone: "9820011003", role: "telecaller" as const, apps: ["crm"] },
  { name: "Suresh Kumar", email: "suresh@mahek.in", phone: "9820011004", role: "telecaller" as const, apps: ["crm"] },
  { name: "Neha Joshi", email: "neha@mahek.in", phone: "9820011005", role: "telecaller" as const, apps: ["crm", "reports"] },
  { name: "Vikram Rao", email: "vikram@mahek.in", phone: "9820011006", role: "manager" as const, apps: ["crm", "orders", "reports", "people", "admin"] },
  { name: "Mahesh Parab", email: "mahesh@mahek.in", phone: "9820011007", role: "telecaller" as const, apps: ["field"] },
];

type SeedCustomer = {
  name: string;
  contact: string;
  phone: string;
  city: string;
  owner: number;
  cycle: number;
  lastOrderDaysAgo: number;
  lastOrderValue: number;
  avgOrder: number;
  paysIn: number;
  route: string;
  group?: string;
};

const CUSTOMERS: SeedCustomer[] = [
  { name: "Shree Paints & Hardware", contact: "Mahesh Shah", phone: "9822014567", city: "Nashik", owner: 0, cycle: 21, lastOrderDaysAgo: 12, lastOrderValue: 184000, avgOrder: 172000, paysIn: 34, route: "Nashik–Sinnar", group: "Shree Paints order group" },
  { name: "Om Sai Traders", contact: "Ganesh Pawar", phone: "9823145678", city: "Pune", owner: 0, cycle: 30, lastOrderDaysAgo: 41, lastOrderValue: 96000, avgOrder: 104000, paysIn: 52, route: "Pune West", group: "Om Sai purchase group" },
  { name: "Krishna Paint House", contact: "Sunil Deshmukh", phone: "9890234567", city: "Nashik", owner: 0, cycle: 28, lastOrderDaysAgo: 9, lastOrderValue: 212000, avgOrder: 198000, paysIn: 28, route: "Nashik City", group: "Krishna Paint House group" },
  { name: "Balaji Coatings", contact: "Rohit Jadhav", phone: "9767345678", city: "Aurangabad", owner: 0, cycle: 35, lastOrderDaysAgo: 78, lastOrderValue: 64000, avgOrder: 88000, paysIn: 61, route: "Marathwada" },
  { name: "Ganesh Hardware Mart", contact: "Amit Kulkarni", phone: "9822456789", city: "Nashik", owner: 0, cycle: 14, lastOrderDaysAgo: 4, lastOrderValue: 148000, avgOrder: 132000, paysIn: 22, route: "Nashik City" },
  { name: "Deccan Paint Suppliers", contact: "Prakash More", phone: "9765567890", city: "Pune", owner: 0, cycle: 25, lastOrderDaysAgo: 33, lastOrderValue: 276000, avgOrder: 244000, paysIn: 45, route: "Pune East" },
  { name: "Sai Enterprises", contact: "Nitin Bhosale", phone: "9881678901", city: "Ahmednagar", owner: 0, cycle: 30, lastOrderDaysAgo: 67, lastOrderValue: 52000, avgOrder: 71000, paysIn: 38, route: "Ahmednagar" },
  { name: "Jai Bhavani Hardware", contact: "Santosh Gaikwad", phone: "9823789012", city: "Nashik", owner: 0, cycle: 21, lastOrderDaysAgo: 18, lastOrderValue: 118000, avgOrder: 109000, paysIn: 30, route: "Nashik–Sinnar" },
  { name: "Maharashtra Paint Depot", contact: "Vijay Shinde", phone: "9890890123", city: "Nashik", owner: 0, cycle: 18, lastOrderDaysAgo: 2, lastOrderValue: 324000, avgOrder: 288000, paysIn: 26, route: "Nashik City" },
  { name: "New India Colours", contact: "Kiran Salunkhe", phone: "9822901234", city: "Pune", owner: 0, cycle: 40, lastOrderDaysAgo: 95, lastOrderValue: 44000, avgOrder: 62000, paysIn: 71, route: "Pune West" },

  { name: "Ratnadeep Hardware", contact: "Anil Chavan", phone: "9767012345", city: "Kolhapur", owner: 1, cycle: 28, lastOrderDaysAgo: 22, lastOrderValue: 96000, avgOrder: 94000, paysIn: 33, route: "Kolhapur" },
  { name: "Vishwas Paint Centre", contact: "Deepak Patil", phone: "9881123456", city: "Sangli", owner: 1, cycle: 30, lastOrderDaysAgo: 56, lastOrderValue: 78000, avgOrder: 86000, paysIn: 58, route: "Sangli" },
  { name: "Shivneri Traders", contact: "Manoj Kadam", phone: "9823234567", city: "Satara", owner: 1, cycle: 24, lastOrderDaysAgo: 7, lastOrderValue: 156000, avgOrder: 142000, paysIn: 27, route: "Satara" },
  { name: "Anand Hardware Stores", contact: "Sachin Thorat", phone: "9890345678", city: "Kolhapur", owner: 1, cycle: 35, lastOrderDaysAgo: 88, lastOrderValue: 38000, avgOrder: 54000, paysIn: 66, route: "Kolhapur" },
  { name: "Laxmi Paint & Chemicals", contact: "Ravi Mane", phone: "9822456780", city: "Sangli", owner: 1, cycle: 21, lastOrderDaysAgo: 14, lastOrderValue: 202000, avgOrder: 188000, paysIn: 31, route: "Sangli" },

  { name: "Sagar Coatings", contact: "Pravin Sawant", phone: "9765678902", city: "Thane", owner: 2, cycle: 18, lastOrderDaysAgo: 5, lastOrderValue: 268000, avgOrder: 236000, paysIn: 24, route: "Thane" },
  { name: "Konkan Hardware", contact: "Suhas Naik", phone: "9881789013", city: "Ratnagiri", owner: 2, cycle: 45, lastOrderDaysAgo: 102, lastOrderValue: 42000, avgOrder: 58000, paysIn: 49, route: "Konkan" },
  { name: "Mumbai Paint Mart", contact: "Farhan Shaikh", phone: "9823890124", city: "Mumbai", owner: 2, cycle: 14, lastOrderDaysAgo: 3, lastOrderValue: 412000, avgOrder: 368000, paysIn: 21, route: "Mumbai Central" },
  { name: "Vasai Colour House", contact: "Dinesh Raut", phone: "9890901235", city: "Vasai", owner: 2, cycle: 28, lastOrderDaysAgo: 31, lastOrderValue: 88000, avgOrder: 96000, paysIn: 42, route: "Palghar" },
  { name: "Bharat Hardware", contact: "Yogesh Tambe", phone: "9822012346", city: "Thane", owner: 2, cycle: 30, lastOrderDaysAgo: 64, lastOrderValue: 72000, avgOrder: 84000, paysIn: 55, route: "Thane" },

  { name: "Sharda Paints", contact: "Nilesh Wagh", phone: "9767123457", city: "Jalgaon", owner: 3, cycle: 32, lastOrderDaysAgo: 71, lastOrderValue: 56000, avgOrder: 68000, paysIn: 63, route: "Khandesh" },
  { name: "Tapti Traders", contact: "Ashok Patil", phone: "9881234568", city: "Dhule", owner: 3, cycle: 30, lastOrderDaysAgo: 26, lastOrderValue: 104000, avgOrder: 98000, paysIn: 36, route: "Khandesh" },
  { name: "Girna Hardware", contact: "Rahul Borse", phone: "9823345679", city: "Jalgaon", owner: 3, cycle: 21, lastOrderDaysAgo: 11, lastOrderValue: 132000, avgOrder: 124000, paysIn: 29, route: "Khandesh" },

  { name: "Vidarbha Paint Supply", contact: "Sandeep Ingle", phone: "9890456781", city: "Nagpur", owner: 4, cycle: 25, lastOrderDaysAgo: 8, lastOrderValue: 246000, avgOrder: 218000, paysIn: 27, route: "Nagpur" },
  { name: "Orange City Hardware", contact: "Mangesh Dhole", phone: "9822567892", city: "Nagpur", owner: 4, cycle: 30, lastOrderDaysAgo: 48, lastOrderValue: 82000, avgOrder: 92000, paysIn: 51, route: "Nagpur" },
  { name: "Wardha Colour Mart", contact: "Sunil Kale", phone: "9765678903", city: "Wardha", owner: 4, cycle: 35, lastOrderDaysAgo: 84, lastOrderValue: 46000, avgOrder: 61000, paysIn: 59, route: "Vidarbha" },
  { name: "Amravati Paint House", contact: "Ganesh Wankhede", phone: "9881789014", city: "Amravati", owner: 4, cycle: 28, lastOrderDaysAgo: 16, lastOrderValue: 138000, avgOrder: 128000, paysIn: 32, route: "Vidarbha" },
];

const TEMPLATES = [
  {
    name: "Order confirmation",
    category: "Orders",
    appliesTo: "personal" as const,
    body:
      "Namaste {{contact}} ji,\n\nThank you for your order with Mahek Marketing.\n\n" +
      "Order value: {{last_order_value}}\nWe will confirm the dispatch date shortly.\n\n" +
      "— {{owner}}, Mahek Marketing India",
  },
  {
    name: "Payment reminder · stage 1",
    category: "Payments",
    appliesTo: "personal" as const,
    body:
      "Namaste {{contact}} ji,\n\nA gentle reminder that {{outstanding}} is pending " +
      "against {{customer}}.\n\nOldest bill {{bill_no}} was due on {{bill_due}}.\n\n" +
      "Kindly arrange the payment at your convenience.\n\n— {{owner}}, Mahek Marketing India",
  },
  {
    name: "Payment reminder · stage 2",
    category: "Payments",
    appliesTo: "personal" as const,
    body:
      "Namaste {{contact}} ji,\n\n{{outstanding}} is now overdue against {{customer}}.\n\n" +
      "Bill {{bill_no}} was due on {{bill_due}}. Please confirm a date by which we can " +
      "expect the payment.\n\n— {{owner}}, Mahek Marketing India",
  },
  {
    name: "Payment reminder · stage 3",
    category: "Payments",
    appliesTo: "personal" as const,
    body:
      "Namaste {{contact}} ji,\n\nDespite earlier reminders, {{outstanding}} remains " +
      "unpaid against {{customer}}.\n\nWe would like to settle this before further " +
      "supplies. Please call us today.\n\n— {{owner}}, Mahek Marketing India",
  },
  {
    name: "Reorder nudge",
    category: "Sales",
    appliesTo: "group" as const,
    body:
      "Namaste {{contact}} ji,\n\nIt has been a while since your last order on " +
      "{{last_order_date}}. Stock is ready and rates are unchanged this month.\n\n" +
      "Shall I book your usual quantity?\n\n— {{owner}}, Mahek Marketing India",
  },
  {
    name: "Complaint acknowledgement",
    category: "Service",
    appliesTo: "personal" as const,
    body:
      "Namaste {{contact}} ji,\n\nWe have recorded your complaint and it is with our " +
      "operations team. We will come back to you with a resolution.\n\n" +
      "Sorry for the trouble.\n\n— {{owner}}, Mahek Marketing India",
  },
];

const HELP: Array<{
  title: string;
  category: string;
  role: string;
  isScript: boolean;
  scriptBody?: string;
  body: string;
}> = [
  {
    title: "Opening a cold call",
    category: "Call scripts",
    role: "Telecaller",
    isScript: true,
    scriptBody:
      "Namaste, am I speaking to {contact name}? This is {your name} calling from " +
      "Mahek Marketing India, Nashik. We supply thinners and coatings.\n\n" +
      "Is this a good time to speak for two minutes?",
    body:
      "Say the company name in the first sentence. Most shopkeepers take the call if " +
      "they recognise the supplier.\n\nIf they say it is a bad time, ask for a specific " +
      "time later the same day and set a reminder before you hang up. Do not leave it " +
      "at 'I will call back'.",
  },
  {
    title: "Asking for an overdue payment",
    category: "Call scripts",
    role: "Telecaller",
    isScript: true,
    scriptBody:
      "Namaste {contact name} ji. I am calling about bill {bill number} for " +
      "{amount}, which was due on {due date}.\n\nCan you tell me a date by which we can " +
      "expect the payment?",
    body:
      "Never ask 'when can you pay'. Ask for a date, and repeat it back. A date is a " +
      "promise you can record; 'soon' is not.\n\nAlways record the promise in the app " +
      "before the call ends — it creates the chase reminder for the day after.",
  },
  {
    title: "Handling a short supply complaint",
    category: "Call scripts",
    role: "Telecaller",
    isScript: true,
    scriptBody:
      "I am sorry that happened. Let me note exactly what was short — which " +
      "product and how many drums?\n\nI am logging it now and our operations team will " +
      "come back to you. You will hear from us either way.",
    body:
      "Log the complaint while the customer is still on the line, in their words. Do " +
      "not promise a resolution date you cannot control — promise a call back instead.",
  },
  {
    title: "When to hold a customer back from the queue",
    category: "SOPs",
    role: "Telecaller",
    isScript: false,
    body:
      "A customer is held back from today's calling queue when:\n\n" +
      "· a WhatsApp message was sent to them in the last two days\n" +
      "· a reminder for them falls on a later date\n" +
      "· a manager has paused the account\n\n" +
      "Held-back customers are listed under the queue so nothing disappears silently. " +
      "Open that list if you think somebody is missing.",
  },
  {
    title: "Closing the day properly",
    category: "SOPs",
    role: "Telecaller",
    isScript: false,
    body:
      "Before you submit the EOD report:\n\n" +
      "1. Every reminder due today must be closed or carried forward.\n" +
      "2. Every call you made must have an outcome — not just a note.\n" +
      "3. Any order taken must have a value against it.\n\n" +
      "The EOD text is generated from what you logged, so a thin report means a thin " +
      "day of logging, not a thin day of work. Fix the logging.",
  },
  {
    title: "Deciding on an inactive customer",
    category: "SOPs",
    role: "Manager",
    isScript: false,
    body:
      "A customer reaches the inactive watch after twice their own buying cycle with " +
      "no order. That is deliberate — a 14-day buyer going quiet for a month matters " +
      "more than a 45-day buyer doing the same.\n\n" +
      "Decide within two weeks: reassign, re-price, or deactivate. An account sitting " +
      "on the watch without a decision is the one that quietly leaves.",
  },
  {
    title: "Setting monthly targets",
    category: "SOPs",
    role: "Manager",
    isScript: false,
    body:
      "Where no target is set, the system applies the customer's own run rate — their " +
      "average order spread over a month — and marks the row 'Default'.\n\n" +
      "Defaults are honest but unambitious. Review them at the start of the month and " +
      "set real numbers on the accounts that can grow.",
  },
  {
    title: "Reading the payment stages",
    category: "SOPs",
    role: "Telecaller",
    isScript: false,
    body:
      "Reminder due → nothing sent yet. Send the stage 1 message.\n" +
      "Stage 1 sent → call and confirm they saw it.\n" +
      "Stage 2 sent → get a dated promise, not a vague one.\n" +
      "Promise made → do not chase before the date. It annoys good payers.\n" +
      "Promise broken → call the same day. This is the one that decides whether you " +
      "get paid.\n" +
      "Escalate → over 90 days. Hand it to the manager with the full history.",
  },
];

async function main() {
  console.log("Clearing existing data…");
  // Child tables first — foreign keys are enforced.
  await db.delete(auditLog);
  await db.delete(attendance);
  await db.delete(appAccess);
  await db.delete(notifications);
  await db.delete(eodReports);
  await db.delete(waRuns);
  await db.delete(waReplies);
  await db.delete(waMessages);
  await db.delete(waTemplates);
  await db.delete(complaintEvents);
  await db.delete(complaints);
  await db.delete(promises);
  await db.delete(reminders);
  await db.delete(orders);
  await db.delete(interactions);
  await db.delete(queueItems);
  await db.delete(payments);
  await db.delete(bills);
  await db.delete(targets);
  await db.delete(customers);
  await db.delete(sessions);
  await db.delete(users);
  await db.delete(settings);
  await db.delete(helpArticles);

  console.log("Creating team…");
  const passwordHash = await hashPassword("mahek1234");
  const userRows = TEAM.map((t) => ({
    id: id("usr"),
    name: t.name,
    email: t.email,
    phone: t.phone,
    passwordHash,
    role: t.role,
    initials: initialsOf(t.name),
  }));
  await db.insert(users).values(userRows);

  console.log("Granting app access…");
  await db.insert(appAccess).values(
    TEAM.flatMap((t, i) =>
      t.apps.map((app) => ({
        id: id("acc"),
        userId: userRows[i].id,
        app: app as "crm" | "field" | "orders" | "people" | "reports" | "admin",
        grantedById: userRows[5].id,
      })),
    ),
  );

  console.log("Creating customers…");
  const customerRows = CUSTOMERS.map((c) => {
    const slow = c.paysIn > 45;
    return {
      id: id("cus"),
      name: c.name,
      contactPerson: c.contact,
      phone: c.phone,
      city: c.city,
      ownerId: userRows[c.owner].id,
      status: slow ? ("Slow payer" as const) : ("Active" as const),
      gstin: `27AAB${c.phone.slice(0, 4)}M1Z${c.owner}`,
      creditTermDays: 30,
      route: c.route,
      cycleDays: c.cycle,
      lastOrderDate: iso(-c.lastOrderDaysAgo),
      lastOrderValue: rupees(c.lastOrderValue),
      lastContactAt: at(-Math.min(c.lastOrderDaysAgo, 6), 11, 20),
      outstanding: 0,
      avgOrderValue: rupees(c.avgOrder),
      orders6m: Math.max(1, Math.round(180 / c.cycle)),
      paysInDays: c.paysIn,
      slowPayer: slow,
      whatsappGroupName: c.group ?? null,
      whatsappDest: (c.group ? "group" : "personal") as "group" | "personal",
      customerSince: iso(-(400 + c.owner * 90)),
    };
  });
  await db.insert(customers).values(customerRows);
  const byIndex = (i: number) => customerRows[i];

  console.log("Creating bills and payments…");
  const billRows: Array<typeof bills.$inferInsert> = [];
  const paymentRows: Array<typeof payments.$inferInsert> = [];
  let billSeq = 4100;

  customerRows.forEach((c, i) => {
    const source = CUSTOMERS[i];
    // Three to five bills each, spread across the aging buckets.
    const count = 3 + (i % 3);
    for (let n = 0; n < count; n++) {
      const raisedDaysAgo = 8 + n * 26 + (i % 7) * 3;
      const amount = rupees(Math.round(source.avgOrder * (0.6 + ((i + n) % 5) * 0.2)));
      // Older bills are more likely to be settled; slow payers less so.
      const settled = n === 0 ? false : source.paysIn < 40 ? n > 1 : n > 2;
      const paid = settled
        ? amount
        : n === 1 && i % 3 === 0
          ? Math.round(amount * 0.4)
          : 0;

      const billId = id("bil");
      billRows.push({
        id: billId,
        billNo: `MM/${PERIOD.slice(0, 4)}/${++billSeq}`,
        customerId: c.id,
        billDate: iso(-raisedDaysAgo),
        dueDate: iso(-raisedDaysAgo + 30),
        amount,
        paid,
      });

      if (paid > 0) {
        paymentRows.push({
          id: id("pay"),
          billId,
          customerId: c.id,
          amount: paid,
          mode: n % 2 === 0 ? "Bank transfer" : "Cheque",
          reference: `UTR${900000 + billSeq}`,
          receivedOn: iso(-raisedDaysAgo + source.paysIn),
          recordedById: userRows[source.owner].id,
        });
      }
    }
  });
  await db.insert(bills).values(billRows);
  await db.insert(payments).values(paymentRows);

  console.log("Rolling up outstanding…");
  await client`
    update customers c
    set outstanding = coalesce((
      select sum(b.amount - b.paid) from bills b where b.customer_id = c.id
    ), 0)
  `;

  console.log("Creating targets…");
  await db.insert(targets).values(
    customerRows.map((c, i) => ({
      id: id("tgt"),
      customerId: c.id,
      period: PERIOD,
      amount: rupees(Math.round((CUSTOMERS[i].avgOrder * 30) / CUSTOMERS[i].cycle)),
      // Two thirds have been reviewed; the rest sit on the auto default.
      isDefault: i % 3 === 2,
      setById: i % 3 === 2 ? null : userRows[5].id,
    })),
  );

  console.log("Creating interactions, orders and reminders…");
  const interactionRows: Array<typeof interactions.$inferInsert> = [];
  const orderRows: Array<typeof orders.$inferInsert> = [];
  const reminderRows: Array<typeof reminders.$inferInsert> = [];

  const OUTCOMES = [
    "Order placed",
    "Will order later",
    "Payment promised",
    "Call back later",
    "Not interested",
  ];
  const NOTES = [
    "Wants the revised 200L drum rate before committing.",
    "Stock is sufficient until month end, will reorder after that.",
    "Cheque ready, asked us to collect on Friday.",
    "Complained about the last delivery being two drums short.",
    "Comparing rates with another supplier, wants a call on Monday.",
    "Confirmed the usual quantity, dispatch this week.",
    "Owner was travelling — spoke to the accountant instead.",
  ];

  customerRows.forEach((c, i) => {
    const source = CUSTOMERS[i];
    const owner = userRows[source.owner].id;

    // A short history for every customer, and today's activity for the team.
    for (let n = 0; n < 4; n++) {
      const daysAgo = n === 0 ? 0 : n * 4 + (i % 5);
      const outcome = OUTCOMES[(i + n) % OUTCOMES.length];
      const connected = (i + n) % 5 !== 3;

      // Today's calls: only some customers, so the queue still has work in it.
      if (daysAgo === 0 && i % 3 !== 0) continue;

      interactionRows.push({
        id: id("int"),
        customerId: c.id,
        userId: owner,
        channel: "Call",
        connection: connected
          ? "Connected"
          : (i + n) % 2 === 0
            ? "Missed"
            : "Not reachable",
        outcome: connected ? outcome : "No answer",
        note: connected ? NOTES[(i + n) % NOTES.length] : "Rang out, will retry.",
        produced: connected && outcome === "Order placed" ? "Order captured" : null,
        occurredAt: at(-daysAgo, 10 + (n % 6), (i * 7) % 60),
      });

      if (connected && outcome === "Order placed") {
        orderRows.push({
          id: id("ord"),
          customerId: c.id,
          userId: owner,
          product: ["NC thinner 20L", "MTO thinner 200L", "Low-odour thinner 20L"][
            (i + n) % 3
          ],
          quantity: 2 + ((i + n) % 6),
          value: rupees(Math.round(source.avgOrder * (0.7 + ((i + n) % 4) * 0.15))),
          expectedDispatch: iso(-daysAgo + 3),
          placedAt: at(-daysAgo, 11 + (n % 4), 15),
        });
      }
    }

    // Reminders: a mix of overdue, due today and upcoming.
    const remOffsets = i % 4 === 0 ? [-3, 0, 4] : i % 4 === 1 ? [0] : i % 4 === 2 ? [2] : [];
    for (const offset of remOffsets) {
      reminderRows.push({
        id: id("rem"),
        customerId: c.id,
        userId: owner,
        dueDate: iso(offset),
        note:
          offset < 0
            ? `Chase the cheque promised for ${shortDate(iso(offset))}`
            : offset === 0
              ? "Call back with the revised drum rate"
              : "Confirm the dispatch schedule for next week",
        source: offset < 0 ? "promise" : "call",
        status: "open" as const,
        createdAt: at(offset - 5, 12),
      });
    }

    // Some closed ones so the "done" tab is not empty.
    if (i % 5 === 0) {
      reminderRows.push({
        id: id("rem"),
        customerId: c.id,
        userId: owner,
        dueDate: iso(-2),
        note: "Sent the rate list as promised",
        source: "call",
        status: "done" as const,
        completedAt: at(-2, 16),
        createdAt: at(-6, 10),
      });
    }
  });

  await db.insert(interactions).values(interactionRows);
  await db.insert(orders).values(orderRows);
  await db.insert(reminders).values(reminderRows);

  console.log("Creating promises, complaints and the queue…");
  await db.insert(promises).values(
    customerRows
      .filter((_, i) => CUSTOMERS[i].paysIn > 45)
      .slice(0, 5)
      .map((c, n) => ({
        id: id("prm"),
        customerId: c.id,
        userId: userRows[0].id,
        amount: rupees(60000 + n * 25000),
        // Two of them are already broken — those are the calls that matter.
        promisedBy: iso(n < 2 ? -3 - n : 2 + n),
        note: "Owner confirmed the cheque would be handed over.",
        kept: null,
      })),
  );

  const complaintRows: Array<typeof complaints.$inferInsert> = [];
  const complaintEventRows: Array<typeof complaintEvents.$inferInsert> = [];
  const COMPLAINTS = [
    { cat: "Delivery", desc: "Last consignment was two drums short of the invoice.", status: "Open" as const, ago: 9 },
    { cat: "Product quality", desc: "NC thinner from the last batch is drying too slowly.", status: "In progress" as const, ago: 6 },
    { cat: "Billing", desc: "GST rate on bill is 18% but the order was quoted at 12%.", status: "Open" as const, ago: 3 },
    { cat: "Pricing", desc: "Competitor is quoting ₹8 per litre less on 200L drums.", status: "Open" as const, ago: 12 },
    { cat: "Service", desc: "Nobody called back after the last complaint was raised.", status: "Resolved" as const, ago: 15 },
    { cat: "Delivery", desc: "Delivery arrived a day late and the shop was shut.", status: "In progress" as const, ago: 4 },
  ];

  COMPLAINTS.forEach((c, n) => {
    const customer = byIndex(n * 4);
    const complaintId = id("cmp");
    complaintRows.push({
      id: complaintId,
      customerId: customer.id,
      category: c.cat,
      description: c.desc,
      loggedById: userRows[n % 5].id,
      assignedTo: n % 2 === 0 ? "Operations" : "Accounts",
      status: c.status,
      resolutionNote:
        c.status === "Resolved" ? "Called the owner and agreed a credit note." : null,
      customerTold: c.status === "Resolved",
      loggedOn: iso(-c.ago),
      resolvedAt: c.status === "Resolved" ? at(-2, 15) : null,
    });
    complaintEventRows.push({
      id: id("cev"),
      complaintId,
      note: `Logged by ${userRows[n % 5].name}`,
      at: at(-c.ago, 11),
    });
    if (c.status !== "Open") {
      complaintEventRows.push({
        id: id("cev"),
        complaintId,
        note: `Assigned to ${n % 2 === 0 ? "Operations" : "Accounts"}`,
        at: at(-c.ago + 1, 10),
      });
    }
  });
  await db.insert(complaints).values(complaintRows);
  await db.insert(complaintEvents).values(complaintEventRows);

  // Today's queue, one per owner, built by the same rules the app uses.
  const openComplaintCustomers = new Set(
    complaintRows.filter((c) => c.status !== "Resolved").map((c) => c.customerId),
  );
  const dueReminderCustomers = new Set(
    reminderRows.filter((r) => r.status === "open" && r.dueDate <= TODAY).map((r) => r.customerId),
  );

  const queueRows = customerRows
    .map((c, i) => {
      const source = CUSTOMERS[i];
      let reason: string | null = null;
      let priority = 100;

      if (openComplaintCustomers.has(c.id)) {
        reason = "Open complaint";
        priority = 10;
      } else if (dueReminderCustomers.has(c.id)) {
        reason = "Reminder due";
        priority = 20;
      } else if (c.outstanding !== 0 && source.paysIn > 45) {
        reason = "Payment overdue";
        priority = 30;
      } else if (source.lastOrderDaysAgo > source.cycle * 2) {
        reason = "Gone quiet";
        priority = 50;
      } else if (source.lastOrderDaysAgo > source.cycle) {
        reason = "Due to reorder";
        priority = 60;
      } else {
        reason = "Payment follow-up";
        priority = 40;
      }

      return {
        id: id("qi"),
        day: TODAY,
        customerId: c.id,
        ownerId: c.ownerId!,
        reason,
        priority,
        // Roughly a third already worked, matching the day being underway.
        worked: i % 3 === 0,
        skipped: i === 7 || i === 18,
        heldBackReason:
          i === 7 || i === 18 ? "WhatsApp message sent in the last two days" : null,
      };
    })
    .filter(Boolean);
  await db.insert(queueItems).values(queueRows);

  console.log("Creating WhatsApp templates, messages and replies…");
  const templateRows = TEMPLATES.map((t, i) => ({
    id: id("tpl"),
    name: t.name,
    category: t.category,
    body: t.body,
    appliesTo: t.appliesTo,
    uses: 12 + i * 9,
    archived: false,
    updatedAt: at(-14 + i, 12),
  }));
  await db.insert(waTemplates).values(templateRows);

  const messageRows: Array<typeof waMessages.$inferInsert> = [];
  customerRows.slice(0, 14).forEach((c, i) => {
    const template = templateRows[i % templateRows.length];
    const statuses = ["Sent", "Delivered", "Read", "Copied"] as const;
    messageRows.push({
      id: id("wam"),
      customerId: c.id,
      templateId: template.id,
      templateName: template.name,
      body: template.body,
      edited: i % 5 === 0,
      destination: c.whatsappGroupName ?? c.phone,
      destKind: c.whatsappGroupName ? "group" : "personal",
      mode: "manual",
      // A few never got confirmed — that is the point of the "Copied" state.
      status: statuses[i % statuses.length],
      sentById: c.ownerId!,
      createdAt: at(-(i % 5), 9 + (i % 8), (i * 11) % 60),
    });
  });
  await db.insert(waMessages).values(messageRows);

  await db.insert(waReplies).values(
    [
      { i: 1, msg: "Send the rate list for 200L drums please." },
      { i: 5, msg: "Payment done today, ₹1,20,000 by NEFT." },
      { i: 9, msg: "Delivery still not received. Please check." },
      { i: 12, msg: "Call me after 4 pm tomorrow." },
    ].map((r, n) => ({
      id: id("rep"),
      customerId: byIndex(r.i).id,
      message: r.msg,
      actioned: false,
      receivedAt: at(0, 8 + n * 2, 15),
    })),
  );

  await db.insert(settings).values({ key: "whatsapp_mode", value: { mode: "manual" } });

  console.log("Creating help articles and notifications…");
  await db.insert(helpArticles).values(
    HELP.map((h) => ({
      id: id("hlp"),
      title: h.title,
      category: h.category,
      role: h.role,
      isScript: h.isScript,
      scriptBody: h.scriptBody ?? null,
      body: h.body,
      updatedOn: iso(-30),
    })),
  );

  await db.insert(notifications).values([
    {
      id: id("ntf"),
      userId: userRows[0].id,
      title: "Promise date passed",
      body: `${customerRows[1].name} promised payment three days ago. Nothing has arrived.`,
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
      userId: userRows[0].id,
      title: "Queue rebuilt",
      body: "Today's calling queue is ready. Six rows carried over from yesterday.",
      kind: "info",
      href: "/crm/queue",
      read: true,
      createdAt: at(0, 8, 0),
    },
    {
      id: id("ntf"),
      userId: userRows[5].id,
      title: "Complaint ageing",
      body: "A pricing complaint has been open for 12 days without a decision.",
      kind: "danger",
      href: "/crm/complaints",
      createdAt: at(0, 9, 15),
    },
  ]);

  const counts = {
    users: userRows.length,
    customers: customerRows.length,
    bills: billRows.length,
    payments: paymentRows.length,
    interactions: interactionRows.length,
    orders: orderRows.length,
    reminders: reminderRows.length,
    complaints: complaintRows.length,
    queue: queueRows.length,
    messages: messageRows.length,
    templates: templateRows.length,
  };

  console.log("\nSeeded:");
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(14)} ${v}`);
  console.log("\nSign in with any of (email or work number):");
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
