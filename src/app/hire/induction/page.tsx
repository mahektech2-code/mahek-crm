import { requireHireScreen } from "@/lib/hire/access";
import { lockedWhy } from "@/lib/hire/roles";
import { getApplication, loadBlueprint } from "@/lib/hire/services/core";
import { onboardItems, onboardList } from "@/lib/hire/services/onboarding";
import type { CheckGroup } from "../_onboard/checks";
import { CandidateHead, OnboardFrame } from "../_onboard/frame";
import type { PaneRow } from "../_onboard/list-pane";
import { Callout } from "../_ui/kit";
import { InductionPanel } from "./induction-panel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Induction" };

export default async function InductionPage({ searchParams }: { searchParams: Promise<{ app?: string }> }) {
  const ctx = await requireHireScreen("induction");
  const sp = await searchParams;
  const list = await onboardList(ctx, "induction");
  const rows: PaneRow[] = [];
  for (const r of list) {
    const bp = await loadBlueprint(r.blueprintId);
    const get = await onboardItems(r.id);
    const p = bp?.definition.onboarding;
    const all = p ? [...p.assets.map((a) => get({ kind: "asset", group: "assets", item: a.key })), ...p.modules.flatMap((m) => m.topics.map((t) => get({ kind: "topic", group: m.key, item: t.key })))] : [];
    const left = all.filter((x) => !x?.done).length;
    rows.push({ id: r.id, name: r.name, meta: `${r.blueprintTitle} · ${r.location ?? "—"} · ${r.stageName}`, badge: left ? { l: `${left} open`, tone: "warn" } : { l: "Complete", tone: "success" } });
  }
  const selected = sp.app ?? rows[0]?.id ?? null;
  const b = selected ? await getApplication(ctx, selected) : null;
  let panel: React.ReactNode = null;
  if (b) {
    const get = await onboardItems(b.app.id);
    const p = b.def.onboarding;
    const row = (kind: "asset" | "topic", group: string, item: string, label: string, needsSerial: boolean) => {
      const x = get({ kind, group, item });
      return { kind, group, item, label, done: Boolean(x?.done), serial: x?.serial ?? null, needsSerial, by: x?.doneByName ?? null, at: x?.doneAt?.toISOString() ?? null };
    };
    const kit: CheckGroup = { key: "assets", label: "Work kit", items: p.assets.map((a) => row("asset", "assets", a.key, a.label, a.serial)) };
    const mods: CheckGroup[] = p.modules.map((m) => ({ key: m.key, label: m.name, items: m.topics.map((t) => row("topic", m.key, t.key, t.title, false)) }));
    const at = b.def.stages.findIndex((s) => s.key === b.app.stageKey);
    const need = b.def.stages.findIndex((s) => s.type === "checklist");
    const open = b.app.status === "in_progress" && need >= 0 && at >= need;
    panel = (
      <>
        <CandidateHead id={b.app.id} name={b.candidate.fullName} meta={`${b.candidate.code} · ${b.blueprint.title} · ${b.candidate.location ?? "—"} · ${b.stage?.name ?? "Hired"}`} />
        {!open && b.app.status === "in_progress" ? <Callout tone="neutral">Induction starts after documents and the offer.</Callout> : null}
        <InductionPanel key={b.app.id} applicationId={b.app.id} kit={kit} modules={mods} editable={open && ctx.can("onboard")} locked={ctx.can("onboard") ? null : lockedWhy("onboard")} />
      </>
    );
  }
  return (
    <OnboardFrame
      title="Induction"
      sub="Work kit and training topics. A module is complete only when every topic in it is ticked."
      listLabel={`In induction · ${rows.length}`}
      rows={rows}
      selected={selected}
      basePath="/hire/induction"
      emptyList="Nobody is in induction yet."
    >
      {panel}
    </OnboardFrame>
  );
}
