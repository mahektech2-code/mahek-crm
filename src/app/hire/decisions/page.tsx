import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getConfig } from "@/lib/config/store";
import { requireHireScreen, scopeWhere } from "@/lib/hire/access";
import { lockedWhy } from "@/lib/hire/roles";
import { decisionQueues } from "@/lib/hire/services/decisions";
import { Empty, PageHead } from "../_ui/kit";
import { DecisionsScreen, type RecentDecision } from "./decisions-screen";

export const dynamic = "force-dynamic";
export const metadata = { title: "Decisions" };

/**
 * Decisions (design: scr.decisions). Candidates waiting at a decision gate,
 * and rejections a rule PROPOSED that need a named person — nothing is
 * rejected by the system alone.
 */
export default async function DecisionsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const ctx = await requireHireScreen("decisions");
  const { tab } = await searchParams;
  const sub = "Candidates at a decision gate, and proposed rejections that need a named person to confirm them.";
  if (!ctx.can("decide") && !ctx.can("confirmReject"))
    return (
      <>
        <PageHead title="Decisions" sub={sub} />
        <Empty title="Decisions are recorded by a Hiring Manager, HR Head or Admin">
          {lockedWhy("decide")} You are signed in as {ctx.roleLabel}; your interviews feed these decisions through the scores you confirm.
        </Empty>
      </>
    );
  const { gates, proposals } = await decisionQueues(ctx);
  const recent = (await db.execute(sql`
    select d.id, d.application_id, d.decision, d.reasoning, d.decision_point, d.decided_at, d.decided_by_role, d.agreed_with_ai,
           c.full_name, b.title, u.name as by_name
    from hire_decisions d
    join hire_applications a on a.id = d.application_id
    join hire_candidates c on c.id = a.candidate_id
    join hire_blueprints b on b.id = a.blueprint_id
    join users u on u.id = d.decided_by_id
    where ${scopeWhere(ctx)} and d.superseded_by_id is null
    order by d.decided_at desc limit 50
  `)) as unknown as Record<string, unknown>[];
  const recentRows: RecentDecision[] = recent.map((r) => ({
    id: String(r.id),
    applicationId: String(r.application_id),
    name: String(r.full_name),
    roleTitle: String(r.title),
    decision: String(r.decision),
    reasoning: String(r.reasoning),
    point: String(r.decision_point),
    at: new Date(r.decided_at as string).toISOString(),
    by: `${r.by_name} · ${r.decided_by_role}`,
    agreed: (r.agreed_with_ai as boolean | null) ?? null,
  }));
  const languages = (await getConfig())["hire.languages"].split(",").map((l) => l.trim()).filter(Boolean);
  const initial = tab === "reject" ? "reject" : tab === "recent" ? "recent" : "gate";
  return (
    <>
      <PageHead title="Decisions" sub={sub} />
      <DecisionsScreen
        initialTab={initial}
        gates={gates}
        proposals={proposals}
        recent={recentRows}
        languages={languages}
        canDecide={ctx.can("decide")}
        canConfirm={ctx.can("confirmReject")}
        decideWhy={lockedWhy("decide")}
        confirmWhy={lockedWhy("confirmReject")}
      />
    </>
  );
}
