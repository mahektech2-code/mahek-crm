import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { canAny, hatsFor } from "@/lib/access-control";
import {
  approverFor,
  fieldRouteFor,
  holdsLeadSeat,
  telecallerRouteFor,
} from "@/lib/services/lead-verifier";
import { orgChartVerifierFor, orgFallbackWords } from "@/lib/services/org-verifier-resolver";
import { leadManagerCandidatesFor, type LeadRow } from "@/lib/services/lead-service";

/* ---------------------------------------------------------------------------
 * WHO VERIFIES A LEAD THAT IS BECOMING A PROSPECT — one answer for every door.
 *
 * It used to live inside the Calling desk's `preparePromotion`, so a lead made
 * a Prospect any other way (the stage button on the record, the board, a bulk
 * move, the handset) became one with nobody told to verify it: the verifier
 * the Org Chart names could still verify, but the next action stayed with
 * whoever moved it and no bell rang. Now `preparePromotion` and the stage move
 * (`applyLeadStageMove`) both ask this.
 *
 * The order is unchanged from `preparePromotion`: a Salesman's lead to the
 * field verifier, then the Org Chart above whoever is asking, then the
 * fallbacks (the self-raised approver, the Telecaller verifier, the Sales
 * Manager seat, the lead-manager seat, the desk verifier, the region's
 * default). The requester is never the verifier.
 * ------------------------------------------------------------------------- */

export type ProspectVerifier =
  | {
      ok: true;
      managerId: string;
      /** Set where the Org Chart could not name a verifier and the settings were used instead. */
      fallbackNote: string | null;
    }
  | { ok: false; message: string };

export async function resolveProspectVerifier(
  lead: Pick<
    LeadRow,
    "id" | "ownerId" | "salesManagerId" | "salesManagerDecidedAt" | "leadManagerId" | "leadManagerDecidedAt"
  >,
  requesterId: string,
): Promise<ProspectVerifier> {
  /* A LEAD A SALESMAN RAISED OR NOW HOLDS IS ASKED FIRST, BEFORE THE CHART. */
  const fieldFirst = await fieldRouteFor({ id: lead.id, ownerId: lead.ownerId }, requesterId);
  const salesmanFirst =
    fieldFirst.kind === "verifier" && (fieldFirst.reason === "assigned" || fieldFirst.reason === "salesman_created");

  /* THE ORG CHART IS ASKED NEXT, starting from whoever is making this request. */
  const orgPick = salesmanFirst ? null : await orgChartVerifierFor(requesterId);
  let managerId: string | null = salesmanFirst ? fieldFirst.id : orgPick?.ok ? orgPick.id : null;
  const fallbackNote =
    salesmanFirst || orgPick?.ok || !orgPick
      ? null
      : `Routed through Settings, not the Org Chart: ${orgFallbackWords(orgPick.reason)}.`;
  const fieldRoute = managerId && !salesmanFirst ? ({ kind: "off" } as typeof fieldFirst) : fieldFirst;
  if (fieldRoute.kind === "refuse") return { ok: false, message: fieldRoute.message };
  if (fieldRoute.kind === "verifier") managerId = fieldRoute.id;

  /* A LEAD THE SALES MANAGER RAISED HERSELF IS VERIFIED BY THE PERSON MAHEK DESIGNATES. */
  const selfRaisedApprover = managerId
    ? null
    : await approverFor({ ownerId: lead.ownerId, salesManagerId: lead.salesManagerId });
  if (selfRaisedApprover) managerId = selfRaisedApprover.id;

  /* A LEAD A TELECALLER WORKS is verified by the person designated for that. */
  if (!managerId) {
    const route = await telecallerRouteFor(
      {
        ownerId: lead.ownerId,
        salesManagerDecidedAt: lead.salesManagerDecidedAt,
        leadManagerDecidedAt: lead.leadManagerDecidedAt,
      },
      requesterId,
    );
    if (route.kind === "refuse") return { ok: false, message: route.message };
    if (route.kind === "verifier") managerId = route.id;
  }
  if (!managerId && lead.salesManagerId) {
    const [sm] = await db
      .select({ id: users.id, role: users.role, active: users.active })
      .from(users)
      .where(eq(users.id, lead.salesManagerId))
      .limit(1);
    if (
      sm?.active &&
      ((await holdsLeadSeat(sm, lead.salesManagerId)) ||
        canAny(await hatsFor({ id: sm.id, role: sm.role }), "lead.verify"))
    ) {
      managerId = sm.id;
    }
  }
  if (!managerId && lead.leadManagerId) {
    const decided = Boolean(lead.leadManagerDecidedAt);
    const [seatHolder] = await db
      .select({ id: users.id, role: users.role, active: users.active })
      .from(users)
      .where(eq(users.id, lead.leadManagerId))
      .limit(1);
    if (
      seatHolder?.active &&
      (decided || canAny(await hatsFor({ id: seatHolder.id, role: seatHolder.role }), "lead.verify"))
    ) {
      managerId = seatHolder.id;
    }
  }
  /* NOTHING ABOVE ANSWERED and nobody can say who raised the lead: the desk verifier. */
  if (!managerId && fieldRoute.kind === "fallback") managerId = fieldRoute.id;
  if (!managerId) {
    const candidates = await leadManagerCandidatesFor(lead.id);
    managerId = candidates[0]?.id ?? null;
  }
  if (!managerId) {
    return { ok: false, message: "No Sales Manager covers this lead's region. Ask an administrator." };
  }
  /* THE REQUESTER IS NEVER THE VERIFIER. */
  if (managerId === requesterId) {
    return {
      ok: false,
      message:
        "Nobody can verify this but you, and nobody verifies their own request. Ask HR to link you to your manager in HRMS, or an administrator to name another verifier in Settings.",
    };
  }
  return { ok: true, managerId, fallbackNote };
}
