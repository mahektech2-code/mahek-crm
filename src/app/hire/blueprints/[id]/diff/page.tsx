import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireHireScreen } from "@/lib/hire/access";
import { diffBlueprints } from "@/lib/hire/engines/diff";
import { getBlueprintRow, inFlightOn, previousVersion } from "@/lib/hire/services/blueprints";
import { Callout, Empty, PageHead, Pill } from "../../../_ui/kit";

export const metadata: Metadata = { title: "What changed" };
export const dynamic = "force-dynamic";

export default async function DiffPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireHireScreen("blueprints");
  const b = await getBlueprintRow(id);
  if (!b) notFound();
  const prev = await previousVersion(b);
  if (!prev) {
    return (
      <>
        <PageHead back={{ href: `/hire/blueprints/${b.id}`, label: `${b.title} v${b.version}` }} title={`${b.title} · v${b.version}`} />
        <Empty title="This is the first version">There is nothing earlier to compare it with.</Empty>
      </>
    );
  }
  const [rows, flight] = [diffBlueprints(prev.definition, b.definition), await inFlightOn(prev.id)];
  return (
    <>
      <PageHead
        back={{ href: `/hire/blueprints/${b.id}`, label: `${b.title} v${b.version}` }}
        title={`${b.title} · v${prev.version} → v${b.version}`}
        sub="What changed between versions. Candidates stay on the version they entered under, for their whole journey."
      />
      <Callout className="mb-4">
        {flight ? (
          <>
            <span className="font-medium tabular-nums">{flight}</span> candidate{flight === 1 ? " is" : "s are"} still in flight on{" "}
            <Link href={`/hire/blueprints/${prev.id}`}>v{prev.version}</Link>. Publishing v{b.version} does not rescore or move any of them.
          </>
        ) : (
          <>Nobody is in flight on v{prev.version}.</>
        )}
      </Callout>
      {rows.length ? (
        <div className="overflow-hidden rounded-[6px] border border-line bg-surface">
          <div className="grid grid-cols-[220px_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.9fr)] gap-4 border-b border-divider px-5 py-2.5 text-xs font-medium tracking-[0.04em] text-muted uppercase">
            <span>Where</span>
            <span>v{prev.version}</span>
            <span>v{b.version}</span>
            <span>Why</span>
          </div>
          {rows.map((r, i) => (
            <div key={i} className="grid grid-cols-[220px_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.9fr)] gap-4 border-b border-divider px-5 py-3 text-sm last:border-0">
              <span className="font-medium text-heading">
                {r.where}
                <span className="ml-1.5 align-middle">
                  <Pill tone={r.kind === "added" ? "success" : r.kind === "removed" ? "muted" : "neutral"}>{r.kind}</Pill>
                </span>
              </span>
              <span className={r.kind === "added" ? "text-faint" : "text-body"}>{r.a}</span>
              <span className={r.kind === "removed" ? "text-faint" : "text-heading"}>{r.b}</span>
              <span className="text-[13px] text-muted">{r.note ?? ""}</span>
            </div>
          ))}
        </div>
      ) : (
        <Empty title="No structural change">The two versions score candidates identically.</Empty>
      )}
    </>
  );
}
