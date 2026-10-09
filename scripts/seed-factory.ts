/**
 * A factory floor to look at locally: the design's people, products and
 * orders, made through the ERP's own handlers. Every person's PIN is 1234.
 *
 *   npm run factory:seed
 *
 * Refuses a database that already has factory staff, and refuses production.
 */
import { seedFactoryFloor } from "@/lib/factory/demo-seed";
import { db } from "@/db";

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (/one\.mahekindia|prod/i.test(url)) throw new Error("Not on production.");
  const s = await seedFactoryFloor();
  console.log("Seeded the factory floor. Sign in at /factory with any of these numbers and PIN " + s.pin + ":");
  for (const [k, u] of Object.entries(s.users)) console.log("  " + k.padEnd(10) + u.phone);
  await db.$client.end();
}
main().catch(async (e) => {
  console.error(e);
  await db.$client.end();
  process.exit(1);
});
