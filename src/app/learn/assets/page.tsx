import { requireUser } from "@/lib/auth";
import { APP_TIMEZONE } from "@/lib/business-date";
import { myAssets } from "@/lib/hire/services/onboarding-records";
import { Empty } from "../ui";
import { AssetList } from "./asset-list";

export const dynamic = "force-dynamic";
export const metadata = { title: "Assets" };

/** PRD §11 — what the company issued to this person, and their own acknowledgement of it. */
export default async function AssetsPage() {
  const user = await requireUser();
  const rows = await myAssets(user.id);
  const items = rows.map(({ a, by }) => ({
    id: a.id,
    label: a.label,
    serial: a.serial,
    issuedOn: a.issuedOn,
    by,
    acknowledgedOn: a.acknowledgedAt ? new Intl.DateTimeFormat("en-CA", { timeZone: APP_TIMEZONE }).format(a.acknowledgedAt) : null,
    problem: a.problem,
  }));
  return (
    <div className="flex flex-col gap-3">
      <h1 className="m-0 text-[18px] font-semibold text-heading">What the company gave you</h1>
      {items.length ? (
        <>
          <p className="m-0 text-[13px] leading-[19px] text-body">
            Tap <b>I have it</b> for each thing you received. If something is wrong or missing, tell us instead — don’t acknowledge it.
          </p>
          <AssetList items={items} />
        </>
      ) : (
        <Empty title="Nothing issued to you yet">When HR issues your SIM, ID card or order book it appears here for you to confirm.</Empty>
      )}
    </div>
  );
}
