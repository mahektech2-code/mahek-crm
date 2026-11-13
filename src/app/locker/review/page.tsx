import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import { modulesForApp } from "@/lib/modules";
import { quarterOf } from "@/lib/locker/ops-core";
import { reviewView } from "@/lib/locker/vault-service";
import { PageHead } from "../_ui/kit";
import { ReviewScreen } from "./review-screen";

export const metadata = { title: "Access review" };

export default async function ReviewPage({ searchParams }: { searchParams: Promise<{ p?: string }> }) {
  const user = await requireUser();
  await requireModule(user.id, "locker.review");
  const { p } = await searchParams;
  const period = p && /^\d{4}-Q[1-4]$/.test(p) ? p : quarterOf(new Date());
  const items = await reviewView(period);
  const labels = Object.fromEntries(modulesForApp("locker").map((m) => [m.key, `${m.group} › ${m.label}`]));
  return (
    <>
      <PageHead crumb="Locker · Operations" title={`Access review · ${period.replace("-", " ")}`} sub="Each grant of the Locker is confirmed or removed by a named reviewer. Removing takes the access away there and then. Anything not confirmed when the quarter closes is flagged." />
      <ReviewScreen period={period} me={user.id} labels={labels} items={items.map((i) => ({ id: i.id, userId: i.userId, name: i.name, moduleKey: i.moduleKey, decision: i.decision, decidedBy: i.decidedBy }))} />
    </>
  );
}
