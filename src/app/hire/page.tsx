import { requireHireScreen } from "@/lib/hire/access";
import { boardRows } from "@/lib/hire/services/pipeline";
import { PageHead } from "./_ui/kit";

export const dynamic = "force-dynamic";

export default async function HireBoardPage() {
  const ctx = await requireHireScreen("board");
  const rows = await boardRows(ctx);
  return <PageHead title="Board" sub={`${rows.length} candidates in your scope.`} />;
}
