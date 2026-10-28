"use server";

import { requireUser } from "@/lib/auth";
import { err, fromThrown, ok, type Result } from "@/lib/result";
import { reportingSalesmen, teamVisits, type TeamVisit } from "@/lib/services/visit-oversight-service";

/* The one door Check Visits has. It asks the Org Chart again on the server —
   the button being drawn is a convenience, never the permission. A salesman,
   or anybody nobody reports to, gets the same plain refusal; nothing about who
   else exists. Dates and page are validated and bounded by the service. */

const REFUSAL = "Check Visits is for the people salesmen report to.";

export async function checkVisitsAction(input: {
  customerId?: string;
  salesmanId?: string;
  from?: string;
  to?: string;
  page?: number;
}): Promise<
  Result<{ visits: TeamVisit[]; team: { id: string; name: string }[]; more: boolean; fromDay: string; toDay: string }>
> {
  try {
    const user = await requireUser();
    const team = await reportingSalesmen(user);
    if (!team.length) return err(REFUSAL, "not_permitted");
    const r = await teamVisits(user, { ...input, now: new Date() });
    if (r === null) return err(REFUSAL, "not_permitted");
    if ("error" in r) return err(r.error, "validation");
    return ok({ ...r, team });
  } catch (e) {
    return fromThrown(e);
  }
}
