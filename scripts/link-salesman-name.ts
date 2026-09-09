/**
 * Join a field salesman's LOGIN to the name the sheets call him by.
 *
 * `customers.sales_person_name` is free text off the party sheet — "Prakash
 * Vasudev Prasad" — and `users.sales_person_name` is the same string on the
 * account, which is the only thing that gives that person's handset a book.
 * Nothing else in MahekOne reads it, and the CRM's own lists are untouched.
 *
 * IT PROPOSES; IT DOES NOT GUESS. Every proposal is an exact fold — trim,
 * collapse the whitespace, uppercase — through `matchSalesmanName`, the same
 * decision the field-activity sync already makes about the same two sets of
 * names. A login that folds onto two different sheet names, or a sheet name
 * that folds onto two logins, is reported and skipped. Picking one at random
 * would hand somebody another salesman's customers, which is the one mistake
 * this whole column exists to avoid making silently.
 *
 *   npm run salesman:link              # what it would do, writing nothing
 *   npm run salesman:link -- --apply   # write the unambiguous ones
 *   npm run salesman:link -- --user vikram@mahek.in --name "Prakash Vasudev Prasad" --apply
 *
 * The third form is the answer to everything it refused: one person, named by
 * hand, because somebody looked at the two spellings and decided.
 */
import { eq, isNotNull, sql } from "drizzle-orm";
import { db } from "../src/db";
import { appAccess, customers, users } from "../src/db/schema";
import { matchSalesmanName } from "../src/lib/field-activity-match";
import { partyNameKey } from "../src/lib/sheet-parse";

type Args = {
  apply: boolean;
  user: string | null;
  name: string | null;
};

/**
 * An unknown flag is REFUSED rather than ignored.
 *
 * `--dry-run` was silently dropped by a job once already and the run then
 * reported the skip as though it were a fact about the data. A script whose
 * whole purpose is deciding who sees which customers is the last place to
 * repeat that.
 */
