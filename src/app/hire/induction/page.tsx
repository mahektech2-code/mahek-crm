import { inArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { getConfig } from "@/lib/config/store";
import { nowMs } from "@/lib/format";
import { requireHireScreen } from "@/lib/hire/access";
import { isOnboardingFlow, isPostHireStage, type BlueprintDefinition } from "@/lib/hire/blueprint-types";
import { lockedWhy } from "@/lib/hire/roles";
import { getApplication, loadBlueprint, type AppBundle } from "@/lib/hire/services/core";
import { onboardItems, onboardList } from "@/lib/hire/services/onboarding";
import { assetHistory, assetRows } from "@/lib/hire/services/onboarding-records";
import { enrollmentForApplication, enrollmentView } from "@/lib/training/service";
import { AssetsPanel, type AssetEvent, type AssetView, type TrainingSummary } from "./assets-panel";
import type { CheckGroup } from "../_onboard/checks";
import { CandidateHead, OnboardFrame } from "../_onboard/frame";
import type { PaneRow } from "../_onboard/list-pane";
import { Callout, fd } from "../_ui/kit";
import { InductionPanel } from "./induction-panel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Assets & induction" };

/** `hire.directory`: "Department | email or work number | what to ask". Resolved to accounts, never stored as names. */
async function directory(): Promise<Map<string, string>> {
  const lines = (await getConfig())["hire.directory"]
    .split("\n")
    .map((l) => l.split("|").map((x) => x.trim()))
    .filter((p) => p.length >= 2 && p[0] && p[1]);
  if (!lines.length) return new Map();
  const ids = lines.map((p) => p[1].toLowerCase());
  const phones = lines.map((p) => p[1].replace(/\D/g, "").slice(-10)).filter((x) => x.length === 10);
  const found = await db
    .select({ name: users.name, email: users.email, phone: users.phone })
    .from(users)
    .where(or(inArray(sql`lower(${users.email})`, ids), phones.length ? inArray(users.phone, phones) : sql`false`));
  const out = new Map<string, string>();
  for (const [dept, contact, about] of lines) {
    const c = contact.toLowerCase();
    const u = found.find((f) => f.email?.toLowerCase() === c || (f.phone && c.replace(/\D/g, "").endsWith(f.phone)));
    if (u) out.set(dept.toLowerCase(), `${u.name}${about ? ` · ${about}` : ""}`);
  }
  return out;
}

async function newFlowPanel(b: AppBundle, canAssets: boolean, canOnboard: boolean, now: number) {
  const [rows, hist, get, dir, enr] = await Promise.all([assetRows(b), assetHistory(b.app.id), onboardItems(b.app.id), directory(), enrollmentForApplication(b.app.id)]);
  const assets: AssetView[] = rows.map((a) => ({
    key: a.key,
    label: a.label,
    serialNeeded: a.serialNeeded,
    acknowledge: a.acknowledge,
    applicable: a.applicable,
    notApplicableReason: a.row?.notApplicableReason ?? null,
    serial: a.row?.serial ?? null,
    issuedOn: a.row?.issuedOn ?? null,
    issuedBy: a.issuedBy,
    acknowledgedAt: a.row?.acknowledgedAt?.toISOString() ?? null,
    ackMethod: a.row?.ackMethod ?? null,
    ackFileId: a.row?.ackFileId ?? null,
    problem: a.row?.problem ?? null,
    returnedOn: a.row?.returnedOn ?? null,
    history: a.history,
  }));
  const history: AssetEvent[] = hist.map(({ a, by }) => ({
    id: a.id,
    label: a.label,
    what: !a.applicable
      ? `not applicable${a.notApplicableReason ? ` · “${a.notApplicableReason}”` : ""}`
      : a.returnedOn
        ? `returned ${a.returnedOn}`
        : a.problem
          ? `problem reported · “${a.problem}”`
          : a.acknowledgedAt
            ? `acknowledged (${a.ackMethod === "signed_slip" ? "signed slip" : "in app"})`
            : a.issuedOn
              ? `issued ${a.issuedOn}${a.serial ? ` · ${a.serial}` : ""}`
              : "applies again",
    by,
    at: a.createdAt.toISOString(),
  }));
  const intros = (b.def.onboarding.intros ?? []).map((i) => {
    const x = get({ kind: "intro", group: "dept", item: i.key });
    return { kind: "intro" as const, group: "dept", item: i.key, label: i.label, done: Boolean(x?.done), serial: null, needsSerial: false, by: x?.doneByName ?? null, at: x?.doneAt?.toISOString() ?? null, who: dir.get(i.label.toLowerCase()) ?? null };
  });
  const setup: CheckGroup[] = b.def.onboarding.setup.map((g) => ({
    key: g.key,
    label: g.system,
    items: g.steps.map((st) => {
      const x = get({ kind: "setup", group: g.key, item: st.key });
      return { kind: "setup" as const, group: g.key, item: st.key, label: st.label, done: Boolean(x?.done), serial: null, needsSerial: false, by: x?.doneByName ?? null, at: x?.doneAt?.toISOString() ?? null };
    }),
  }));
  let training: TrainingSummary = null;
  if (enr) {
    const v = await enrollmentView(enr.id, now);
    if (v) {
      const cur = v.summary.current;
      training = {
        track: `${v.track.title} · v${v.track.version}`,
        trainer: v.trainerName,
        passed: v.summary.passed,
        required: v.summary.required,
        percent: v.summary.percent,
        current: cur ? (v.modules.find((m) => m.moduleKey === cur.moduleKey)?.title ?? cur.moduleKey) : null,
        lastScore: cur?.lastScore ?? null,
        passMark: null,
        next: v.summary.next ? (v.modules.find((m) => m.moduleKey === v.summary.next!.moduleKey)?.title ?? null) : null,
        retraining: v.modules.filter((m) => m.state === "retraining_required").map((m) => m.title),
      };
    }
  }
  const open = b.app.status === "hired" && !b.app.onboardingCompletedAt && isPostHireStage(b.def, b.app.stageKey);
  const why = b.app.status !== "hired" ? "Assets are issued once their account is created on Provision — they acknowledge them in their own account." : b.app.onboardingCompletedAt ? "Onboarding is complete." : null;
  return { assets, history, intros, setup, training, open, why, canAssets, canOnboard };
}

