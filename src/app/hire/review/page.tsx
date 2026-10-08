import Link from "next/link";
import { requireHireScreen } from "@/lib/hire/access";
import { reviewQueue, type ReviewRow } from "@/lib/hire/services/scoring";
import { BtnLink, Empty, fdt, hs, Label, PageHead, Panel } from "../_ui/kit";

export const dynamic = "force-dynamic";
export const metadata = { title: "To review" };

/** AI scores waiting for a person, oldest first. Nothing counts until someone acts. */
export default async function ReviewPage() {
  const ctx = await requireHireScreen("review");
  const { waiting, manual } = await reviewQueue(ctx);
  const total = waiting.reduce((n, r) => n + r.pending, 0);
  return (
    <>
      <PageHead
        title="To review"
        sub={`AI scores waiting for a person to confirm, adjust or replace them. Nothing counts until someone does. ${total ? `${total} score${total === 1 ? "" : "s"} across ${waiting.length} interview${waiting.length === 1 ? "" : "s"}.` : ""}`}
      />
      {waiting.length ? (
        <Table rows={waiting} kind="waiting" />
      ) : (
        <Empty title="Nothing waiting">Every AI score in your scope has been confirmed by a person.</Empty>
      )}
      {manual.length ? (
        <div className="mt-8">
          <Panel title="Scored by hand while AI was unavailable" sub="These stages were completed manually. Their results stand; the AI can now give a second reading for calibration." pad={false}>
            <Table rows={manual} kind="manual" />
          </Panel>
        </div>
      ) : null}
    </>
  );
}

function Table({ rows, kind }: { rows: ReviewRow[]; kind: "waiting" | "manual" }) {
  return (
    <div className="overflow-hidden rounded-[6px] border border-line bg-surface">
      <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)_140px_120px_110px] items-center gap-3 border-b border-divider bg-page px-4 py-2">
        <Label>Candidate</Label>
        <Label>Stage</Label>
        <Label>{kind === "waiting" ? "Waiting" : "Questions"}</Label>
        <Label>{kind === "waiting" ? "Oldest" : "Completed"}</Label>
        <span />
      </div>
      {rows.map((r) => (
        <div key={r.execId} className="hire-row grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)_140px_120px_110px] items-center gap-3 border-b border-canvas px-4 text-sm last:border-b-0 hover:bg-page">
          <span className="min-w-0">
            <Link href={`/hire/c/${r.applicationId}`} className="block truncate font-medium text-heading no-underline hover:underline">
              {r.name}
            </Link>
            <span className="block truncate text-xs text-muted">
              {r.code} · {r.role}
              {r.location ? ` · ${r.location}` : ""}
            </span>
          </span>
          <span className="truncate text-body">{r.stageName}</span>
          <span className="tabular-nums text-body">{kind === "waiting" ? `◈ ${r.pending} of ${r.total}` : `${r.total}`}</span>
          <span className={kind === "waiting" && r.hours > 24 ? "font-medium text-danger" : "text-muted"} title={fdt(r.oldest)}>
            {kind === "waiting" ? hs(r.hours) : fdt(r.oldest)}
          </span>
          <span className="text-right">
            <BtnLink href={`/hire/scoring/${r.execId}`} kind={kind === "waiting" ? "primary" : "secondary"} size="sm">
              {kind === "waiting" ? "Review" : "Open"}
            </BtnLink>
          </span>
        </div>
      ))}
    </div>
  );
}
