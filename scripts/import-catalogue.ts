/**
 * The product-master import, by hand.
 *
 *   npm run catalogue:import -- --dry-run   what would change, writing nothing
 *   npm run catalogue:import                apply it
 *
 * The same function the Admin Console calls. Idempotent: re-running reports
 * what changed and inserts nothing twice.
 */
import { importCatalogue } from "../src/lib/services/catalogue-import";

const dryRun = process.argv.includes("--dry-run");

async function main() {
  const r = await importCatalogue({ dryRun });

  console.log(dryRun ? "Dry run — nothing written.\n" : "Import applied.\n");
  console.log(
    Object.entries(r.counted)
      .map(([k, n]) => `  ${String(n).padStart(4)} ${k}`)
      .join("\n"),
  );
  console.log(`\n  ${r.created} created · ${r.updated} updated · ${r.unchanged} unchanged`);

  const shown = r.changes.slice(0, 20);
  for (const c of shown) {
    const fields = c.fields?.length ? ` (${c.fields.join(", ")})` : "";
    console.log(`  ${c.action.padEnd(8)} ${c.level.padEnd(14)} ${c.name}${fields}`);
  }
  if (r.changes.length > shown.length) {
    console.log(`  … and ${r.changes.length - shown.length} more`);
  }

  if (r.needsCanonicalId.length) {
    console.log(`\n  ${r.needsCanonicalId.length} names need a canonical legacy ID chosen:`);
    for (const n of r.needsCanonicalId) {
      console.log(`    ${n.name} — candidates ${n.externalIds.join(", ")}`);
    }
    console.log("  Resolve them in the Admin Console → Catalogue → Duplicates.");
  }

  for (const h of r.held) console.log(`\n  held: #${h.externalId} — ${h.reason}`);
  for (const e of r.excluded) console.log(`  excluded: #${e.externalId} ${e.name} — ${e.reason}`);
  for (const d of r.discrepancies) console.log(`  source discrepancy: ${d}`);

  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
