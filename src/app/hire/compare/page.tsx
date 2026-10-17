import { requireHireScreen, seesScores } from "@/lib/hire/access";
import { aiState } from "@/lib/hire/ai/orchestrator";
import { compareColumns, compareOptions } from "@/lib/hire/services/decisions";
import { Empty, PageHead } from "../_ui/kit";
import { CompareScreen, type CmpColumn } from "./compare-screen";

export const dynamic = "force-dynamic";
export const metadata = { title: "Compare" };

/**
 * Compare (design brief §7.6): up to four candidates for the SAME blueprint
 * version, competency by competency — and what each of them SAID, because
 * comparing numbers is not the point.
 */
export default async function ComparePage({ searchParams }: { searchParams: Promise<{ ids?: string }> }) {
  const ctx = await requireHireScreen("compare");
  const sub = "Up to four candidates for the same role, competency by competency, with what each of them said.";
  if (!seesScores(ctx))
    return (
      <>
        <PageHead title="Compare" sub={sub} />
        <Empty title="Comparisons show every stage’s scores">Interviewers do not see earlier scores — it would colour the interview they are about to run.</Empty>
      </>
    );
  const { ids } = await searchParams;
  const options = await compareOptions(ctx);
  let chosen = (ids ?? "").split(",").filter(Boolean).slice(0, 4);
  if (!chosen.length) {
    /* Nothing picked: the people waiting at the same gate are the natural comparison. */
    const atGate = options.filter((o) => /decision gate/i.test(o.stageName));
    const bp = atGate[0]?.blueprintId ?? options[0]?.blueprintId;
    chosen = (atGate.length >= 2 ? atGate : options).filter((o) => o.blueprintId === bp).slice(0, 3).map((o) => o.id);
  }
  const { columns, def, blueprintId, roleTitle, mixed } = await compareColumns(ctx, chosen);
  const ai = await aiState();
  const cols: CmpColumn[] = columns.map((c) => ({ id: c.id, name: c.name, code: c.code, meta: c.meta, overall: c.cf.overall, scores: c.cf.competencies, quotes: c.cf.quotes }));
  return (
    <>
      <PageHead title="Compare" sub={sub} />
      <CompareScreen
        key={cols.map((c) => c.id).join(",")}
        roleTitle={roleTitle}
        blueprintId={blueprintId}
        competencies={(def?.competencies ?? []).map((c) => ({ key: c.key, name: c.name, weight: c.weight }))}
        columns={cols}
        options={options}
        mixed={mixed}
        aiDown={ai.on ? null : ai.reason}
      />
    </>
  );
}