function newFlowBadge(def: BlueprintDefinition, open: number, hired: boolean): { l: string; tone: "warn" | "success" | "neutral" | "info" } {
  if (!hired) return { l: "Not hired yet", tone: "neutral" };
  return open ? { l: `${open} open`, tone: "warn" } : { l: def.stages.some((s) => s.type === "training") ? "In training" : "Complete", tone: open ? "warn" : "info" };
}

export default async function InductionPage({ searchParams }: { searchParams: Promise<{ app?: string }> }) {
  const ctx = await requireHireScreen("induction");
  const sp = await searchParams;
  const list = await onboardList(ctx, "induction");
  const rows: PaneRow[] = [];
  for (const r of list) {
    const bp = await loadBlueprint(r.blueprintId);
    const get = await onboardItems(r.id);
    if (bp && isOnboardingFlow(bp.definition)) {
      const b0 = await getApplication(ctx, r.id);
      const assets = b0 ? await assetRows(b0) : [];
      const openAssets = assets.filter((a) => a.applicable && (!a.row?.issuedOn || (a.acknowledge && !a.row?.acknowledgedAt))).length;
      const openItems = [...(bp.definition.onboarding.intros ?? []).map((i) => get({ kind: "intro", group: "dept", item: i.key })), ...bp.definition.onboarding.setup.flatMap((g) => g.steps.map((st) => get({ kind: "setup", group: g.key, item: st.key })))].filter((x) => !x?.done).length;
      rows.push({ id: r.id, name: r.name, meta: `${r.blueprintTitle} · ${r.location ?? "—"} · ${r.stageName}`, badge: newFlowBadge(bp.definition, openAssets + openItems, r.status === "hired") });
      continue;
    }
    const p = bp?.definition.onboarding;
    const all = p ? [...p.assets.map((a) => get({ kind: "asset", group: "assets", item: a.key })), ...p.modules.flatMap((m) => m.topics.map((t) => get({ kind: "topic", group: m.key, item: t.key })))] : [];
    const left = all.filter((x) => !x?.done).length;
    rows.push({ id: r.id, name: r.name, meta: `${r.blueprintTitle} · ${r.location ?? "—"} · ${r.stageName}`, badge: left ? { l: `${left} open`, tone: "warn" } : { l: "Complete", tone: "success" } });
  }
  const selected = sp.app ?? rows[0]?.id ?? null;
  const b = selected ? await getApplication(ctx, selected) : null;
  let panel: React.ReactNode = null;
  if (b && isOnboardingFlow(b.def)) {
    const v = await newFlowPanel(b, ctx.can("assets"), ctx.can("onboard"), nowMs());
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(nowMs()));
    panel = (
      <>
        <CandidateHead id={b.app.id} name={b.candidate.fullName} meta={`${b.candidate.code} · ${b.blueprint.title} v${b.blueprint.version} · ${b.candidate.location ?? "—"} · ${b.app.status === "hired" ? `hired ${fd(b.app.hiredAt)} · ` : ""}${b.stage?.name ?? ""}`} />
        <AssetsPanel
          key={`${b.app.id}:${b.app.updatedAt.toISOString()}`}
          applicationId={b.app.id}
          {...v}
          today={today}
          lockedAssets={lockedWhy("assets")}
          lockedOnboard={lockedWhy("onboard")}
        />
      </>
    );
  } else if (b) {
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
      title="Assets & induction"
      sub="What the company issued, with its serial or reference, and the employee’s own acknowledgement from the Training app. Department introductions are ticked here; the induction itself is a training module."
      listLabel={`At assets & induction · ${rows.length}`}
      rows={rows}
      selected={selected}
      basePath="/hire/induction"
      emptyList="Nobody is at assets & induction yet."
    >
      {panel}
    </OnboardFrame>
  );
}