function parseArgs(argv: string[]): Args {
  const out: Args = { apply: false, user: null, name: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") {
      out.apply = true;
    } else if (a === "--user" || a === "--name") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) {
        throw new Error(`${a} needs a value.`);
      }
      if (a === "--user") out.user = value;
      else out.name = value;
    } else {
      throw new Error(`Unknown option ${a}.`);
    }
  }
  if (out.name && !out.user) throw new Error("--name needs --user to say whose name it is.");
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  /* ------------------------------------------------ naming one person by hand */
  if (args.user && args.name) {
    const [person] = await db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(sql`${users.email} = ${args.user} or ${users.id} = ${args.user}`)
      .limit(1);

    if (!person) {
      console.log(`No account matches "${args.user}".`);
      return;
    }

    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(customers)
      .where(
        sql`upper(regexp_replace(btrim(coalesce(${customers.salesPersonName}, '')), '[[:space:]]+', ' ', 'g')) = ${partyNameKey(args.name)}`,
      );

    console.log(
      `${args.apply ? "Linking" : "Would link"} ${person.name} <${person.email}> to "${args.name}" — ${n} ${n === 1 ? "shop" : "shops"}.`,
    );
    if (n === 0) {
      console.log("  Nothing carries that name. Check the spelling against the list below.");
    }
    if (args.apply) {
      await db.update(users).set({ salesPersonName: args.name }).where(eq(users.id, person.id));
      console.log("  Written.");
    } else {
      console.log("  Dry run — nothing written. Add --apply.");
    }
    return;
  }

  /* ------------------------------------------------------- proposing them all */

  /* Only people who can actually open MBOS. Everybody else has no use for the
     column, and offering to fill it in for the whole company would bury the
     handful of rows that matter. */
  const salesmen = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      active: users.active,
      linked: users.salesPersonName,
    })
    .from(users)
    .innerJoin(appAccess, eq(appAccess.userId, users.id))
    .where(eq(appAccess.app, "field"));

  if (!salesmen.length) {
    console.log("Nobody holds the Salesman App, so there is no handset to give a book to.");
    return;
  }

  /* Every distinct name the book actually carries, with how many shops each
     one is on — because the count is what tells somebody whether a proposal
     is the right person or a coincidence. */
  const sheetNames = await db
    .select({
      name: customers.salesPersonName,
      shops: sql<number>`count(*)::int`,
    })
    .from(customers)
    .where(isNotNull(customers.salesPersonName))
    .groupBy(customers.salesPersonName)
    .orderBy(sql`count(*) desc`);

  const named = sheetNames.filter((r) => (r.name ?? "").trim());

  console.log(
    `${salesmen.length} ${salesmen.length === 1 ? "account holds" : "accounts hold"} the Salesman App; the book carries ${named.length} distinct salesperson ${named.length === 1 ? "name" : "names"}.\n`,
  );

  const proposals: { id: string; name: string; sheetName: string; shops: number }[] = [];

  for (const person of salesmen) {
    const label = `${person.name} <${person.email}>${person.active ? "" : " · DISABLED"}`;

    if (person.linked) {
      const shops = named.find((r) => partyNameKey(r.name!) === partyNameKey(person.linked!))?.shops ?? 0;
      console.log(`  = ${label}\n      already linked to "${person.linked}" — ${shops} shops`);
      continue;
    }

    /* The fold runs the other way round from the field-activity sync — one
       login against many sheet names rather than one sheet name against many
       logins — so the candidates handed over are the sheet's names, and the
       "id" each carries is the name itself. */
    const decision = matchSalesmanName(
      person.name,
      named.map((r) => ({ id: r.name!, name: r.name! })),
    );

    if (decision.status === "matched" && decision.matchedId) {
      const shops = named.find((r) => r.name === decision.matchedId)?.shops ?? 0;
      proposals.push({ id: person.id, name: person.name, sheetName: decision.matchedId, shops });
      console.log(`  + ${label}\n      "${decision.matchedId}" — ${shops} shops`);
    } else if (decision.status === "ambiguous") {
      console.log(`  ? ${label}\n      ${decision.note} — skipped, name it by hand`);
    } else {
      console.log(`  · ${label}\n      no shop names them — skipped`);
    }
  }

  /*
   * AMBIGUITY HAS TWO DIRECTIONS, and `matchSalesmanName` only checks one.
   *
   * It asks whether this login folds onto exactly one sheet name. It cannot
   * ask the reverse — whether that sheet name folds onto exactly one login —
   * because it is handed one login at a time, and from each of their own
   * points of view the answer is a clean match. Two accounts genuinely called
   * "Prakash Vasudev Prasad" therefore both came back matched to the same
   * three shops, which is the exact leak this column exists not to have: two
   * handsets holding one salesman's book, and no way to tell afterwards which
   * of them was meant.
   *
   * So the proposals are checked against each other before any of them is
   * written, and a contested name takes ALL its claimants out. Naming one by
   * hand is how somebody decides, and deciding is the point.
   */
  const claimants = new Map<string, string[]>();
  for (const p of proposals) {
    const key = partyNameKey(p.sheetName);
    claimants.set(key, [...(claimants.get(key) ?? []), p.name]);
  }

  const contested = new Set(
    [...claimants.entries()].filter(([, who]) => who.length > 1).map(([key]) => key),
  );

  if (contested.size) {
    console.log();
    for (const key of contested) {
      const who = claimants.get(key)!;
      console.log(`  ! "${key}" is claimed by ${who.length} accounts: ${who.join(", ")}`);
      console.log(`      none of them linked — name the right one by hand`);
    }
  }

  const safe = proposals.filter((p) => !contested.has(partyNameKey(p.sheetName)));

  if (!safe.length) {
    console.log(`\nNothing to link automatically.`);
    console.log(
      `Name one by hand with:\n  npm run salesman:link -- --user <email> --name "<as the sheet spells it>" --apply`,
    );
    console.log(`\nThe names the book carries:`);
    for (const r of named.slice(0, 40)) console.log(`  ${String(r.shops).padStart(5)}  ${r.name}`);
    if (named.length > 40) console.log(`  … and ${named.length - 40} more`);
    return;
  }

  if (!args.apply) {
    console.log(`\nDry run — nothing written. Add --apply to write these ${safe.length}.`);
    return;
  }

  for (const p of safe) {
    await db.update(users).set({ salesPersonName: p.sheetName }).where(eq(users.id, p.id));
  }
  console.log(`\nLinked ${safe.length}.`);
  console.log(
    `Their handsets pick the book up on the next sync — no reinstall, and nothing else in MahekOne changes.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
