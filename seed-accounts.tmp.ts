/**
 * Puts one of each kind of waiting work on the Accounts desk, so the screens
 * can be driven by hand. Development database only — it inserts, it never
 * truncates.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  bills,
  complaints,
  customers,
  orders,
  paymentReceipts,
  payments,
  users,
} from "@/db/schema";

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

async function main() {
  const [priya] = await db.select().from(users).where(eq(users.email, "priya@mahek.in"));
  const [deepa] = await db.select().from(users).where(eq(users.email, "deepa@mahek.in"));
  if (!priya || !deepa) throw new Error("seed the demo users first");

  // Three customers that already carry open bills, so every figure is real.
  const withBills = await db
    .select({ id: customers.id, name: customers.name })
    .from(customers)
    .where(sql`exists (select 1 from bills b where b.customer_id = customers.id and b.amount > b.paid_amount)`)
    .orderBy(asc(customers.name))
    .limit(3);
  if (withBills.length < 3) throw new Error("need three customers with open bills");

  const [a, b, c] = withBills;

  // 1. An order waiting on approval, taken yesterday morning.
  await db.insert(orders).values({
    id: id("ord"),
    customerId: a.id,
    userId: priya.id,
    orderedAt: new Date(Date.now() - 31 * 3600_000),
    totalAmount: 18_600_00,
    status: "pending_approval",
    source: "crm",
  });

  // 2. A payment a telecaller was told about, allocated to the oldest bill.
  const [oldest] = await db
    .select()
    .from(bills)
    .where(and(eq(bills.customerId, b.id), sql`bills.amount > bills.paid_amount`))
    .orderBy(asc(bills.billDate))
    .limit(1);

  const receiptId = id("rcp");
  await db.insert(paymentReceipts).values({
    id: receiptId,
    customerId: b.id,
    amount: 5_000_00,
    receivedAt: new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10),
    mode: "Bank transfer",
    reference: "UTR904312",
    note: "Owner said the transfer went out on Friday afternoon.",
    status: "reported",
    source: "collections_call",
    reportedById: priya.id,
    idempotencyKey: randomUUID(),
    createdAt: new Date(Date.now() - 40 * 3600_000),
  });
  await db.insert(payments).values({
    id: id("pay"),
    receiptId,
    billId: oldest?.id ?? null,
    customerId: b.id,
    amount: 5_000_00,
    paidAt: new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10),
    mode: "Bank transfer",
    reference: "UTR904312",
    externalRef: randomUUID(),
    recordedById: priya.id,
  });

  // 3. A credit note asked for on a complaint, against a real bill.
  const [cBill] = await db
    .select()
    .from(bills)
    .where(and(eq(bills.customerId, c.id), sql`bills.amount > bills.paid_amount`))
    .orderBy(asc(bills.billDate))
    .limit(1);

  await db.insert(complaints).values({
    id: id("cmp"),
    customerId: c.id,
    category: "packaging_damage",
    description:
      "Two drums arrived with the seals broken and about four litres had leaked into the packing.",
    loggedByUserId: priya.id,
    slaDueAt: new Date(Date.now() + 2 * 86_400_000),
    requestCn: true,
    billId: cBill?.id ?? null,
    cnAmount: 1_240_00,
    goodsDescription: "2 × 20 L drums, seals broken",
    createdAt: new Date(Date.now() - 32 * 3600_000),
  });

  // 4. Money on account: a confirmed receipt pointed at no bill.
  const oaReceipt = id("rcp");
  await db.insert(paymentReceipts).values({
    id: oaReceipt,
    customerId: a.id,
    amount: 3_500_00,
    receivedAt: new Date().toISOString().slice(0, 10),
    mode: "Cash",
    status: "confirmed",
    source: "accounts",
    reportedById: deepa.id,
    confirmedById: deepa.id,
    confirmedAt: new Date(),
    idempotencyKey: randomUUID(),
  });
  await db.insert(payments).values({
    id: id("pay"),
    receiptId: oaReceipt,
    billId: null,
    customerId: a.id,
    amount: 3_500_00,
    paidAt: new Date().toISOString().slice(0, 10),
    mode: "Cash",
    externalRef: randomUUID(),
    recordedById: deepa.id,
  });

  console.log("seeded:");
  console.log("  order awaiting approval  ->", a.name);
  console.log("  payment awaiting confirm ->", b.name, oldest ? `(${oldest.billNo})` : "");
  console.log("  credit note requested    ->", c.name, cBill ? `(${cBill.billNo})` : "");
  console.log("  ₹3,500 on account        ->", a.name);
  await db.$client.end();
}

main();
