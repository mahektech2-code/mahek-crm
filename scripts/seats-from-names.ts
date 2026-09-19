/**
 * Put every sales seat back where the name on the record says it belongs.
 *
 *   npm run seats:from-names -- --dry-run
 *   npm run seats:from-names -- --actor=vikram@mahek.in
 *
 * Reads `customers.sales_person_name` and nothing else — never the party
 * sheet. See `lib/services/seats-from-names.ts` for why.
 *
 * A dry run writes nothing and prints what a real run would move. A real run
 * needs `--actor`, an admin's email, because every move is recorded under a
 * person's name: history row, audit row, timeline entry, notification.
 */
import { applySeatsFromNames, planSeatsFromNames } from "../src/lib/services/seats-from-names";

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry-run");
  const actor = args.find((a) => a.startsWith("--actor="))?.slice("--actor=".length);
  const only = (args.find((a) => a.startsWith("--kind="))?.slice("--kind=".length) ??
    "all") as "customer" | "lead" | "all";
  if (!["customer", "lead", "all"].includes(only)) {
    throw new Error(`--kind must be customer, lead or all — not "${only}".`);
  }

  const plan = await planSeatsFromNames(only);

  const byTarget = new Map<string, typeof plan.moves>();
  for (const m of plan.moves) {
    byTarget.set(m.wants, [...(byTarget.get(m.wants) ?? []), m]);
  }

  console.log(
    `\n${plan.moves.length} seats would move (${only}); ${plan.agree} already agree.\n`,
  );
  for (const [wants, moves] of [...byTarget].sort((a, b) => b[1].length - a[1].length)) {
    const from = new Map<string, number>();
    for (const m of moves) {
      const key = m.fromName ?? "(nobody)";
      from.set(key, (from.get(key) ?? 0) + 1);
    }
    console.log(
      `  → ${wants}: ${moves.length} account${moves.length === 1 ? "" : "s"}  (from ${[...from]
        .map(([n, c]) => `${n} ${c}`)
        .join(", ")})`,
    );
    for (const m of moves.slice(0, 5)) {
      console.log(`      ${m.customerName} [${m.kind}] ${m.customerId}`);
    }
    if (moves.length > 5) console.log(`      … and ${moves.length - 5} more`);
  }

  if (plan.unresolved.length) {
    console.log(`\nNamed somebody with no MahekOne account — left alone:`);
    for (const u of [...plan.unresolved].sort((a, b) => b.accounts - a.accounts)) {
      console.log(`  ${u.name}: ${u.accounts}`);
    }
  }

  if (dry || !actor) {
    console.log(
      `\nDry run — nothing was written.${actor ? "" : " Pass --actor=<admin email> to apply."}\n`,
    );
    return;
  }

  const result = await applySeatsFromNames(actor, only);
  console.log(`\nMoved ${result.moved} accounts across ${result.people} people.\n`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
