import { and, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { hireOffers } from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { requireHireScreen } from "@/lib/hire/access";
import { isOnboardingFlow } from "@/lib/hire/blueprint-types";
import { lockedWhy } from "@/lib/hire/roles";
import { getApplication, loadBlueprint } from "@/lib/hire/services/core";
import { onboardList } from "@/lib/hire/services/onboarding";
import { plansForRole, slabLines } from "@/lib/hire/services/onboarding-records";
import { approverName, compensationHistory, courierArrived, currentOffer, offerHistory } from "@/lib/hire/services/offers";
import { CandidateHead, OnboardFrame } from "../_onboard/frame";
import type { PaneRow } from "../_onboard/list-pane";
import type { Tone } from "../_ui/kit";
import { OfferPanel } from "./offer-panel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Offers" };

const BADGE: Record<string, [string, Tone]> = {
  none: ["No offer", "warn"],
  draft: ["Draft", "neutral"],
  issued: ["Issued", "info"],
  accepted: ["Accepted", "success"],
  declined: ["Declined", "muted"],
  withdrawn: ["Withdrawn", "muted"],
};

export default async function OffersPage({ searchParams }: { searchParams: Promise<{ app?: string }> }) {
  const ctx = await requireHireScreen("offers");
  const sp = await searchParams;
  const list = await onboardList(ctx, "offers");
  const offers = list.length
    ? await db.select({ app: hireOffers.applicationId, status: hireOffers.status, courier: hireOffers.courierStatus, approval: hireOffers.approvalStatus }).from(hireOffers).where(and(inArray(hireOffers.applicationId, list.map((r) => r.id)), isNull(hireOffers.supersededById)))
    : [];
  const flowIds = new Set<string>();
  for (const id of new Set(list.map((r) => r.blueprintId))) {
    const bp = await loadBlueprint(id);
    if (bp && isOnboardingFlow(bp.definition)) flowIds.add(id);
  }
  const rows: PaneRow[] = list.map((r) => {
    const o = offers.find((x) => x.app === r.id);
    const [l, tone] = BADGE[o?.status ?? "none"];
    /* Only the old flow tracks the courier on the offer; the new one has Employment docs. */
    const oldFlow = !flowIds.has(r.blueprintId);
    const badge: PaneRow["badge"] =
      o?.status === "draft" && o.approval === "pending"
        ? { l: "Approval pending", tone: "warn" }
        : o?.status === "draft" && o.approval === "refused"
          ? { l: "Refused — revise", tone: "danger" }
          : o?.status === "accepted" && oldFlow && !courierArrived({ courierStatus: o.courier })
            ? { l: "Courier due", tone: "warn" }
            : { l, tone };
    return { id: r.id, name: r.name, meta: `${r.blueprintTitle} · ${r.location ?? "—"} · ${r.stageName}`, badge };
  });
  const selected = sp.app ?? rows[0]?.id ?? null;
  const b = selected ? await getApplication(ctx, selected) : null;

  let panel: React.ReactNode = null;
  if (b) {
    const flow = isOnboardingFlow(b.def);
    const [offer, history, compHistory, planRows, cfg] = await Promise.all([currentOffer(b.app.id), offerHistory(b.app.id), flow ? compensationHistory(b.app.id) : Promise.resolve([]), flow ? plansForRole(b.def) : Promise.resolve([]), getConfig()]);
    const [approvedByName, requestedByName] = await Promise.all([approverName(offer?.approvedById), approverName(offer?.approvalRequestedById)]);
    const offerStage = b.def.stages.findIndex((s) => s.type === (flow ? "compensation" : "document_collection"));
    panel = (
      <>
        <CandidateHead id={b.app.id} name={b.candidate.fullName} meta={`${b.candidate.code} · ${b.blueprint.title} v${b.blueprint.version} · ${b.candidate.location ?? "—"} · ${b.stage?.name ?? "Hired"}`} />
        <OfferPanel
          key={`${b.app.id}:${offer?.id ?? "none"}:${offer?.updatedAt?.toISOString() ?? ""}`}
          applicationId={b.app.id}
          status={b.app.status}
          atOfferStage={b.def.stages.findIndex((s) => s.key === b.app.stageKey) >= offerStage}
          offerStageName={b.def.stages[offerStage]?.name ?? "Documents & offer"}
          flow={flow}
          compHistory={compHistory}
          plans={planRows.map((p) => ({ id: p.id, key: p.key, title: p.title, version: p.version, basis: p.basis, lines: slabLines(p) }))}
          approvalAbovePercent={cfg["hire.compensation.approvalAbovePercent"]}
          canApprove={ctx.can("compensationApprove")}
          approveWhy={lockedWhy("compensationApprove")}
          offerModel={b.def.offer}
          roleTitle={b.blueprint.title}
          candidateName={b.candidate.fullName}
          location={b.candidate.location}
          offer={
            offer
              ? {
                  id: offer.id,
                  status: offer.status,
                  grade: offer.grade,
                  basicPaise: offer.basicPaise,
                  ctcPaise: offer.ctcPaise,
                  incentive: offer.incentive,
                  joiningDate: offer.joiningDate,
                  expiryDate: offer.expiryDate,
                  courierStatus: offer.courierStatus,
                  backgroundCheck: offer.backgroundCheck,
                  growthConfirmation: offer.growthConfirmation,
                  letterConfirmation: offer.letterConfirmation,
                  issuedAt: offer.issuedAt?.toISOString() ?? null,
                  negotiatedFrom: Boolean(offer.negotiatedFromId),
                  letter: offer.letter,
                  incentiveApplicable: offer.incentiveApplicable,
                  incentivePlanId: offer.incentivePlanId,
                  components: offer.components,
                  effectiveDate: offer.effectiveDate,
                  proposedBasicPaise: offer.proposedBasicPaise,
                  approvalStatus: offer.approvalStatus,
                  approvalNote: offer.approvalNote,
                  approvedByName,
                  approvalRequestedAt: offer.approvalRequestedAt?.toISOString() ?? null,
                  approvalRequestedByName: requestedByName,
                  approvalRequestedByMe: offer.approvalRequestedById === ctx.user.id && ctx.role !== "admin" && ctx.role !== "hr_head",
                  changeReason: offer.changeReason,
                }
              : null
          }
          history={history.filter((h) => h.id !== offer?.id).map((h) => ({ id: h.id, status: h.status, gradeLabel: h.gradeLabel, basicPaise: h.basicPaise, response: h.response, at: (h.respondedAt ?? h.issuedAt ?? h.createdAt).toISOString() }))}
          canOffer={ctx.can("offer")}
          lockedWhy={lockedWhy("offer")}
        />
      </>
    );
  }
  return (
    <OnboardFrame
      title="Offers"
      sub="The package agreed with the candidate: grade, basic, other pay and the incentive plan. A negotiated figure past the line needs an approver before it is issued, and every change keeps the figure it replaced."
      listLabel={`At compensation · ${rows.length}`}
      rows={rows}
      selected={selected}
      basePath="/hire/offers"
      emptyList="Nobody has passed a decision gate into documents and offer yet."
    >
      {panel}
    </OnboardFrame>
  );
}
