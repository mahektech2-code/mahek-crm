import { priceListDoorCanManage } from "@/lib/price-list-door";
/* ---------------------------------------------------------------------------
 * WHO HAS ASKED FOR A DIFFERENT PRICE — the CRM's door onto one table.
 *
 * Both apps render the SAME panel over the same read, because a request
 * waiting in one app and missing from the other is how one sits undecided for
 * a week. What differs is the shell around it and whether a customer's name is
 * a link — the Sales Dashboard has no customer record page to link to.
 * ------------------------------------------------------------------------- */
import { requireUser } from "@/lib/auth";
import { today } from "@/lib/recompute";
import { listRequests } from "@/lib/services/price-list-service";
import { PageHeader } from "@/components/ui/primitives";
import { PricingSubNav } from "@/components/pricing/sub-nav";
import { RequestsPanel } from "@/components/pricing/requests-panel";

export const metadata = { title: "Special price requests - MahekOne CRM" };

export default async function Page() {
  const user = await requireUser();
  const [canManage, day, requests] = await Promise.all([
    priceListDoorCanManage(user, "crm"),
    today(),
    listRequests(),
  ]);

  return (
    <>
      <PageHeader
        title="Special price requests"
        subtitle="What a shop has asked to pay, what they pay today, and what was decided."
      />
      <PricingSubNav basePath="/crm/price-lists" current="requests" />
      <RequestsPanel
        app="crm"
        basePath="/crm/price-lists"
        canManage={canManage}
        currentUserId={user.id}
        requests={requests}
        todayIso={day}
      />
    </>
  );
}
