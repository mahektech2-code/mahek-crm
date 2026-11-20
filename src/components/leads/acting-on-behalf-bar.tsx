import { requireUser } from "@/lib/auth";
import { actingOnBehalfOf } from "@/lib/services/lead-manager-authority";

/**
 * "ACTING ON BEHALF OF" — drawn above a lead's record when its owner has left
 * and the signed-in person is working it as a manager above them on the Org
 * Chart. It says three things and nothing else: whose lead it still is, that
 * ownership has not moved, and that what is done is recorded under the actual
 * person's own name. It draws nothing for everybody else, and it is a read:
 * the page it is mounted on has already refused a lead the reader may not see.
 */
export async function ActingOnBehalfBar({ leadId }: { leadId: string }) {
  const user = await requireUser();
  const acting = await actingOnBehalfOf(leadId, user.id);
  if (!acting) return null;
  return (
    <div
      role="note"
      className="mb-3 rounded-[4px] border border-info bg-info-soft px-3 py-2 text-[13px] text-body"
      data-testid="acting-on-behalf-bar"
    >
      <b className="text-ink">Acting on behalf of {acting.ownerName}</b>, who has left the company. This lead is still
      theirs — it has not been transferred — and what you do here is recorded under your own name.
    </div>
  );
}
