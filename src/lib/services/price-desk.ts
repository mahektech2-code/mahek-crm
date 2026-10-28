import "server-only";
import { eq, sql } from "drizzle-orm";
import type { db } from "@/db";
import { priceLists } from "@/db/schema";
import { requireCapability, NotPermittedError } from "@/lib/access-control";
import { canOpenModule } from "@/lib/access";

/* ---------------------------------------------------------------------------
 * THE PRICE DESK'S OWN CHECK, AND ITS ONE DELETE — in a plain module because
 * both action files and the impact report need them, and a "use server" file
 * may export nothing that is not itself an action.
 * ------------------------------------------------------------------------- */

/**
 * `pricelist.manage`, AND THE DESK IT WAS WORN AT.
 *
 * The capability rides on the APP grant — every Founder Dashboard and Accounts
 * level carries it — while the price desk inside each of those apps is a
 * MODULE that can be withheld. Asking only the capability meant a Command
 * Centre delegate given Money alone, or an Accounts clerk narrowed off the
 * Price lists screen, could still create, edit and publish a list by posting to
 * these actions, which are URLs whatever the sidebar draws. So the hat that
 * carried the capability is asked for its desk too: worn as the founder, the
 * founder's Price lists module; worn at the ledger desk, Accounts' own.
 */
export async function requirePriceDesk() {
  const ctx = await requireCapability("pricelist.manage");
  const desk =
    ctx.authorisedIn === "founder"
      ? "founder.price-lists"
      : ctx.authorisedIn === "accounts"
        ? "accounts.price-lists"
        : null;
  if (desk && !(await canOpenModule(ctx.user.id, desk))) {
    throw new NotPermittedError("pricelist.manage");
  }
  return ctx;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * A draft, gone — and nothing left pointing at it.
 *
 * Rates, slabs, scopes and discount terms go by the cascade. Three things the
 * cascade does not reach are dealt with here, inside the caller's transaction:
 *
 * A LIST DERIVED FROM IT, or a newer version drafted from it, names it through
 * a key with no `on delete`, so the delete used to fail outright with a
 * database error the moment either existed. They hold rates of their own, so
 * they keep them and lose only the pointer.
 *
 * THE DOCUMENT IT WAS READ IN FROM said "published as this list" in a text
 * column, and a document in that state can be neither published again nor
 * deleted — the PDF was stranded for good. It goes back to waiting for a
 * person, which is exactly what it was before somebody made this draft of it.
 */
export async function removeDraftList(tx: Tx, id: string): Promise<void> {
  await tx.execute(sql`
    update price_lists set parent_list_id = null, updated_at = now()
     where parent_list_id = ${id} and id <> ${id}
  `);
  await tx.execute(sql`
    update price_lists set supersedes_id = null, updated_at = now()
     where supersedes_id = ${id} and id <> ${id}
  `);
  await tx.execute(sql`
    update price_list_documents
       set parse_status = 'needs_review', price_list_id = null,
           published_at = null, published_by_id = null, updated_at = now()
     where price_list_id = ${id} and parse_status = 'published'
  `);
  await tx.delete(priceLists).where(eq(priceLists.id, id));
}
