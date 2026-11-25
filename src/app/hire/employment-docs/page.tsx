import { and, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { hireCourierShipments, hireEmploymentDocs } from "@/db/schema";
import { nowMs } from "@/lib/format";
import { requireHireScreen } from "@/lib/hire/access";
import { isOnboardingFlow } from "@/lib/hire/blueprint-types";
import { courierOverall } from "@/lib/hire/engines/onboarding";
import { lockedWhy } from "@/lib/hire/roles";
import { getApplication } from "@/lib/hire/services/core";
import { onboardList } from "@/lib/hire/services/onboarding";
import { currentBgv, employmentDocRows, publishedTemplate, shipments } from "@/lib/hire/services/onboarding-records";
import { currentOffer } from "@/lib/hire/services/offers";
import { BtnLink, Callout } from "../_ui/kit";
import { CandidateHead, OnboardFrame } from "../_onboard/frame";
import type { PaneRow } from "../_onboard/list-pane";
import { CourierPanel, type ShipmentView } from "./courier-panel";
import { EmpDocsPanel, type EmpDocView } from "./emp-docs-panel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Employment documents" };

const ymd = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(ms));

export default async function EmploymentDocsPage({ searchParams }: { searchParams: Promise<{ app?: string }> }) {
  const ctx = await requireHireScreen("empdocs");
  const sp = await searchParams;
  const now = nowMs();
  const today = ymd(now);
  const list = await onboardList(ctx, "empdocs");
  const ids = list.map((r) => r.id);
  const [docs, ships] = ids.length
    ? await Promise.all([
        db.select({ app: hireEmploymentDocs.applicationId, status: hireEmploymentDocs.status, hard: hireEmploymentDocs.hardCopy, preparedById: hireEmploymentDocs.preparedById }).from(hireEmploymentDocs).where(and(inArray(hireEmploymentDocs.applicationId, ids), isNull(hireEmploymentDocs.supersededById))),
        db.select({ app: hireCourierShipments.applicationId, direction: hireCourierShipments.direction, status: hireCourierShipments.status, dueOn: hireCourierShipments.dueOn }).from(hireCourierShipments).where(inArray(hireCourierShipments.applicationId, ids)),
      ])
    : [[], []];
  const rows: PaneRow[] = list.map((r) => {
    const mine = docs.filter((d) => d.app === r.id);
    const myShips = ships.filter((s) => s.app === r.id);
    const c = courierOverall(mine.some((d) => d.hard), myShips);
    const toApprove = mine.filter((d) => d.status === "prepared").length;
    const late = myShips.some((s) => s.direction === "return" && s.status !== "received" && s.dueOn != null && s.dueOn < today);
    const badge: PaneRow["badge"] = !mine.length
      ? { l: "Not prepared", tone: "neutral" }
      : c === "issue" || late
        ? { l: "Courier delay", tone: "danger" }
        : toApprove
          ? { l: `${toApprove} to approve`, tone: "warn" }
          : mine.some((d) => d.status === "sent")
            ? { l: "Signatures awaited", tone: "info" }
            : c !== "not_required" && c !== "completed"
              ? { l: c === "awaited" || c === "return_sent" ? "Signed copies awaited" : "Courier to send", tone: "warn" }
              : { l: "Complete", tone: "success" };
    return { id: r.id, name: r.name, meta: `${r.blueprintTitle} · ${r.location ?? "—"} · ${r.stageName}`, badge };
  });
  const selected = sp.app ?? rows[0]?.id ?? null;
  const b = selected ? await getApplication(ctx, selected) : null;

  let panel: React.ReactNode = null;
  if (b) {
    if (!isOnboardingFlow(b.def)) {
      panel = <Callout tone="neutral">{b.candidate.fullName}’s blueprint version ({b.blueprint.title} v{b.blueprint.version}) sends the offer letter only — its courier is tracked on Offers.</Callout>;
    } else {
      const [live, offer, bg, shipRows] = await Promise.all([employmentDocRows(b.app.id), currentOffer(b.app.id), currentBgv(b.app.id), shipments(b.app.id)]);
      const defs = b.def.employmentDocs ?? [];
      const views: EmpDocView[] = [];
      for (const d of defs) {
        const r = live.find((x) => x.docKey === d.key) ?? null;
        const t = await publishedTemplate(d.templateKey);
        views.push({
          key: d.key,
          label: d.label,
          required: d.required,
          hardCopy: d.hardCopy,
          template: r ? `v${r.templateVersion ?? "?"} as prepared` : t ? `${t.title} · v${t.version}` : "No published template",
          templateReady: Boolean(t),
          id: r?.id ?? null,
          status: r?.status ?? null,
          preparedBy: r?.preparedBy ?? null,
          preparedByMe: r?.preparedById === ctx.user.id,
          preparedAt: r?.preparedAt.toISOString() ?? null,
          approvedBy: r?.approvedBy ?? null,
          sentAt: r?.sentAt?.toISOString() ?? null,
          signedOn: r?.signedOn ?? null,
          filedAt: r?.filedAt?.toISOString() ?? null,
          signedFile: r?.signedFile ?? null,
          body: r?.body ?? null,
        });
      }
      const at = b.def.stages.findIndex((s) => s.key === b.app.stageKey);
      const emp = b.def.stages.findIndex((s) => s.type === "employment_docs");
      const reached = emp >= 0 && at >= emp;
      const open = reached && (b.app.status === "in_progress" || b.app.status === "on_hold");
      const why: string[] = [];
      if (offer?.status !== "accepted") why.push("The offer has not been accepted, so the documents have no figures to carry.");
      if (bg?.required && bg.status !== "clear" && bg.status !== "not_applicable") why.push("The background check is not clear yet.");
      if (!reached) why.push(`${b.candidate.fullName} is at ${b.stage?.name ?? "—"} — documents are prepared at Employment documents.`);
      const shipViews: ShipmentView[] = shipRows.map((s) => ({
        id: s.id,
        direction: s.direction as "outbound" | "return",
        company: s.company,
        trackingNo: s.trackingNo,
        status: s.status,
        dueOn: s.dueOn,
        docs: s.docKeys.map((k) => defs.find((d) => d.key === k)?.label ?? k),
        events: s.events.map((e) => ({ status: e.status, on: e.eventOn, remarks: e.remarks, by: e.byName })),
      }));
      panel = (
        <>
          <CandidateHead id={b.app.id} name={b.candidate.fullName} meta={`${b.candidate.code} · ${b.blueprint.title} v${b.blueprint.version} · ${b.candidate.location ?? "—"} · ${b.stage?.name ?? "Hired"}${bg?.status === "clear" ? ` · BGV clear${bg.completedOn ? ` ${bg.completedOn}` : ""}` : ""}`} />
          <div className="flex flex-col gap-4">
            {why.map((w) => (
              <Callout key={w} tone="warn">
                {w}
              </Callout>
            ))}
            <EmpDocsPanel
              key={`${b.app.id}:${views.map((v) => `${v.id}:${v.status}`).join(",")}`}
              applicationId={b.app.id}
              docs={views}
              open={open && why.length === 0}
              canEdit={ctx.can("employmentDocs")}
              editWhy={lockedWhy("employmentDocs")}
              todayYmd={today}
              summary={offer ? `${offer.gradeLabel} · basic in the letter carried from the accepted offer` : null}
            />
            <CourierPanel
              key={`${b.app.id}:${shipViews.map((s) => `${s.id}:${s.status}:${s.events.length}`).join(",")}`}
              applicationId={b.app.id}
              shipments={shipViews}
              hardCopyDocs={defs.filter((d) => d.hardCopy).map((d) => ({ key: d.key, label: d.label }))}
              canEdit={ctx.can("courier")}
              editWhy={lockedWhy("courier")}
              open={b.app.status === "in_progress" || b.app.status === "on_hold"}
              todayYmd={today}
            />
          </div>
        </>
      );
    }
  }
  return (
    <OnboardFrame
      title="Employment documents"
      sub="The offer letter, contract, roles & responsibilities, growth plan and rule-book acknowledgement — prepared from versioned templates, approved by a second person, sent, signed and filed. Hard copies are tracked as courier shipments both ways."
      listLabel={`At employment documents · ${rows.length}`}
      rows={rows}
      selected={selected}
      basePath="/hire/employment-docs"
      emptyList="Nobody is at employment documents yet — that follows documents and the background check."
    >
      {panel ? (
        <>
          {panel}
          {ctx.can("employmentDocs") ? (
            <div className="mt-4 flex justify-end">
              <BtnLink href="/hire/employment-docs/templates" size="sm" kind="ghost">
                Edit the templates
              </BtnLink>
            </div>
          ) : null}
        </>
      ) : null}
    </OnboardFrame>
  );
}
