/**
 * LOCAL DEMO DATA FOR THE LOCKER — the design's own register, so the screens
 * can be looked at with something in them. NEVER for production: it refuses
 * to run unless DATABASE_URL points at this machine.
 *
 *   npx tsx --env-file=.env.local scripts/locker-demo-seed.ts
 *
 * Idempotent: every row it writes has a `demo_` id and is replaced on a re-run.
 * Owners are the seeded MahekOne accounts (db:seed), assigned round-robin.
 * It also grants the Locker to vikram@mahek.in as an admin so there is
 * somebody to sign in as. No vault secrets are written — add those through
 * the vault's own screen, which is the only path that encrypts them.
 */
import { randomUUID } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";

const url = process.env.DATABASE_URL ?? "";
const host = (() => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
})();
if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
  console.error(`Refusing: DATABASE_URL host is "${host || "unset"}". This script only writes demo data to a database on this machine.`);
  process.exit(1);
}

async function main() {
  const { db } = await import("../src/db");
  const S = await import("../src/db/schema");
  const { CATEGORY, TYPE_SEED } = await import("../src/lib/locker/catalogue");
  const { addDays, today } = await import("../src/lib/format");

  const day = today();
  let h = 20261009;
  const r = () => ((h = (h * 1103515245 + 12345) >>> 0), (h >>> 16) / 65536);
  const pk = <T,>(a: T[]) => a[Math.floor(r() * a.length) % a.length];
  const ri = (a: number, b: number) => a + Math.floor(r() * (b - a + 1));
  const T = Object.fromEntries(TYPE_SEED.map((t) => [t.code, t]));

  const people = await db.select({ id: S.users.id, email: S.users.email }).from(S.users).where(eq(S.users.active, true));
  if (!people.length) throw new Error("No users. Run npm run db:seed first.");
  const vikram = people.find((p) => p.email === "vikram@mahek.in") ?? people[0];

  /* Clear the previous demo run (children first). */
  await db.execute(sql`delete from locker_renewals where asset_id like 'demo_%'`);
  await db.execute(sql`delete from locker_reminders_sent where asset_id like 'demo_%'`);
  await db.execute(sql`update locker_assets set replaces_id = null where id like 'demo_%'`);
  await db.delete(S.lockerAssets).where(like(S.lockerAssets.id, "demo_%"));
  await db.delete(S.lockerPaymentMethods).where(like(S.lockerPaymentMethods.id, "demo_%"));
  await db.delete(S.lockerSites).where(like(S.lockerSites.id, "demo_%"));
  await db.delete(S.lockerEntities).where(like(S.lockerEntities.id, "demo_%"));

  const ENTS: [string, string, boolean][] = [
    ["Mahek Marketing India Pvt Ltd", "27ACJPM4734C1ZP", true],
    ["Melody Coatings Pvt Ltd", "27AAKCM8812D1Z4", false],
    ["Mahek Chemicals LLP", "27AAVFM2210K1ZQ", false],
  ];
  await db.insert(S.lockerEntities).values(ENTS.map((e, i) => ({ id: `demo_ent_${i}`, name: e[0], gstin: e[1], isPrimary: e[2] })));
  const LOCS: [string, string, string, boolean][] = [
    ["Bhiwandi HQ", "office", "Maharashtra", false],
    ["Bhiwandi Godown", "godown", "Maharashtra", true],
    ["Ambernath Plant", "factory", "Maharashtra", true],
    ["Taloja Godown", "godown", "Maharashtra", true],
    ["Pune Office", "office", "Maharashtra", false],
    ["Nagpur Depot", "depot", "Maharashtra", true],
    ["Indore Godown", "godown", "Madhya Pradesh", true],
    ["Raipur Depot", "depot", "Chhattisgarh", true],
  ];
  await db.insert(S.lockerSites).values(LOCS.map((l, i) => ({ id: `demo_site_${i}`, name: l[0], kind: l[1], state: l[2], hazardous: l[3], entityId: "demo_ent_0" })));
  await db.insert(S.lockerPaymentMethods).values([
    { id: "demo_pm1", label: "ICICI corporate card", kind: "Credit card", last4: "4417", expiresOn: addDays(day, 38), holder: "Finance", bank: "ICICI Bank" },
    { id: "demo_pm2", label: "HDFC business card", kind: "Credit card", last4: "8821", expiresOn: addDays(day, 410), holder: "Finance", bank: "HDFC Bank" },
    { id: "demo_pm3", label: "Axis card · IT", kind: "Credit card", last4: "1093", expiresOn: addDays(day, 24), holder: "IT", bank: "Axis Bank" },
    { id: "demo_pm4", label: "Personal card · Godown manager", kind: "Credit card", last4: "5512", expiresOn: addDays(day, 200), holder: "A godown manager", bank: "SBI Card", personal: true },
  ]);

  const seq: Record<string, number> = {};
  const rows: (typeof S.lockerAssets.$inferInsert)[] = [];
  const dist = () => {
    const x = r();
    if (x < 0.03) return -ri(1, 40);
    if (x < 0.075) return ri(0, 30);
    if (x < 0.18) return ri(31, 90);
    return ri(91, 1100);
  };
  const add = (o: { t: string; title: string; site?: number; d?: number | null; owner?: string | null; provider?: string; amount?: number; cycle?: string; pm?: string; auto?: boolean; notice?: number; stage?: string; conditions?: string; crit?: number }) => {
    const t = T[o.t];
    const code = CATEGORY[t.category].code;
    seq[code] = (seq[code] ?? 0) + 1;
    const d = t.model === "perpetual" ? null : o.d === undefined ? dist() : o.d;
    const crit = o.crit ?? t.criticality;
    const owner = o.owner === undefined ? pk(people).id : o.owner;
    rows.push({
      id: `demo_${randomUUID().slice(0, 12)}`,
      code: `LCK-${code}-${String(seq[code]).padStart(4, "0")}`,
      title: o.title,
      typeCode: t.code,
      category: t.category,
      criticality: crit,
      entityId: "demo_ent_0",
      siteId: o.site == null ? null : `demo_site_${o.site}`,
      endDate: d == null ? null : addDays(day, d),
      issuedOn: d == null ? addDays(day, -ri(200, 1500)) : addDays(day, d - Math.round(t.validityMonths * 30.44)),
      stage: o.stage ?? null,
      ownerId: owner,
      backupId: crit >= 3 && owner && r() < 0.9 ? pk(people.filter((p) => p.id !== owner)).id : null,
      docNo: `${code}/${ri(1000, 9999)}/${2019 + ri(0, 7)}`,
      provider: o.provider ?? "",
      amountPaise: (o.amount ?? 0) * 100,
      billingCycle: o.cycle ?? (t.model === "subscription" ? "Annual" : ""),
      paymentMethodId: o.pm ?? null,
      autoRenew: !!o.auto,
      noticeDays: t.model === "term_contract" ? (o.notice ?? t.leadDays) : 0,
      conditions: o.conditions ?? null,
      lastCheckedAt: new Date(Date.now() - ri(4, 420) * 86_400_000),
      createdById: vikram.id,
    });
  };

  add({ t: "peso", title: "PESO storage licence · Ambernath Plant", site: 2, d: 47, stage: "renewal_in_progress", conditions: "Storage capped at 45 KL of class A petroleum in the approved bulk shed. Earthing to be tested annually." });
  add({ t: "fire", title: "Fire NOC · Indore Godown", site: 6, d: -6 });
  add({ t: "pcb", title: "MPCB consent to operate · Taloja Godown", site: 3, d: -3, stage: "renewal_filed", conditions: "Red category. VOC monitoring quarterly; hazardous waste disposed only through the Taloja CHWTSDF." });
  add({ t: "hgt", title: "Hazardous goods licence · Tanker MH46 BU 8812", d: -2 });
  add({ t: "odlimit", title: "ICICI cash credit limit · ₹4.5 crore", d: 23 });
  add({ t: "factory", title: "Factory licence · Ambernath Plant", site: 2, d: 12 });
  add({ t: "domain", title: "mahek.com", d: 34, provider: "GoDaddy", amount: 1499, pm: "demo_pm1", auto: true, crit: 4 });
  add({ t: "wsp", title: "Google Workspace · mahek.com", d: 52, provider: "Google Workspace", amount: 412000, pm: "demo_pm1", auto: true });
  add({ t: "lease", title: "Lease · Bhiwandi Godown, Gala 14–16", site: 1, d: 108, notice: 90 });
  add({ t: "tm", title: "Trademark NANO · class 2", d: 210 });
  add({ t: "extg", title: "Fire extinguisher refill · Raipur Depot", site: 7, d: 19, owner: null });
  add({ t: "saas", title: "IndiaMART premium listing", d: 61, provider: "IndiaMART", amount: 68000, pm: "demo_pm4", auto: true, owner: null });
  LOCS.forEach((L, i) => {
    add({ t: "shops", title: `Shops & Establishment · ${L[0]}`, site: i });
    add({ t: "trade", title: `Trade licence · ${L[0]}`, site: i });
    if (i !== 6) add({ t: "fire", title: `Fire NOC · ${L[0]}`, site: i });
    add({ t: "proptax", title: `Property tax · ${L[0]}`, site: i });
    add({ t: i === 0 || i === 2 ? "lease" : "rent", title: `${i === 0 || i === 2 ? "Lease" : "Leave & licence"} · ${L[0]}`, site: i });
    add({ t: "stockins", title: `Stock insurance · ${L[0]}`, site: i, provider: pk(["ICICI Lombard", "New India Assurance", "HDFC Ergo"]) });
    if (L[3]) {
      if (i !== 2) add({ t: "peso", title: `PESO storage licence · ${L[0]}`, site: i });
      if (i !== 3) add({ t: "pcb", title: `Pollution Board consent · ${L[0]}`, site: i });
      add({ t: "hwaste", title: `Hazardous waste authorisation · ${L[0]}`, site: i });
    }
    add({ t: "amc", title: `CCTV AMC · ${L[0]}`, site: i, provider: "Hikvision partner" });
  });
  ["Maharashtra", "Madhya Pradesh", "Chhattisgarh"].forEach((s) => {
    add({ t: "gst", title: `GST registration · ${s}` });
    add({ t: "ptax", title: `Professional tax · ${s}` });
  });
  for (let v = 0; v < 8; v++) {
    const reg = `${pk(["MH04", "MH46", "MP09"])} ${pk(["KF", "BU", "GT"])} ${ri(1000, 9999)}`;
    add({ t: "rc", title: `RC · Delivery truck ${reg}` });
    add({ t: "vins", title: `Insurance · Delivery truck ${reg}`, provider: pk(["ICICI Lombard", "Tata AIG"]) });
    add({ t: "puc", title: `PUC · Delivery truck ${reg}`, d: ri(-20, 180) });
  }
  ["Zoho Books", "Figma", "Exotel", "WhatsApp Business API", "OpenAI API", "Slack Pro", "GitHub Team", "Wati", "Interakt"].forEach((sv) =>
    add({ t: "saas", title: sv, provider: sv.split(" ")[0], amount: ri(8, 96) * 1000, cycle: r() < 0.5 ? "Annual" : "Monthly", pm: pk(["demo_pm1", "demo_pm2", "demo_pm3"]), auto: r() < 0.8 }),
  );
  [["DigitalOcean", "Production droplets", 38000], ["DigitalOcean", "Staging", 9000], ["AWS", "S3 backups", 6500]].forEach((c) =>
    add({ t: "cloud", title: `${c[0]} · ${c[1]}`, provider: String(c[0]), amount: Number(c[2]), cycle: "Monthly", pm: "demo_pm3", auto: true, d: ri(1, 28) }),
  );
  add({ t: "tally", title: "Tally Prime licence · Bhiwandi HQ", site: 0 });
  add({ t: "incorp", title: "Certificate of incorporation · Mahek Marketing India Pvt Ltd" });
  add({ t: "roc", title: "Annual ROC filing FY 2025-26 · Mahek Marketing India Pvt Ltd" });
  for (let i = 0; i < 12; i++) add({ t: "dealer", title: `Dealer agreement · ${pk(["Shree", "Om Sai", "Balaji", "Vinayak"])} ${pk(["Paints", "Hardware", "Traders"])}, ${pk(["Nagpur", "Pune", "Indore", "Raipur"])}`, notice: 30 });

  /* Codes must not collide with anything already in the register. */
  const existing = new Set((await db.select({ code: S.lockerAssets.code }).from(S.lockerAssets)).map((x) => x.code));
  for (const row of rows) while (existing.has(row.code!)) row.code = row.code!.replace(/(\d+)$/, (n) => String(Number(n) + 1000).padStart(4, "0"));
  await db.insert(S.lockerAssets).values(rows);

  const [grant] = await db.select({ id: S.appAccess.id }).from(S.appAccess).where(sql`${S.appAccess.userId} = ${vikram.id} and ${S.appAccess.app} = 'locker'`);
  if (!grant) await db.insert(S.appAccess).values({ id: `aa_${randomUUID().slice(0, 12)}`, userId: vikram.id, app: "locker", role: "admin" });

  console.log(`Locker demo: ${rows.length} assets, ${ENTS.length} companies, ${LOCS.length} sites, 4 payment methods. Sign in as ${vikram.email}.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
