"use client";

import Link from "next/link";
import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { addDays, daysBetween } from "@/lib/format";
import { markChecked, setAssetText, setSeat, setStage, startRenewal, type Seat } from "@/lib/actions/locker-assets";
import { DEFAULT_STEPS, type TimeModel } from "@/lib/locker/catalogue";
import { CRIT, MODEL_LABEL, RENEWAL_STEPS, checkIntervalDays, daysColour, daysLabel, type Stage } from "@/lib/locker/engine";
import type { AssetLite } from "@/lib/locker/lite";
import { Btn, C, CritPill, LBL, MONO, Pill, StatusPill, Tabs, TierPill, fd, initials, inr, nf, useModal, useToast } from "../../_ui/kit";
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
const card: CSSProperties = { background: "#FFFFFF", border: `1px solid ${C.line}`, borderRadius: 6, overflow: "hidden" };

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
      <div style={{ padding: "20px 24px 48px 24px" }}>
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
      <div key={role} style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 20px", borderTop: `1px solid ${C.line3}`, background: bad ? C.redSoft : "#FFFFFF", boxShadow: bad ? `inset 3px 0 0 ${C.red}` : "none" }}>
        <span style={{ width: 36, height: 36, borderRadius: "50%", flex: "none", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 600, background: bad ? C.red : seat ? C.brandSoft : C.line2, color: bad ? "#FFFFFF" : seat ? C.brandInk : C.body }}>{miss ? "!" : seat ? initials(name) : "EX"}</span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ ...LBL, display: "block" }}>{role}</span>
          <span style={{ display: "block", fontSize: 15, fontWeight: 600, color: bad ? C.red : C.ink, marginTop: 2 }}>{miss ? (required ? "Unassigned — this is a problem" : "Not set") : name}</span>
          <span style={{ display: "block", fontSize: 12, color: C.muted }}>
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
    <a key={x.id} href={`/api/locker/assets/${x.assetId}/documents/${x.id}`} target="_blank" rel="noreferrer" className="lk-row" style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", padding: "12px 20px", borderTop: `1px solid ${C.line3}`, background: "#FFFFFF", textAlign: "left", textDecoration: "none" }}>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 500, color: C.ink }}>{x.filename}</span>
          {x.current ? <Pill label="Current" bg={C.greenSoft} fg={C.green} /> : <Pill label="Replaced" bg={C.soft} fg={C.muted} />}
        </span>
        <span style={{ display: "block", fontSize: 12, color: C.muted, marginTop: 2 }}>
          {x.contentType === "application/pdf" ? "PDF" : x.contentType.replace("image/", "").toUpperCase()} · {(x.sizeBytes / 1048576).toFixed(1)} MB · uploaded {x.uploadedAt}
          {x.by ? ` by ${x.by}` : ""}
        </span>
      </span>
      <span style={{ fontSize: 12, color: x.hash ? C.green : C.muted, whiteSpace: "nowrap", fontFamily: MONO }} title={x.hash ? `SHA-256 ${x.hash}` : "Uploaded before hashing"}>
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

  return (
    <div>
      <div style={{ padding: "20px 24px 0 24px" }}>
        <div style={{ ...card, borderLeft: `3px solid ${CRIT[a.crit].edge}` }}>
          <div style={{ display: "flex", gap: 20, alignItems: "flex-start", padding: "20px 24px" }}>
            <button type="button" onClick={() => router.back()} title="Back" style={{ width: 32, height: 32, border: `1px solid ${C.line}`, background: "#FFFFFF", borderRadius: 4, cursor: "pointer", color: C.body, flex: "none" }}>
              ‹
            </button>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <CritPill crit={a.crit} />
                <StatusPill status={a.status} />
                <span style={{ fontSize: 12, color: C.muted, fontFamily: MONO }}>{a.code}</span>
                {a.unchecked ? <span style={{ fontSize: 12, color: C.amber, fontWeight: 500 }}>{a.checkedAgo == null ? "Never checked against the document" : `Not checked for ${nf(a.checkedAgo)} days`}</span> : null}
              </span>
              <span style={{ display: "block", fontSize: 22, lineHeight: "28px", fontWeight: 600, color: C.ink, marginTop: 8 }}>{a.title}</span>
              <span style={{ display: "block", fontSize: 13, color: C.muted, marginTop: 4 }}>{[vm.type.name, a.entityName, a.siteName ? `${a.siteName}${a.siteState ? `, ${a.siteState}` : ""}` : null, a.docNo].filter(Boolean).join(" · ")}</span>
              {a.crit >= 3 && a.consequence ? (
                <span style={{ display: "block", fontSize: 13, lineHeight: "19px", color: C.redInk, marginTop: 10, maxWidth: 760 }}>
                  <span style={{ fontWeight: 600 }}>If this runs out: </span>
                  {a.consequence}
                </span>
              ) : null}
              {superseded && vm.newer ? <span style={{ display: "block", fontSize: 13, color: C.muted, marginTop: 10 }}>Replaced by {vm.newer.code}. This version stays in the chain.</span> : null}
            </span>
            <span style={{ textAlign: "right", flex: "none" }}>
              <span style={{ ...LBL, display: "block" }}>{cdLabel}</span>
              <span style={{ display: "block", fontSize: 40, lineHeight: "44px", fontWeight: 600, color: a.d != null && a.d < 0 ? daysColour(a.d, a.status) : C.ink, whiteSpace: "nowrap" }}>{cd}</span>
              <span style={{ display: "block", fontSize: 13, color: C.muted }}>{cdDate}</span>
              {secondary ? <span style={{ display: "block", fontSize: 12, color: C.body, marginTop: 4 }}>{secondary}</span> : null}
            </span>
          </div>
          {acts.length ? <div style={{ display: "flex", gap: 8, padding: "0 24px 16px 76px", flexWrap: "wrap" }}>{acts}</div> : null}
        </div>
      </div>

      <div style={{ padding: "16px 24px 48px 24px" }}>
        <div style={{ marginBottom: 20 }}>
          <Tabs tabs={tabs} value={tab} onPick={setTab} />
        </div>

        {tab === "details" ? (
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 340px", gap: 16, alignItems: "start" }}>
            <div style={card}>
              {F.map(([l, v, mono]) => (
                <div key={l} style={{ display: "grid", gridTemplateColumns: "220px minmax(0,1fr)", gap: 16, padding: "12px 20px", borderTop: `1px solid ${C.line3}` }}>
                  <span style={LBL}>{l}</span>
                  <span style={{ fontSize: 14, color: C.ink, fontFamily: mono ? MONO : "inherit" }}>{v}</span>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {vm.conditions ? (
                <div style={{ ...card, padding: "16px 20px" }}>
                  <div style={{ fontSize: 15, fontWeight: 600, color: C.ink }}>Conditions imposed</div>
                  <div style={{ fontSize: 13, lineHeight: "20px", color: C.body, marginTop: 6, whiteSpace: "pre-wrap" }}>{vm.conditions}</div>
                </div>
              ) : null}
              <div style={{ ...card, padding: "16px 20px" }}>
                <div style={{ fontSize: 15, fontWeight: 600, color: C.ink }}>Reminder schedule</div>
                <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{CRIT[a.crit].label} schedule · moves up owner → backup → department head → management</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
                  {vm.ladder.map((x) => {
                    const done = ad != null && ad <= -x;
                    return (
                      <span key={x} title={a.actionDate ? fd(addDays(a.actionDate, x)) : undefined} style={{ fontSize: 12, fontWeight: 500, padding: "3px 8px", borderRadius: 4, background: done ? C.ink : C.soft, color: done ? "#FFFFFF" : C.body, border: `1px solid ${done ? C.ink : C.line}` }}>
                        {(x > 0 ? `+${x}` : x === 0 ? "Day 0" : String(x)) + (x === Math.max(...vm.ladder) && x > 0 ? " daily" : "")}
                      </span>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {tab === "ownership" ? (
          <div style={{ ...card, maxWidth: 900 }}>
            {seatRow("Primary owner", "owner", a.ownerId, a.ownerName, true)}
            {seatRow("Backup owner", "backup", a.backupId, vm.backupName, a.crit >= 3)}
            {seatRow("Approver", "approver", vm.approverId, vm.approverName, false, vm.approverId ? undefined : "Who authorises the renewal spend. Optional.")}
            {seatRow("Executor", "executor", vm.executorId, vm.executorName ?? (vm.executorId ? null : null), false, vm.executorId ? undefined : `Who does the renewal work. Not set — it falls to the owner${a.ownerName ? `, ${a.ownerName}` : ""}.`)}
            <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 20px", borderTop: `1px solid ${C.line3}` }}>
              <span style={{ width: 36, height: 36, borderRadius: "50%", flex: "none", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 600, background: C.line2, color: C.body }}>EX</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ ...LBL, display: "block" }}>External contact</span>
                <span style={{ display: "block", fontSize: 15, fontWeight: 600, color: C.ink, marginTop: 2 }}>{vm.externalContact || "None recorded"}</span>
                <span style={{ display: "block", fontSize: 12, color: C.muted }}>Part of the renewal path — their absence is a single point of failure too</span>
              </span>
              {!ro ? <Btn small onClick={() => textModal("externalContact", "External contact", vm.externalContact ?? "")}>{vm.externalContact ? "Change" : "Add"}</Btn> : null}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 20px", borderTop: `1px solid ${C.line3}` }}>
              <span style={{ width: 36, height: 36, borderRadius: "50%", flex: "none", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 600, background: C.line2, color: C.body }}>DP</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ ...LBL, display: "block" }}>Department</span>
                <span style={{ display: "block", fontSize: 15, fontWeight: 600, color: C.ink, marginTop: 2 }}>{vm.department || "Not set"}</span>
                <span style={{ display: "block", fontSize: 12, color: C.muted }}>Cost and accountability are attributed here</span>
              </span>
              {!ro ? <Btn small onClick={() => textModal("department", "Department", vm.department)}>{vm.department ? "Change" : "Add"}</Btn> : null}
            </div>
          </div>
        ) : null}

        {tab === "renewal" ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 980 }}>
            <div style={{ padding: "14px 18px", background: C.soft, border: `1px solid ${C.line}`, borderRadius: 6, fontSize: 14, color: C.ink }}>
              <span style={{ fontWeight: 600 }}>{vm.type.leadDays ? `Apply at least ${vm.type.leadDays} days before end date.` : "No time needed to renew — this type never ends."}</span>{" "}
              <span style={{ color: C.body }}>{leadStart && leadIn != null ? (leadIn <= 0 ? `That date has passed — ${fd(leadStart)}.` : `Start by ${fd(leadStart)}, in ${nf(leadIn)} days.`) : ""}</span>
            </div>
            {vm.openRenewal ? (
              <div style={{ ...card, padding: "16px 20px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ flex: 1, fontSize: 15, fontWeight: 600, color: C.ink }}>
                    RC-{a.code.slice(4)} · {RENEWAL_STEPS[at]}
                  </span>
                  <Btn small kind="p" onClick={() => router.push(`/locker/assets/${a.id}/renewal`)}>
                    Open renewal task
                  </Btn>
                </div>
                <div style={{ display: "flex", gap: 4, marginTop: 14 }}>
                  {RENEWAL_STEPS.map((l, i) => (
                    <span key={l} title={l} style={{ flex: 1, height: 6, borderRadius: 3, background: i <= at ? C.brand : C.line2 }} />
                  ))}
                </div>
                <div style={{ fontSize: 12, color: C.muted, marginTop: 6 }}>
                  Assigned to {vm.openRenewal.assignedName ?? "—"} · {vm.openRenewal.ackNo ? `acknowledgement ${vm.openRenewal.ackNo}` : `${vm.openRenewal.done} of ${vm.openRenewal.total} checklist items done`}
                </div>
              </div>
            ) : null}
            <div style={{ ...card, padding: "16px 20px" }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: C.ink }}>Steps · {vm.type.name}</div>
              <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
                Issued by: {issuedBy} · typical fee {vm.type.typicalCostPaise ? inr(vm.type.typicalCostPaise) : "nil"} · typical timeline {Math.max(14, Math.round(vm.type.leadDays * 0.6))} days
              </div>
              {steps.map((p, i) => (
                <div key={i} style={{ display: "flex", gap: 10, padding: "8px 0", borderTop: `1px solid ${C.line3}`, marginTop: 6, fontSize: 14, color: C.ink }}>
                  <span style={{ color: C.muted, width: 20, flex: "none" }}>{i + 1}</span>
                  <span>{p}</span>
                </div>
              ))}
            </div>
            <div style={card}>
              <div style={{ padding: "12px 20px", borderBottom: `1px solid ${C.line2}`, fontSize: 15, fontWeight: 600, color: C.ink }}>Renewal history</div>
              {vm.history.map((h, i) => (
                <div key={i} style={{ display: "grid", gridTemplateColumns: "160px minmax(0,1fr) 120px 140px", gap: 12, padding: "10px 20px", borderTop: `1px solid ${C.line3}`, fontSize: 14 }}>
                  <span>{h.when}</span>
                  <span style={{ color: C.ink }}>Renewed · {h.docNo || a.docNo}</span>
                  <span style={{ textAlign: "right" }}>{h.cost ? inr(h.cost) : "—"}</span>
                  <span>{h.by || "—"}</span>
                </div>
              ))}
              {vm.older.map((o) => (
                <Link key={o.id} href={`/locker/assets/${o.id}`} className="lk-row" style={{ display: "grid", gridTemplateColumns: "160px minmax(0,1fr) 120px 140px", gap: 12, padding: "10px 20px", borderTop: `1px solid ${C.line3}`, fontSize: 14, textDecoration: "none", color: C.body }}>
                  <span>{fd(o.endDate)}</span>
                  <span style={{ color: C.ink }}>Earlier version · {o.docNo || o.code}</span>
                  <span style={{ textAlign: "right" }}>—</span>
                  <span>{o.code}</span>
                </Link>
              ))}
              {!vm.history.length && !vm.older.length ? <div style={{ padding: "12px 20px", fontSize: 13, color: C.muted }}>No renewal recorded in the Locker yet.</div> : null}
            </div>
          </div>
        ) : null}

        {tab === "documents" ? (
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 320px", gap: 16, alignItems: "start" }}>
            <div style={card}>
              {vm.docs.map(doc)}
              {!vm.docs.length ? <div style={{ padding: 20, fontSize: 14, color: C.muted }}>No document uploaded yet. Upload the scan of the current certificate — its SHA-256 is recorded, and any later change to the stored file is caught and refused.</div> : null}
              {!ro && !superseded ? (
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 20px", borderTop: `1px solid ${C.line2}`, background: C.canvas }}>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="application/pdf,image/png,image/jpeg,image/webp"
                    style={{ display: "none" }}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void upload(f);
                      e.target.value = "";
                    }}
                  />
                  <Btn small kind="p" onClick={() => fileRef.current?.click()}>
                    Upload a document
                  </Btn>
                  <span style={{ fontSize: 12, color: C.muted }}>{upBusy || "PDF, JPG or PNG · up to 20 MB"}</span>
                </div>
              ) : null}
            </div>
            <div style={{ ...card, padding: "16px 20px" }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: C.ink }}>Physical original</div>
              <div style={{ fontSize: 14, color: C.ink, marginTop: 8 }}>{vm.physicalLocation || (m === "subscription" ? "Digital only — no physical original" : "Not recorded")}</div>
              <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>Held by {vm.custodianName || a.ownerName || "nobody recorded"}</div>
              {!ro ? (
                <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
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
            </div>
          </div>
        ) : null}

        {tab === "credentials" && vm.vault ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 900 }}>
            {!vm.creds.length ? <div style={{ ...card, padding: 24, fontSize: 14, color: C.muted }}>No vault items are linked to this asset.</div> : null}
            {vm.creds.map((v) => (
              <div key={v.id} style={{ background: "#FFFFFF", border: `1px solid ${C.v100}`, borderRadius: 6, overflow: "hidden", boxShadow: `inset 3px 0 0 ${C.v700}` }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 20px", background: C.v50, borderBottom: `1px solid ${C.v100}` }}>
                  <span style={{ color: C.v700 }}>◈</span>
                  <Link href={`/locker/vault/${v.id}`} style={{ flex: 1, fontSize: 14, fontWeight: 600, color: C.v900, textDecoration: "none" }}>
                    {v.title}
                  </Link>
                  <TierPill tier={v.tier as "standard" | "sensitive" | "restricted"} />
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "120px minmax(0,1fr) auto", gap: 12, alignItems: "center", minHeight: 48, padding: "0 20px" }}>
                  <span style={LBL}>Secret</span>
                  <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, overflow: "hidden" }}>
                    <span style={{ fontFamily: MONO, fontSize: 15, lineHeight: "20px", letterSpacing: "0.08em", color: C.v700, whiteSpace: "nowrap" }}>••••••••••••</span>
                    <span style={{ fontSize: 12, lineHeight: "16px", color: C.muted, fontFamily: MONO }}>ends ····{v.hint ?? "··"}</span>
                  </span>
                  <Link href={`/locker/vault/${v.id}`} style={{ height: 32, padding: "0 14px", border: "none", background: C.v700, borderRadius: 4, color: "#FFFFFF", fontSize: 13, fontWeight: 500, display: "inline-flex", alignItems: "center", textDecoration: "none" }}>
                    Reveal
                  </Link>
                </div>
                <div style={{ padding: "0 20px 12px 20px", fontSize: 12, color: C.muted }}>
                  {v.rotated ? `Changed ${v.rotated}` : "Never changed in the Locker"} · {v.lastReveal ? `last revealed ${v.lastReveal}` : "never revealed"}
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {tab === "dependencies" ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: 16, maxWidth: 1080 }}>
            {[
              {
                l: "This relies on",
                sub: "Passwords & keys, payment methods and sign-in accounts it needs",
                items: [
                  ...vm.creds.map((c) => ({ key: c.id, t: c.title, m: c.auth === "federated_sso" ? `Signs in via ${c.viaEmail ?? "—"}` : "Direct login", b: c.sole ? <Pill label="Only way in" bg={C.redSoft} fg={C.red} /> : <Pill label="Login" bg={C.v50} fg={C.v700} />, href: `/locker/vault/${c.id}` })),
                  ...(vm.paymentMethod
                    ? [
                        {
                          key: vm.paymentMethod.id,
                          t: `${vm.paymentMethod.label} ····${vm.paymentMethod.last4}`,
                          m: `Pays this subscription${vm.paymentMethod.expiresOn ? ` · expires ${fd(vm.paymentMethod.expiresOn)}` : ""}`,
                          b: vm.paymentMethod.expiresOn && a.endDate && vm.paymentMethod.expiresOn < a.endDate ? <Pill label="Expires first" bg={C.amberSoft} fg={C.amber} /> : <Pill label="Payment" bg={C.soft} fg={C.body} />,
                          href: undefined as string | undefined,
                        },
                      ]
                    : []),
                ],
              },
              { l: "Relies on this", sub: "What stops or becomes invalid if this runs out", items: vm.reliesOnThis.map((x) => ({ key: x.id, t: x.title, m: "Assumes this licence is valid", b: <StatusPill status={x.status} />, href: `/locker/assets/${x.id}` as string | undefined })) },
            ].map((g) => (
              <div key={g.l} style={card}>
                <div style={{ padding: "12px 20px", borderBottom: `1px solid ${C.line2}` }}>
                  <div style={{ fontSize: 15, fontWeight: 600, color: C.ink }}>{g.l}</div>
                  <div style={{ fontSize: 12, color: C.muted }}>{g.sub}</div>
                </div>
                {g.items.map((i) => {
                  const inner = (
                    <>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: "block", fontSize: 14, fontWeight: 500, color: C.ink }}>{i.t}</span>
                        <span style={{ display: "block", fontSize: 12, color: C.muted }}>{i.m}</span>
                      </span>
                      {i.b}
                    </>
                  );
                  const st: CSSProperties = { display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "10px 20px", borderTop: `1px solid ${C.line3}`, background: "#FFFFFF", textDecoration: "none" };
                  return i.href ? (
                    <Link key={i.key} href={i.href} className="lk-row" style={st}>
                      {inner}
                    </Link>
                  ) : (
                    <div key={i.key} style={st}>
                      {inner}
                    </div>
                  );
                })}
                {!g.items.length ? <div style={{ padding: "14px 20px", fontSize: 13, color: C.muted }}>Nothing recorded.</div> : null}
              </div>
            ))}
          </div>
        ) : null}

        {tab === "activity" ? (
          <div style={{ ...card, maxWidth: 1080 }}>
            {vm.activity.map((x, i) => (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "170px 170px minmax(0,1fr)", gap: 12, padding: "10px 20px", borderTop: `1px solid ${C.line3}`, fontSize: 13 }}>
                <span style={{ color: C.muted }}>{x.at}</span>
                <span style={{ color: C.ink, fontWeight: 500 }}>{x.who}</span>
                <span style={{ color: C.body }}>{x.t}</span>
              </div>
            ))}
            {!vm.activity.length ? <div style={{ padding: 20, fontSize: 14, color: C.muted }}>Nothing recorded yet.</div> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
