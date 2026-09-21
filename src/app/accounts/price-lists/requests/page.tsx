/* ---------------------------------------------------------------------------
 * WHO HAS ASKED FOR A DIFFERENT PRICE — the Sales Dashboard's door onto one table.
 *
 * Both apps render the SAME panel over the same read, because a request
 * waiting in one app and missing from the other is how one sits undecided for
 * a week. What differs is the shell around it and whether a customer's name is
 * a link — the Sales Dashboard has no customer record page to link to.
 * ------------------------------------------------------------------------- */
import { requireUser } from "@/lib/auth";
import { canFor } from "@/lib/access-control";
import { today } from "@/lib/recompute";
import { listRequests } from "@/lib/services/price-list-service";
import { PageHeader } from "@/components/ui/primitives";
import { PricingSubNav } from "@/components/pricing/sub-nav";
import { RequestsPanel } from "@/components/pricing/requests-panel";

export const metadata = { title: "Special price requests — Accounts — MahekOne" };

export default async function Page() {
  const user = await requireUser();
  const [canManage, day, requests] = await Promise.all([
    canFor(user, "pricelist.manage"),
    today(),
    listRequests(),
  ]);

  return (
    <div className="p-6">
      <PageHeader
        title="Special price requests"
        subtitle="What a shop has asked to pay, what they pay today, and what was decided."
      />
      <PricingSubNav basePath="/accounts/price-lists" current="requests" />
      <RequestsPanel
        app="accounts"
        basePath="/accounts/price-lists"
        canManage={canManage}
        currentUserId={user.id}
        requests={requests}
        todayIso={day}
      />
    </div>
  );
}
