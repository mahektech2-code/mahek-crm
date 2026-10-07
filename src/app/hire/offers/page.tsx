import { and, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { hireOffers } from "@/db/schema";
import { requireHireScreen } from "@/lib/hire/access";
import { lockedWhy } from "@/lib/hire/roles";
import { getApplication } from "@/lib/hire/services/core";
import { onboardList } from "@/lib/hire/services/onboarding";
import { courierArrived, currentOffer, offerHistory } from "@/lib/hire/services/offers";
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
    ? await db.select({ app: hireOffers.applicationId, status: hireOffers.status, courier: hireOffers.courierStatus }).from(hireOffers).where(and(inArray(hireOffers.applicationId, list.map((r) => r.id)), isNull(hireOffers.supersededById)))
    : [];
  const rows: PaneRow[] = list.map((r) => {
    const o = offers.find((x) => x.app === r.id);
    const [l, tone] = BADGE[o?.status ?? "none"];
    return { id: r.id, name: r.name, meta: `${r.blueprintTitle} · ${r.location ?? "—"} · ${r.stageName}`, badge: o?.status === "accepted" && !courierArrived({ courierStatus: o.courier }) ? { l: "Courier due", tone: "warn" } : { l, tone } };
  });
  const selected = sp.app ?? rows[0]?.id ?? null;
  const b = selected ? await getApplication(ctx, selected) : null;

  let panel: React.ReactNode = null;
  if (b) {
    const [offer, history] = await Promise.all([currentOffer(b.app.id), offerHistory(b.app.id)]);
    panel = (
      <>
        <CandidateHead id={b.app.id} name={b.candidate.fullName} meta={`${b.candidate.code} · ${b.blueprint.title} v${b.blueprint.version} · ${b.candidate.location ?? "—"} · ${b.stage?.name ?? "Hired"}`} />
        <OfferPanel
          key={`${b.app.id}:${offer?.id ?? "none"}:${offer?.updatedAt?.toISOString() ?? ""}`}
          applicationId={b.app.id}
          status={b.app.status}
          atOfferStage={b.def.stages.findIndex((s) => s.key === b.app.stageKey) >= b.def.stages.findIndex((s) => s.type === "document_collection")}
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
      sub="Grade, salary and growth plan from the role’s offer model. The briefing and the letter cannot disagree — they read one definition."
      listLabel={`At documents & offer · ${rows.length}`}
      rows={rows}
      selected={selected}
      basePath="/hire/offers"
      emptyList="Nobody has passed a decision gate into documents and offer yet."
    >
      {panel}
    </OnboardFrame>
  );
}
