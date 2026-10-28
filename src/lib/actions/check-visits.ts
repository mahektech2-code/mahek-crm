"use server";

import { requireUser } from "@/lib/auth";
import { err, fromThrown, ok, type Result } from "@/lib/result";
import { reportingSalesmen, teamVisits, visitRange, type TeamVisit } from "@/lib/services/visit-oversight-service";

/* The one door Check Visits has. The button is drawn for everyone on the lead
   page, so the permission is HERE and nowhere else: the Org Chart is asked on
   every request, and whoever has nobody reporting to them - a salesman
   included - gets an empty answer with no visits in it and nothing about who
   else exists. Dates and page are validated and bounded by the service. */

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
    const now = new Date();
    if (!team.length) {
      const range = visitRange(input, now);
      if (!range.ok) return err(range.error, "validation");
      return ok({ visits: [], team: [], more: false, fromDay: range.fromDay, toDay: range.toDay });
    }
    const r = await teamVisits(user, { ...input, now });
    if (r === null) return err("Check Visits could not be read.", "not_permitted");
    if ("error" in r) return err(r.error, "validation");
    return ok({ ...r, team });
  } catch (e) {
    return fromThrown(e);
  }
}
