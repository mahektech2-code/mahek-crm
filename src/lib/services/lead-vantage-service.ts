import "server-only";
import { canAny, hatsFor } from "@/lib/access-control";
import type { VantageViewer } from "@/lib/lead-vantage";

/* ---------------------------------------------------------------------------
 * The four booleans `vantagesFor` takes, read ONCE off the person's hats.
 *
 * It is a read, so it lives in a service — but the reason it is its OWN file
 * rather than a function in `lead-console-service.ts` is the one that file
 * gives for existing at all: a desk asks list questions, and this asks nothing
 * about leads whatever. It is a fact about the VIEWER, asked once per page and
 * then applied to four hundred rows in the browser, which is what keeps §7 off
 * the per-row query budget entirely.
 *
 * `hatsFor` is memoized per request and keyed on the ids, so asking it here
 * costs nothing on a page that has already asked it — which every leads screen
 * has, through `requireModule`.
 *
 * WHAT COMES BACK DECIDES WORDS AND NOTHING ELSE. `canAny` is being asked what
 * somebody IS, not whether they may act: the capability is the most honest
 * available statement of "this person is who §2 calls management", because
 * this product has no such role. Every write goes on asking
 * `requireCapability` for itself.
 * ------------------------------------------------------------------------- */
export async function vantageViewer(user: { id: string; role: string }): Promise<VantageViewer> {
  const hats = await hatsFor(user);

  return {
    id: user.id,
    /* The GRANT and not the level. A field salesman is an associate and so is
       a telecaller; what separates them is which app they were given, which is
       AGENTS.md's own "a role is a level, the app is the job". */
    holdsField: hats.some((h) => h.app === "field"),
    canApproveDistributors: canAny(hats, "distributor.approve"),
    /* Manager on either app that carries a lead book. An Accounts manager is
       deliberately not one of these: the ledger desk holds no lead and reading
       their level as a sales manager's would put a verb about somebody else's
       negotiation in front of them. */
    isSalesManager: hats.some(
      (h) => (h.app === "crm" || h.app === "sales") && (h.role === "manager" || h.role === "admin"),
    ),
    holdsCrm: hats.some((h) => h.app === "crm"),
  };
}
