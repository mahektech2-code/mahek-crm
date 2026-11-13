"use client";

import Link from "next/link";
import { useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { addDays, daysBetween } from "@/lib/format";
import { markChecked, setAssetText, setSeat, setStage, startRenewal, type Seat } from "@/lib/actions/locker-assets";
import { DEFAULT_STEPS, type TimeModel } from "@/lib/locker/catalogue";
import { CRIT, MODEL_LABEL, RENEWAL_STEPS, checkIntervalDays, daysColour, daysLabel, type Stage } from "@/lib/locker/engine";
import type { AssetLite } from "@/lib/locker/lite";
import { Card, buttonClass, cx } from "@/components/ui/primitives";
import { Btn, CritPill, Pill, StatusPill, Tabs, TierPill, fd, initials, inr, nf, useModal, useToast } from "../../_ui/kit";
import { LkIcon } from "../../_ui/icons";
import { AssetForm, type PersonOpt, type PmOpt, type TypeOpt } from "../asset-form";

/* ---------------------------------------------------------------------------
 * ONE ASSET — the design's header (importance, status, code, how long since
 * anybody checked it, the countdown and what happens if it runs out), its
 * actions, and seven tabs. Every action is a server action that re-checks
 * access and writes the audit; the screen refreshes from the server after.
 * ------------------------------------------------------------------------- */

export type AssetVM = {
  lite: AssetLite;
  categoryName: string;
  stage: string | null;
  issuedOn: string | null;
  conditions: string | null;
  physicalLocation: string | null;
  custodianId: string | null;
  custodianName: string | null;
  externalContact: string | null;
  department: string;
  approverId: string | null;
  approverName: string | null;
  executorId: string | null;
  executorName: string | null;
  backupName: string | null;
  amountPaise: number;
  billingCycle: string;
  autoRenew: boolean;
  seats: number;
  extra: Record<string, string>;
  paymentMethod: PmOpt | null;
  paymentMethodId: string | null;
  type: TypeOpt & { steps: string[]; typicalCostPaise: number };
  ladder: number[];
  newer: { id: string; code: string } | null;
  older: { id: string; code: string; docNo: string; endDate: string | null }[];
  openRenewal: { id: string; step: number; done: number; total: number; ackNo: string | null; assignedName: string | null } | null;
  history: { when: string; docNo: string; cost: number; by: string }[];
  docs: { id: string; filename: string; sizeBytes: number; contentType: string; uploadedAt: string; by: string; hash: string | null; current: boolean; assetId: string }[];
  creds: { id: string; title: string; tier: string; auth: string; sole: boolean; viaEmail: string | null; hint: string | null; rotated: string | null; lastReveal: string | null }[];
  reliesOnThis: AssetLite[];
  activity: { at: string; who: string; t: string }[];
  people: (PersonOpt & { code: string })[];
  pms: PmOpt[];
  entities: { id: string; name: string; gstin: string | null }[];
  sites: { id: string; name: string }[];
  vault: boolean;
  canEdit: boolean;
  today: string;
};

type TabKey = "details" | "ownership" | "renewal" | "documents" | "credentials" | "dependencies" | "activity";
const LBL = "text-xs font-medium tracking-label text-muted uppercase";
const cardHead = "text-base font-semibold text-ink";

export function AssetScreen({ vm, initialTab }: { vm: AssetVM; initialTab: string }) {
  const router = useRouter();
  const modal = useModal();
  const toast = useToast();
  const a = vm.lite;
  const m = vm.type.model as TimeModel;
  const [tab, setTab] = useState<TabKey>((["details", "ownership", "renewal", "documents", "credentials", "dependencies", "activity"].includes(initialTab) ? initialTab : "details") as TabKey);
  const [editing, setEditing] = useState(false);
  const [upBusy, setUpBusy] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const ro = !vm.canEdit;
  const hasCase = !!vm.openRenewal;
  const superseded = vm.stage === "superseded";
  const ad = a.actionIn;
  const act = async (p: Promise<{ ok: boolean; error?: string; message?: string }>, done?: string, undo?: () => void) => {
    const r = await p;
    if (!r.ok) return r.error ?? "Could not save.";
    toast(r.message ?? done ?? "Saved", undo);
    router.refresh();
  };

  if (editing) {
    return (
      <div className="px-6 pt-5 pb-12">
        <AssetForm
          type={vm.type}
          categoryName={vm.categoryName}
          people={vm.people}
          entities={vm.entities}
          sites={vm.sites}
          pms={vm.pms}
          today={vm.today}
          assetId={a.id}
          init={{
            title: a.title,
            criticality: a.crit,
            entityId: a.entityId ?? "",
            siteId: a.siteId ?? "",
            endDate: a.endDate ?? "",
            issuedOn: vm.issuedOn ?? "",
            docNo: a.docNo,
            provider: a.provider,
            amountRupees: vm.amountPaise ? String(vm.amountPaise / 100) : "",
            billingCycle: vm.billingCycle,
            paymentMethodId: vm.paymentMethodId ?? "",
            autoRenew: vm.autoRenew,
            seats: vm.seats ? String(vm.seats) : "",
            noticeDays: String(a.noticeDays || ""),
            conditions: vm.conditions ?? "",
            department: vm.department,
            externalContact: vm.externalContact ?? "",
            ownerId: a.ownerId ?? "",
            backupId: a.backupId ?? "",
            extra: vm.extra,
          }}
          onBack={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            toast("Saved");
            router.refresh();
          }}
        />
      </div>
    );
  }

  /* ----- header numbers, as the design words them ----- */
  const cdLabel = m === "subscription" ? "Renews in" : m === "term_contract" ? "Last day to give notice in" : m === "perpetual" ? (a.endDate ? "Support" : "Validity") : (a.d ?? 0) < 0 ? "Expired" : "Expires in";
  const cd = m === "perpetual" && !a.endDate ? "No expiry" : m === "term_contract" ? (ad == null ? "—" : ad >= 0 ? `${nf(ad)} days` : "Passed") : a.d != null && a.d < 0 ? `${nf(-a.d)} days ago` : daysLabel(a.d);
  const cdDate = m === "perpetual" && !a.endDate ? (a.checkedAgo != null ? `Checked ${nf(a.checkedAgo)} days ago` : "Never checked") : fd(a.actionDate);
  const secondary =
    m === "term_contract" && a.endDate
      ? `Term ends ${fd(a.endDate)} · ${a.noticeDays}-day notice period`
      : a.status === "in_grace" && a.endDate
        ? `Grace ends ${fd(addDays(a.endDate, vm.type.graceDays))} · ${(a.d ?? 0) + vm.type.graceDays} days left`
        : a.status === "renewal_filed" && vm.openRenewal
          ? `Applied${vm.openRenewal.ackNo ? ` · acknowledgement ${vm.openRenewal.ackNo}` : ""} · awaiting the office`
          : "";

  /* ----- actions ----- */
  const checkModal = () =>
    modal({
      title: "Mark as checked",
      sub: "Confirm you have checked this record against the actual document.",
      fields: [{ k: "n", l: "What you checked", type: "area", min: 10, init: "End date and document number checked against the original." }],
      okL: "Mark checked",
      done: (v) => act(markChecked(a.id, v.n), `Checked · next check in ${checkIntervalDays(a.crit)} days`),
    });
  const stageModal = () =>
    modal({
      title: "Change the status",
      sub: "Cancel it if it is deliberately not being renewed, or record a lost original, a suspension or a dispute. Nothing is deleted.",
      fields: [
        {
          k: "s",
          l: "New status",
          type: "select",
          req: true,
          opts: [
            { v: "", l: "Choose" },
            { v: "cancelled", l: "Cancelled — deliberately not renewed" },
            { v: "lost", l: "Original lost — the paper cannot be found" },
            { v: "suspended", l: "Suspended by the authority" },
            { v: "disputed", l: "Disputed — under appeal or litigation" },
            ...(vm.stage && ["cancelled", "lost", "suspended", "disputed", "draft"].includes(vm.stage) ? [{ v: "clear", l: "Back to its dates" }] : []),
          ],
        },
        { k: "why", l: "Why", type: "area", min: 10 },
      ],
      okL: "Save",
      danger: true,
      done: (v) => act(setStage(a.id, v.s === "clear" ? null : (v.s as Stage), v.why)),
    });
  const acts: ReactNode[] = ro
    ? []
    : superseded
      ? vm.newer
        ? [<Btn key="n" kind="p" onClick={() => router.push(`/locker/assets/${vm.newer!.id}`)}>Open the current version</Btn>]
        : []
      : [
          <Btn
            key="r"
            kind="p"
            onClick={async () => {
              if (hasCase) return router.push(`/locker/assets/${a.id}/renewal`);
              const r = await startRenewal(a.id);
              if (!r.ok) return toast(r.error);
              router.push(`/locker/assets/${a.id}/renewal`);
            }}
          >
            {hasCase ? "Open renewal task" : "Start renewal"}
          </Btn>,
          <Btn key="c" onClick={checkModal}>
            Mark as checked
          </Btn>,
          <Btn key="e" onClick={() => setEditing(true)}>
            Edit
          </Btn>,
          <Btn key="s" kind="g" onClick={stageModal}>
            Change status
          </Btn>,
        ];

  /* ----- seat rows ----- */
  const seatRow = (role: string, seat: Seat | null, uid: string | null, name: string | null, required: boolean, sub?: string) => {
    const miss = !uid && !name;
    const person = vm.people.find((p) => p.id === uid);
    const assign = () =>
      seat &&
      modal({
        title: `${miss ? "Assign" : "Reassign"} ${role.toLowerCase()}`,
        sub: a.title,
        fields: [{ k: "p", l: "Person", type: "select", req: seat === "owner", opts: [{ v: "", l: seat === "owner" ? "Choose a person" : "Nobody" }].concat(vm.people.map((p) => ({ v: p.id, l: p.title ? `${p.name} · ${p.title}` : p.name }))) }],
        okL: "Save",
        done: async (v) => {
          const r = await setSeat(a.id, seat, v.p || null);
          if (!r.ok) return r.error;
          const prev = r.data.previous;
          toast(r.message ?? "Saved", seat === "owner" && !prev ? undefined : async () => {
            const u = await setSeat(a.id, seat, prev);
            if (!u.ok) toast(u.error);
            router.refresh();
          });
          router.refresh();
        },
      });
    const bad = miss && required;
    return (
      <div key={role} className={cx("flex items-center gap-3.5 border-t border-divider px-5 py-3.5 first:border-t-0", bad ? "border-l-[3px] border-l-danger bg-danger-soft" : "bg-surface")}>
        <span className={cx("flex h-9 w-9 flex-none items-center justify-center rounded-full text-[13px] font-semibold", bad ? "bg-danger text-white" : seat ? "bg-brand-soft text-brand-hover" : "bg-divider text-body")}>{miss ? "!" : seat ? initials(name) : "EX"}</span>
        <span className="min-w-0 flex-1">
          <span className={cx(LBL, "block")}>{role}</span>
          <span className={cx("mt-0.5 block text-[15px] font-semibold", bad ? "text-danger" : "text-ink")}>{miss ? (required ? "Unassigned — this is a problem" : "Not set") : name}</span>
          <span className="block text-xs text-muted">
            {sub ?? (miss ? (required ? `Every ${role === "Primary owner" ? "asset" : CRIT[a.crit].label.toLowerCase() + " asset"} must have one. Reminders have nowhere to go.` : "Optional") : [person?.title, person?.code].filter(Boolean).join(" · "))}
          </span>
        </span>
        {!ro && seat ? (
          <Btn small kind={bad ? "d" : "s"} onClick={assign}>
            {miss ? "Assign" : "Reassign"}
          </Btn>
        ) : null}
      </div>
    );
  };
  const textModal = (field: "externalContact" | "department" | "physicalLocation", label: string, init: string) =>
    modal({ title: label, sub: a.title, fields: [{ k: "v", l: label, init }], okL: "Save", done: (v) => act(setAssetText(a.id, field, v.v)) });

  /* ----- details fields ----- */
  const F: [string, string, boolean?][] = [];
  const add = (l: string, v: string | number | null | undefined, mono?: boolean) => F.push([l, v == null || v === "" ? "—" : String(v), mono]);
  add("Time model", MODEL_LABEL[m]);
  const issuedBy = vm.extra.issued_by || vm.type.authority;
  if (m === "document") {
    add("Document number", a.docNo, true);
    add("Issued by", issuedBy);
    add("Issued on", fd(vm.issuedOn));
    add("Valid for", vm.type.validityMonths >= 12 ? `${vm.type.validityMonths / 12} ${vm.type.validityMonths === 12 ? "year" : "years"}` : vm.type.validityMonths ? `${vm.type.validityMonths} months` : null);
    add("Expires on", a.endDate ? `${fd(a.endDate)} · ${daysLabel(a.d)}` : null);
    add("Grace period", vm.type.graceDays ? `${vm.type.graceDays} days after expiry` : "None — runs out on the end date");
  }
  if (m === "subscription") {
    add("Provider", a.provider);
    add("Plan", a.title);
    add("Billing cycle", vm.billingCycle || "Annual");
    add("Current period ends", fd(a.endDate));
    add("Amount", vm.amountPaise ? `${inr(vm.amountPaise)} · ${vm.billingCycle || "Annual"} · INR, GST extra` : "Usage-based");
    add("Auto-renew", vm.autoRenew ? "On" : "Off — renews only if someone acts");
    const pm = vm.paymentMethod;
    add("Payment method", pm ? `${pm.label} ····${pm.last4}${pm.expiresOn ? ` · card expires ${fd(pm.expiresOn)}${a.endDate && pm.expiresOn < a.endDate ? " — before this renews" : ""}` : ""}` : "Manual transfer");
    if (vm.seats) add("Seats", vm.seats);
    add("Cancellation deadline", vm.extra.cancellation_deadline ? fd(vm.extra.cancellation_deadline) : a.endDate ? fd(addDays(a.endDate, -7)) : null);
  }
  if (m === "perpetual") {
    add("Document number", a.docNo, true);
    add("Issued by", issuedBy);
    add("Acquired on", fd(vm.issuedOn));
    add("Validity", "Does not expire");
    if (a.endDate) add("Support expires on", `${fd(a.endDate)} · ${daysLabel(a.d)}`);
    if (vm.extra.version) add("Version", vm.extra.version);
    add("Next check", a.checkedAgo == null ? "Now — never checked" : fd(addDays(vm.today, checkIntervalDays(a.crit) - a.checkedAgo)));
  }
  if (m === "term_contract") {
    add("Other party", a.provider || vm.type.authority);
    add("Signed on", fd(vm.issuedOn));
    if (vm.issuedOn && a.endDate) add("Term", `${Math.round(daysBetween(vm.issuedOn, a.endDate) / 30.44)} months`);
    add("Expires on", fd(a.endDate));
    add("Notice period", `${a.noticeDays} days`);
    add("Last day to give notice", ad == null ? null : `${fd(a.actionDate)} · ${ad >= 0 ? `${nf(ad)} days from today` : "passed"}`);
  }
  for (const f of vm.type.fields) add(f.label, vm.extra[f.key]);
  add("Company", a.entityName);
  add("Site", a.siteName ? `${a.siteName}${a.siteState ? `, ${a.siteState}` : ""}` : "Company-wide");
  add("Department", vm.department);

  const doc = (x: AssetVM["docs"][number]) => (
    <a key={x.id} href={`/api/locker/assets/${x.assetId}/documents/${x.id}`} target="_blank" rel="noreferrer" className="flex w-full items-center gap-3 border-t border-divider bg-surface px-5 py-3 text-left no-underline first:border-t-0 hover:bg-canvas hover:no-underline">
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="text-sm font-medium text-ink">{x.filename}</span>
          {x.current ? <Pill tone="success" label="Current" /> : <Pill tone="muted" label="Replaced" />}
        </span>
        <span className="mt-0.5 block text-xs text-muted">
          {x.contentType === "application/pdf" ? "PDF" : x.contentType.replace("image/", "").toUpperCase()} · {(x.sizeBytes / 1048576).toFixed(1)} MB · uploaded {x.uploadedAt}
          {x.by ? ` by ${x.by}` : ""}
        </span>
      </span>
      <span className={cx("font-mono text-xs whitespace-nowrap", x.hash ? "text-success" : "text-muted")} title={x.hash ? `SHA-256 ${x.hash}` : "Uploaded before hashing"}>
        {x.hash ? `✓ SHA-256 ${x.hash.slice(0, 8)}…` : "no hash"}
      </span>
    </a>
  );

  const upload = async (file: File) => {
    setUpBusy(`Uploading ${file.name}…`);
    const fd2 = new FormData();
    fd2.append("file", file);
    const r = await fetch(`/api/locker/assets/${a.id}/documents`, { method: "POST", body: fd2 }).then((x) => x.json()).catch(() => ({ ok: false, error: "The upload did not reach the server." }));
    setUpBusy("");
    if (!r.ok) return toast(r.error);
    toast(r.message ?? "Uploaded · hash recorded");
    router.refresh();
  };

  const tabs: { key: TabKey; label: string; red?: boolean }[] = [
    { key: "details", label: "Details" },
    { key: "ownership", label: "Ownership" + (!a.ownerId || (a.crit >= 3 && !a.backupId) ? " ●" : ""), red: !a.ownerId },
    { key: "renewal", label: "Renewal" },
    { key: "documents", label: "Documents" },
    ...(vm.vault ? [{ key: "credentials" as TabKey, label: "Passwords & keys" }] : []),
    { key: "dependencies", label: "Connections" },
    { key: "activity", label: "Activity" },
  ];

  const steps = vm.type.steps.length ? vm.type.steps : DEFAULT_STEPS;
  const at = vm.openRenewal?.step ?? 0;
  const leadStart = a.endDate && vm.type.leadDays ? addDays(a.endDate, -vm.type.leadDays) : null;
  const leadIn = leadStart ? daysBetween(vm.today, leadStart) : null;

  const row = "flex w-full items-center gap-2.5 border-t border-divider bg-surface px-5 py-2.5 no-underline first:border-t-0";
  const emptyCls = "p-5 text-sm text-muted";
  return (
    <div>
      <div className="px-6 pt-5">
        <Card className="overflow-hidden border-l-[3px]" style={{ borderLeftColor: CRIT[a.crit].edge }}>
          <div className="flex items-start gap-5 px-6 py-5">
            <button type="button" onClick={() => router.back()} title="Back" aria-label="Back" className="flex h-8 w-8 flex-none cursor-pointer items-center justify-center rounded-control border border-line bg-surface text-body hover:bg-canvas">
              ‹
            </button>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-2">
                <CritPill crit={a.crit} />
                <StatusPill status={a.status} />
                <span className="font-mono text-xs text-muted">{a.code}</span>
                {a.unchecked ? <span className="text-xs font-medium text-warn-ink">{a.checkedAgo == null ? "Never checked against the document" : `Not checked for ${nf(a.checkedAgo)} days`}</span> : null}
              </span>
              <span className="mt-2 block text-[22px] leading-7 font-semibold text-ink">{a.title}</span>
              <span className="mt-1 block text-[13px] text-muted">{[vm.type.name, a.entityName, a.siteName ? `${a.siteName}${a.siteState ? `, ${a.siteState}` : ""}` : null, a.docNo].filter(Boolean).join(" · ")}</span>
              {a.crit >= 3 && a.consequence ? (
                <span className="mt-2.5 block max-w-[760px] text-[13px] leading-[19px] text-danger">
                  <span className="font-semibold">If this runs out: </span>
                  {a.consequence}
                </span>
              ) : null}
              {superseded && vm.newer ? <span className="mt-2.5 block text-[13px] text-muted">Replaced by {vm.newer.code}. This version stays in the chain.</span> : null}
            </span>
            <span className="flex-none text-right">
              <span className={cx(LBL, "block")}>{cdLabel}</span>
              <span className="block text-[40px] leading-[44px] font-semibold whitespace-nowrap text-ink" style={a.d != null && a.d < 0 ? { color: daysColour(a.d, a.status) } : undefined}>
                {cd}
              </span>
              <span className="block text-[13px] text-muted">{cdDate}</span>
              {secondary ? <span className="mt-1 block text-xs text-body">{secondary}</span> : null}
            </span>
          </div>
          {acts.length ? <div className="flex flex-wrap gap-2 pr-6 pb-4 pl-[76px]">{acts}</div> : null}
        </Card>
      </div>

      <div className="px-6 pt-4 pb-12">
        <div className="mb-5">
          <Tabs tabs={tabs} value={tab} onPick={setTab} />
        </div>

        {tab === "details" ? (
          <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
            <Card className="overflow-hidden">
              {F.map(([l, v, mono]) => (
                <div key={l} className="grid grid-cols-[220px_minmax(0,1fr)] gap-4 border-t border-divider px-5 py-3 first:border-t-0">
                  <span className={LBL}>{l}</span>
                  <span className={cx("text-sm text-ink", mono && "font-mono")}>{v}</span>
                </div>
              ))}
            </Card>
            <div className="flex flex-col gap-4">
              {vm.conditions ? (
                <Card className="px-5 py-4">
                  <div className={cardHead}>Conditions imposed</div>
                  <div className="mt-1.5 text-[13px] leading-5 whitespace-pre-wrap text-body">{vm.conditions}</div>
                </Card>
              ) : null}
              <Card className="px-5 py-4">
                <div className={cardHead}>Reminder schedule</div>
                <div className="mt-0.5 text-xs text-muted">{CRIT[a.crit].label} schedule · moves up owner → backup → department head → management</div>
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {vm.ladder.map((x) => {
                    const done = ad != null && ad <= -x;
                    return (
                      <span key={x} title={a.actionDate ? fd(addDays(a.actionDate, x)) : undefined} className={cx("rounded-[4px] border px-2 py-[3px] text-xs font-medium", done ? "border-ink bg-ink text-white" : "border-line bg-canvas text-body")}>
                        {(x > 0 ? `+${x}` : x === 0 ? "Day 0" : String(x)) + (x === Math.max(...vm.ladder) && x > 0 ? " daily" : "")}
                      </span>
                    );
                  })}
                </div>
              </Card>
            </div>
          </div>
        ) : null}

        {tab === "ownership" ? (
          <Card className="max-w-[900px] overflow-hidden">
            {seatRow("Primary owner", "owner", a.ownerId, a.ownerName, true)}
            {seatRow("Backup owner", "backup", a.backupId, vm.backupName, a.crit >= 3)}
            {seatRow("Approver", "approver", vm.approverId, vm.approverName, false, vm.approverId ? undefined : "Who authorises the renewal spend. Optional.")}
            {seatRow("Executor", "executor", vm.executorId, vm.executorName ?? (vm.executorId ? null : null), false, vm.executorId ? undefined : `Who does the renewal work. Not set — it falls to the owner${a.ownerName ? `, ${a.ownerName}` : ""}.`)}
            <div className="flex items-center gap-3.5 border-t border-divider px-5 py-3.5">
              <span className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-divider text-xs font-semibold text-body">EX</span>
              <span className="min-w-0 flex-1">
                <span className={cx(LBL, "block")}>External contact</span>
                <span className="mt-0.5 block text-[15px] font-semibold text-ink">{vm.externalContact || "None recorded"}</span>
                <span className="block text-xs text-muted">Part of the renewal path — their absence is a single point of failure too</span>
              </span>
              {!ro ? <Btn small onClick={() => textModal("externalContact", "External contact", vm.externalContact ?? "")}>{vm.externalContact ? "Change" : "Add"}</Btn> : null}
            </div>
            <div className="flex items-center gap-3.5 border-t border-divider px-5 py-3.5">
              <span className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-divider text-xs font-semibold text-body">DP</span>
              <span className="min-w-0 flex-1">
                <span className={cx(LBL, "block")}>Department</span>
                <span className="mt-0.5 block text-[15px] font-semibold text-ink">{vm.department || "Not set"}</span>
                <span className="block text-xs text-muted">Cost and accountability are attributed here</span>
              </span>
              {!ro ? <Btn small onClick={() => textModal("department", "Department", vm.department)}>{vm.department ? "Change" : "Add"}</Btn> : null}
            </div>
          </Card>
        ) : null}

        {tab === "renewal" ? (
          <div className="flex max-w-[980px] flex-col gap-4">
            <div className="rounded-card border border-line bg-canvas px-[18px] py-3.5 text-sm text-ink">
              <span className="font-semibold">{vm.type.leadDays ? `Apply at least ${vm.type.leadDays} days before end date.` : "No time needed to renew — this type never ends."}</span>{" "}
              <span className="text-body">{leadStart && leadIn != null ? (leadIn <= 0 ? `That date has passed — ${fd(leadStart)}.` : `Start by ${fd(leadStart)}, in ${nf(leadIn)} days.`) : ""}</span>
            </div>
            {vm.openRenewal ? (
              <Card className="px-5 py-4">
                <div className="flex items-center gap-2.5">
                  <span className={cx(cardHead, "flex-1")}>
                    RC-{a.code.slice(4)} · {RENEWAL_STEPS[at]}
                  </span>
                  <Btn small kind="p" onClick={() => router.push(`/locker/assets/${a.id}/renewal`)}>
                    Open renewal task
                  </Btn>
                </div>
                <div className="mt-3.5 flex gap-1">
                  {RENEWAL_STEPS.map((l, i) => (
                    <span key={l} title={l} className={cx("h-1.5 flex-1 rounded-full", i <= at ? "bg-brand" : "bg-divider")} />
                  ))}
                </div>
                <div className="mt-1.5 text-xs text-muted">
                  Assigned to {vm.openRenewal.assignedName ?? "—"} · {vm.openRenewal.ackNo ? `acknowledgement ${vm.openRenewal.ackNo}` : `${vm.openRenewal.done} of ${vm.openRenewal.total} checklist items done`}
                </div>
              </Card>
            ) : null}
            <Card className="px-5 py-4">
              <div className={cardHead}>Steps · {vm.type.name}</div>
              <div className="mt-0.5 text-xs text-muted">
                Issued by: {issuedBy} · typical fee {vm.type.typicalCostPaise ? inr(vm.type.typicalCostPaise) : "nil"} · typical timeline {Math.max(14, Math.round(vm.type.leadDays * 0.6))} days
              </div>
              {steps.map((p, i) => (
                <div key={i} className="mt-1.5 flex gap-2.5 border-t border-divider py-2 text-sm text-ink">
                  <span className="w-5 flex-none text-muted">{i + 1}</span>
                  <span>{p}</span>
                </div>
              ))}
            </Card>
            <Card className="overflow-hidden">
              <div className={cx(cardHead, "border-b border-divider px-5 py-3")}>Renewal history</div>
              {vm.history.map((h, i) => (
                <div key={i} className="grid grid-cols-[160px_minmax(0,1fr)_120px_140px] gap-3 border-t border-divider px-5 py-2.5 text-sm first:border-t-0">
                  <span>{h.when}</span>
                  <span className="text-ink">Renewed · {h.docNo || a.docNo}</span>
                  <span className="text-right">{h.cost ? inr(h.cost) : "—"}</span>
                  <span>{h.by || "—"}</span>
                </div>
              ))}
              {vm.older.map((o) => (
                <Link key={o.id} href={`/locker/assets/${o.id}`} className="grid grid-cols-[160px_minmax(0,1fr)_120px_140px] gap-3 border-t border-divider px-5 py-2.5 text-sm text-body no-underline hover:bg-canvas hover:no-underline">
                  <span>{fd(o.endDate)}</span>
                  <span className="text-ink">Earlier version · {o.docNo || o.code}</span>
                  <span className="text-right">—</span>
                  <span>{o.code}</span>
                </Link>
              ))}
              {!vm.history.length && !vm.older.length ? <div className="px-5 py-3 text-[13px] text-muted">No renewal recorded in the Locker yet.</div> : null}
            </Card>
          </div>
        ) : null}

        {tab === "documents" ? (
          <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
            <Card className="overflow-hidden">
              {vm.docs.map(doc)}
              {!vm.docs.length ? <div className={emptyCls}>No document uploaded yet. Upload the scan of the current certificate — its SHA-256 is recorded, and any later change to the stored file is caught and refused.</div> : null}
              {!ro && !superseded ? (
                <div className="flex items-center gap-2.5 border-t border-divider bg-page px-5 py-3">
                  <input
                    ref={fileRef}
                    type="file"
                    accept="application/pdf,image/png,image/jpeg,image/webp"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void upload(f);
                      e.target.value = "";
                    }}
                  />
                  <Btn small kind="p" onClick={() => fileRef.current?.click()}>
                    Upload a document
                  </Btn>
                  <span className="text-xs text-muted">{upBusy || "PDF, JPG or PNG · up to 20 MB"}</span>
                </div>
              ) : null}
            </Card>
            <Card className="px-5 py-4">
              <div className={cardHead}>Physical original</div>
              <div className="mt-2 text-sm text-ink">{vm.physicalLocation || (m === "subscription" ? "Digital only — no physical original" : "Not recorded")}</div>
              <div className="mt-1 text-xs text-muted">Held by {vm.custodianName || a.ownerName || "nobody recorded"}</div>
              {!ro ? (
                <div className="mt-3 flex gap-2">
                  <Btn small onClick={() => textModal("physicalLocation", "Where the original is", vm.physicalLocation ?? "")}>Where it is</Btn>
                  <Btn
                    small
                    onClick={() =>
                      modal({
                        title: "Who holds the original",
                        sub: a.title,
                        fields: [{ k: "p", l: "Custodian", type: "select", opts: [{ v: "", l: "Nobody recorded" }].concat(vm.people.map((p) => ({ v: p.id, l: p.name }))) }],
                        okL: "Save",
                        done: (v) => act(setSeat(a.id, "custodian", v.p || null)),
                      })
                    }
                  >
                    Who holds it
                  </Btn>
                </div>
              ) : null}
            </Card>
          </div>
        ) : null}

        {tab === "credentials" && vm.vault ? (
          <div className="flex max-w-[900px] flex-col gap-3">
            {!vm.creds.length ? <Card className="p-6 text-sm text-muted">No vault items are linked to this asset.</Card> : null}
            {vm.creds.map((v) => (
              <Card key={v.id} className="overflow-hidden border-l-[3px] border-l-ink">
                <div className="flex items-center gap-2.5 border-b border-divider bg-page px-5 py-3">
                  <span className="flex text-muted">
                    <LkIcon name="key" size={14} />
                  </span>
                  <Link href={`/locker/vault/${v.id}`} className="flex-1 text-sm font-semibold text-ink no-underline hover:underline">
                    {v.title}
                  </Link>
                  <TierPill tier={v.tier as "standard" | "sensitive" | "restricted"} />
                </div>
                <div className="grid min-h-12 grid-cols-[120px_minmax(0,1fr)_auto] items-center gap-3 px-5">
                  <span className={LBL}>Secret</span>
                  <span className="flex min-w-0 flex-col gap-0.5 overflow-hidden">
                    <span className="font-mono text-[15px] leading-5 tracking-[0.08em] whitespace-nowrap text-ink">••••••••••••</span>
                    <span className="font-mono text-xs leading-4 text-muted">ends ····{v.hint ?? "··"}</span>
                  </span>
                  <Link href={`/locker/vault/${v.id}`} className={buttonClass({ variant: "primary", size: "sm" })}>
                    Reveal
                  </Link>
                </div>
                <div className="px-5 pb-3 text-xs text-muted">
                  {v.rotated ? `Changed ${v.rotated}` : "Never changed in the Locker"} · {v.lastReveal ? `last revealed ${v.lastReveal}` : "never revealed"}
                </div>
              </Card>
            ))}
          </div>
        ) : null}

        {tab === "dependencies" ? (
          <div className="grid max-w-[1080px] grid-cols-1 gap-4 lg:grid-cols-2">
            {[
              {
                l: "This relies on",
                sub: "Passwords & keys, payment methods and sign-in accounts it needs",
                items: [
                  ...vm.creds.map((c) => ({ key: c.id, t: c.title, m: c.auth === "federated_sso" ? `Signs in via ${c.viaEmail ?? "—"}` : "Direct login", b: c.sole ? <Pill tone="danger" label="Only way in" /> : <Pill tone="neutral" label="Login" />, href: `/locker/vault/${c.id}` })),
                  ...(vm.paymentMethod
                    ? [
                        {
                          key: vm.paymentMethod.id,
                          t: `${vm.paymentMethod.label} ····${vm.paymentMethod.last4}`,
                          m: `Pays this subscription${vm.paymentMethod.expiresOn ? ` · expires ${fd(vm.paymentMethod.expiresOn)}` : ""}`,
                          b: vm.paymentMethod.expiresOn && a.endDate && vm.paymentMethod.expiresOn < a.endDate ? <Pill tone="warn" label="Expires first" /> : <Pill tone="muted" label="Payment" />,
                          href: undefined as string | undefined,
                        },
                      ]
                    : []),
                ],
              },
              { l: "Relies on this", sub: "What stops or becomes invalid if this runs out", items: vm.reliesOnThis.map((x) => ({ key: x.id, t: x.title, m: "Assumes this licence is valid", b: <StatusPill status={x.status} />, href: `/locker/assets/${x.id}` as string | undefined })) },
            ].map((g) => (
              <Card key={g.l} className="overflow-hidden">
                <div className="border-b border-divider px-5 py-3">
                  <div className={cardHead}>{g.l}</div>
                  <div className="text-xs text-muted">{g.sub}</div>
                </div>
                {g.items.map((i) => {
                  const inner = (
                    <>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium text-ink">{i.t}</span>
                        <span className="block text-xs text-muted">{i.m}</span>
                      </span>
                      {i.b}
                    </>
                  );
                  return i.href ? (
                    <Link key={i.key} href={i.href} className={cx(row, "hover:bg-canvas hover:no-underline")}>
                      {inner}
                    </Link>
                  ) : (
                    <div key={i.key} className={row}>
                      {inner}
                    </div>
                  );
                })}
                {!g.items.length ? <div className="px-5 py-3.5 text-[13px] text-muted">Nothing recorded.</div> : null}
              </Card>
            ))}
          </div>
        ) : null}

        {tab === "activity" ? (
          <Card className="max-w-[1080px] overflow-hidden">
            {vm.activity.map((x, i) => (
              <div key={i} className="grid grid-cols-[170px_170px_minmax(0,1fr)] gap-3 border-t border-divider px-5 py-2.5 text-[13px] first:border-t-0">
                <span className="text-muted">{x.at}</span>
                <span className="font-medium text-ink">{x.who}</span>
                <span className="text-body">{x.t}</span>
              </div>
            ))}
            {!vm.activity.length ? <div className={emptyCls}>Nothing recorded yet.</div> : null}
          </Card>
        ) : null}
      </div>
    </div>
  );
}
