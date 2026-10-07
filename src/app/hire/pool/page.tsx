import { nowMs } from "@/lib/format";
import { requireHireScreen } from "@/lib/hire/access";
import { lockedWhy } from "@/lib/hire/roles";
import { openRoles, silverMedallists } from "@/lib/hire/services/talent";
import { Empty, fd, PageHead, Pill, Quote } from "../_ui/kit";
import { Picks } from "../insights/_ui/picks";
import { TalentActions } from "./talent-actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Pool" };

export default async function PoolPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requireHireScreen("pool");
  const sp = await searchParams;
  const now = nowMs();
  const roles = await openRoles();
  const role = roles.find((r) => r.key === sp.role) ?? roles[0];
  const head = <PageHead title="Pool" sub="Strong past candidates who were not hired, matched to roles that are open now." />;
  if (!role) return <>{head}<Empty title="No role is open">The pool matches past candidates to published roles. Publish a blueprint and it fills in.</Empty></>;
  const rows = await silverMedallists(ctx, role, now);
  const canAct = ctx.can("addCandidate");
  const page = Math.max(0, Number(sp.page ?? 0) || 0);
  const shown = rows.slice(page * 20, page * 20 + 20);

  return (
    <>
      {head}
      <Picks picks={[{ k: "role", label: "Open role", value: role.key, opts: roles.map((r) => ({ v: r.key, l: `${r.title} · v${r.version} · ${r.open} in the pipeline` })) }]} />
      <p className="mt-0 mb-4 text-[13px] text-muted">
        {rows.length ? `${rows.length} past candidate${rows.length === 1 ? "" : "s"} for ${role.title}` : `Nobody in the pool for ${role.title} yet`} — averaging 75 or more across their scored stages, or marked a silver medallist. Anybody who asked not to be contacted, or whose record is past its retention period, is not shown.
      </p>
      {rows.length === 0 ? (
        <Empty title="No strong past candidates for this role">As candidates finish a pipeline without being hired, the strongest appear here when a matching role opens.</Empty>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          {shown.map((r) => (
            <div key={r.candidateId} className="overflow-hidden rounded-[6px] border border-line bg-surface">
              <div className="flex items-center gap-2.5 border-b border-divider px-5 py-3.5">
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="text-[15px] font-semibold text-heading">{r.name}</span>
                    {r.poolStatus === "silver_medallist" ? <Pill tone="brand">Silver medallist</Pill> : null}
                  </span>
                  <span className="block text-xs text-muted">
                    {r.code} · {r.bpTitle} v{r.version} · {r.location ?? "No location"} · applied {fd(r.appliedAt)}
                  </span>
                </span>
                <span className="text-[22px] font-semibold text-heading tabular-nums" title="Average of their confirmed stage scores">
                  {r.overall ?? "—"}
                </span>
              </div>
              <div className="flex flex-col gap-2.5 px-5 py-3.5">
                <div className="rounded-[4px] bg-canvas px-3 py-2.5 text-[13px] leading-[19px] text-body">
                  <span className="font-semibold text-heading">Why they match:</span> {r.match}
                </div>
                <div className="text-[13px] leading-[19px] text-body">
                  <span className="font-semibold text-heading">Why they were not hired:</span> {r.notHired}
                </div>
                {r.quote ? <Quote caption={r.quote.source}>{r.quote.text}</Quote> : null}
                <TalentActions
                  candidateId={r.candidateId}
                  name={r.name}
                  roles={roles.map((x) => ({ key: x.key, title: x.title }))}
                  defaultRole={role.key}
                  silver={r.poolStatus === "silver_medallist"}
                  canAct={canAct}
                  why={lockedWhy("addCandidate")}
                  skipRole={{ key: role.key, title: role.title }}
                  recordHref={`/hire/c/${r.applicationId}`}
                />
              </div>
            </div>
          ))}
        </div>
      )}
      {rows.length > 20 ? (
        <div className="mt-4 flex items-center gap-3 text-[13px] text-muted">
          <span>
            {page * 20 + 1}–{Math.min(rows.length, page * 20 + 20)} of {rows.length}
          </span>
          <span className="flex-1" />
          {page > 0 ? <a href={`?role=${role.key}&page=${page - 1}`}>Previous</a> : null}
          {(page + 1) * 20 < rows.length ? <a href={`?role=${role.key}&page=${page + 1}`}>Next</a> : null}
        </div>
      ) : null}
    </>
  );
}
