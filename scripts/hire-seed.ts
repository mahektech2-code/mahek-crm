/**
 * Hire's seed.
 *
 *   npm run hire:seed                 the seeded role blueprints only — safe anywhere
 *   npm run hire:seed -- --demo --reset
 *                                     DEVELOPMENT: wipes Hire's tables and loads its
 *                                     staff accounts and a realistic pipeline
 */
import { seedHireBlueprints, seedHireDemo } from "../src/lib/hire/seed/seed";

async function main() {
  const args = process.argv.slice(2);
  for (const a of args) if (!["--demo", "--reset"].includes(a)) throw new Error(`Unknown option "${a}".`);
  if (args.includes("--demo")) {
    const r = await seedHireDemo({ reset: args.includes("--reset") });
    console.log(`Hire demo: ${r.staff} staff accounts (password mahek1234), ${r.applications} applications.`);
  } else {
    const r = await seedHireBlueprints();
    console.log(r.created.length ? `Created: ${r.created.join(", ")}` : "Every seeded blueprint is already there.");
  }
  process.exit(0);
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
