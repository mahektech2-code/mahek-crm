import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import type { AppId } from "@/lib/apps";

/* ---------------------------------------------------------------------------
 * The one number the LAUNCHER needs, in a file that imports no access rule.
 *
 * `lib/access.ts` draws the Website Enquiries tile's badge, and
 * `enquiry-service.ts` asks `listUserApps` — from `lib/access.ts` — before it
 * answers anything. Read the badge out of the service and those two files
 * import each other: it runs today only because both bindings are hoisted
 * function declarations, and it breaks the day somebody rewrites either as a
 * `const` arrow. It also drags the whole service — and, through access.ts,
 * receipts, credit notes, employees and sales — into the public ingestion
 * route's module graph, which needs none of it.
 *
 * So the count lives here, one query with no opinion about who is asking. The
 * launcher has ALREADY established that: it is iterating the apps this person
 * holds, and a badge on a tile that is being drawn for them is not a second
 * place to decide whether they may see it. The workspace is passed IN rather
 * than named again here, so this file carries no second copy of the literal
 * `enquiry-service.ts` owns (and `enquiry-labels.test.ts` pins).
 * ------------------------------------------------------------------------- */

/**
 * Enquiries in this workspace that nobody has picked up — the launcher badge.
 * Counted in Postgres, served by `enquiries_unassigned_idx`, which is the
 * partial index migration 0135 created for exactly this question.
 */
export async function unassignedEnquiryCount(workspace: AppId): Promise<number> {
  const rows = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from enquiries where workspace = ${workspace} and assigned_to_id is null`,
  );
  return Number(rows[0]?.n ?? 0);
}
