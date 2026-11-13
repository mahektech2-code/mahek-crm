"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { addDays } from "@/lib/format";
import { completeRenewal, startRenewal, updateRenewal, type RenewalPatch } from "@/lib/actions/locker-assets";
import { CRIT, RENEWAL_STEPS, daysLabel, endFromValidity } from "@/lib/locker/engine";
import type { TimeModel } from "@/lib/locker/catalogue";
import type { AssetLite } from "@/lib/locker/lite";
import { Button, Card, buttonClass, controlClass, cx } from "@/components/ui/primitives";
import { Btn, C, PageHead, Pill, fd, inr, nf, useModal, useToast } from "../../../_ui/kit";
import { Alert, ListBlock, Stat, StatGrid, type ListItem } from "../../../_ui/register-parts";

/* ---------------------------------------------------------------------------
 * A RENEWAL TASK — spec §7.2. Nine steps, advanced one at a time and each
 * move recorded; the type's own steps as a checklist; who is doing it, when
 * it was applied for and the acknowledgement; cost; notes. Completing it
 * takes the new end date and number from the renewed document and creates
 * the new version, marking this one replaced.
 * ------------------------------------------------------------------------- */

type R = { id: string; step: number; checklist: { text: string; done: boolean; by?: string; at?: string }[]; assignedToId: string | null; assignedName: string | null; appliedOn: string | null; ackNo: string | null; costPaise: number; notes: { who: string; at: string; t: string }[] };

export function RenewalScreen(p: {
  a: AssetLite;
  typeName: string;
  authority: string;
  leadDays: number;
  validityMonths: number;
  typicalCost: number;
  model: TimeModel;
  approverName: string | null;
  externalContact: string | null;
  paymentMethod: string | null;
  stage: string | null;
  newer: { id: string; endDate: string | null } | null;
  lastCompleted: { at: string } | null;
  renewal: R | null;
  people: { id: string; name: string }[];
  canEdit: boolean;
  today: string;
}) {
  const router = useRouter();
  const modal = useModal();
  const toast = useToast();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [newEnd, setNewEnd] = useState<string>(() => (p.a.endDate && p.validityMonths ? endFromValidity(addDays(p.a.endDate, 1), p.validityMonths, "months") : ""));
  const [newDoc, setNewDoc] = useState("");
  const [fileId, setFileId] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const a = p.a;
  const r = p.renewal;
  const ro = !p.canEdit;

  const save = async (patch: RenewalPatch) => {
    if (!r || busy) return;
    setBusy(true);
    const res = await updateRenewal(r.id, patch);
    setBusy(false);
    if (!res.ok) return toast(res.error);
    router.refresh();
  };

  if (!r) {
    if (p.stage === "superseded" && p.newer) {
      return (
        <>
          <PageHead crumb="Locker · Renewals" title={`Renewal complete · ${a.title}`} />
          <div className="px-6 pb-12">
            <Alert
              tone="green"
              t="The new document replaces the old one"
              m={`The renewed ${p.typeName.toLowerCase()} is now the current version${p.newer.endDate ? `, valid until ${fd(p.newer.endDate)}` : ""}. The previous one is marked replaced and stays in the chain, so an audit can show continuous validity.`}
              actions={
                <Link href={`/locker/assets/${p.newer.id}`} className={buttonClass({ size: "sm" })}>
                  Open the new version
                </Link>
              }
            />
          </div>
        </>
      );
    }
    return (
      <>
        <PageHead crumb="Locker · Renewals" title={`Renewal task · ${a.title}`} sub="No renewal is under way for this asset." />
        <div className="px-6 pb-12">
          <Alert
            t="Nothing started yet"
            m={`Starting copies the ${p.typeName} steps into a checklist and puts the asset in “Renewal in progress”.`}
            actions={
              ro ? undefined : (
                <Btn
                  kind="p"
                  onClick={async () => {
                    const res = await startRenewal(a.id);
                    if (!res.ok) return toast(res.error);
                    router.refresh();
                  }}
                >
                  Start renewal
                </Btn>
              )
            }
          />
        </div>
      </>
    );
  }

  const at = r.step;
  const all = r.checklist.every((c) => c.done);
  const complete = async () => {
    if (busy) return;
    setBusy(true);
    const res = await completeRenewal(r.id, { newEndDate: p.model === "perpetual" ? newEnd || null : newEnd, newDocNo: newDoc, attachmentId: fileId });
    setBusy(false);
    if (!res.ok) return toast(res.error);
    toast(res.message ?? "Renewal complete");
    router.push(`/locker/assets/${res.data.id}`);
  };
  const upload = async (f: File) => {
    setFileName(`Uploading ${f.name}…`);
    const fd2 = new FormData();
    fd2.append("file", f);
    const res = await fetch(`/api/locker/assets/${a.id}/documents?bind=0`, { method: "POST", body: fd2 }).then((x) => x.json()).catch(() => ({ ok: false, error: "The upload did not reach the server." }));
    if (!res.ok) {
      setFileName("");
      return toast(res.error);
    }
    setFileId(res.data.id);
    setFileName(f.name);
  };

  const inp = controlClass({ className: "h-8.5" });
  const lbl = "ui-field-label mb-1 block text-xs font-medium tracking-label text-muted uppercase";
  const cardTitle = "text-base font-semibold text-ink";

  return (
    <>
      <PageHead
        crumb="Locker · Renewals"
        title={`Renewal task · ${a.title}`}
        sub={`RC-${a.code.slice(4)} · ${daysLabel(a.d)} · ${CRIT[a.crit].label}${a.consequence ? ` · If this runs out: ${a.consequence}` : ""}`}
        actions={<Btn onClick={() => router.push(`/locker/assets/${a.id}?tab=renewal`)}>Open asset</Btn>}
      />
      <div className="flex flex-col gap-5 px-6 pb-12">
        <StatGrid n={4}>
          <Stat l={(a.d ?? 0) < 0 ? "Overdue by" : "Days remaining"} v={a.d == null ? "—" : nf(Math.abs(a.d))} s={fd(a.endDate)} red={a.d != null && a.d < 30} />
          <Stat l="Estimated cost" v={inr(r.costPaise || p.typicalCost)} s={r.costPaise ? "recorded on this task" : "typical fee"} />
          <Stat l="Approver" v={p.approverName ?? "—"} s={p.approverName ? "authorises the spend" : "none named on the asset"} />
          <Stat l="Stage" v={`${at + 1} of 9`} s={RENEWAL_STEPS[at]} bar={(at / 8) * 100} />
        </StatGrid>
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
          <ListBlock
            title="Status"
            sub="Advance one step at a time. Each move is recorded."
            items={RENEWAL_STEPS.map((x, i): ListItem => ({
              t: x,
              strong: i === at,
              badge: i < at ? <Pill tone="success" label="Done" /> : i === at ? <Pill tone="brand" label="Current" /> : undefined,
              edge: i === at ? C.brand : null,
              bg: i === at ? "brand" : undefined,
            })).concat(
              ro
                ? ([] as ListItem[])
                : ([
                    at >= 7
                      ? {
                          t: "Ready to complete",
                          strong: false,
                          sub: "Enter the renewed document's details below.",
                          badge: undefined,
                          edge: null,
                          bg: undefined,
                        }
                      : {
                          t: `Move to ${RENEWAL_STEPS[at + 1]}`,
                          strong: false,
                          sub: at + 1 >= 3 && !r.appliedOn ? "Record the date it was applied for first (Case details)." : "",
                          badge: (
                            <span className="flex gap-1.5">
                              {at > 1 ? (
                                <Btn small onClick={() => save({ step: at - 1 })}>
                                  Back
                                </Btn>
                              ) : null}
                              <Btn small kind="p" disabled={busy || (at + 1 >= 3 && !r.appliedOn)} why="Record the applied date first" onClick={() => save({ step: at + 1 })}>
                                Advance
                              </Btn>
                            </span>
                          ),
                          edge: null,
                          bg: undefined,
                        },
                  ] as ListItem[]),
            )}
          />
          <ListBlock
            title={`Steps · ${p.typeName}`}
            sub={`Issued by: ${p.authority} · applying must start ${p.leadDays} days before expiry`}
            items={r.checklist.map((c, i) => ({
              t: c.text,
              sub: c.done && c.by ? `Ticked by ${c.by}` : undefined,
              lead: <input type="checkbox" checked={c.done} disabled={ro || busy} onChange={() => save({ toggle: i })} className="mt-px h-[18px] w-[18px] flex-none cursor-pointer accent-brand disabled:cursor-not-allowed" />,
            }))}
          />
          <Card className="overflow-hidden">
            <div className={cx(cardTitle, "border-b border-divider px-5 py-3")}>Case details</div>
            {[
              { t: "Assigned to", v: r.assignedName ?? "Unassigned", edit: () => modal({ title: "Assign the renewal", sub: a.title, fields: [{ k: "p", l: "Person", type: "select", opts: [{ v: "", l: "Nobody" }].concat(p.people.map((x) => ({ v: x.id, l: x.name }))), init: r.assignedToId ?? "" }], okL: "Save", done: async (v) => void (await save({ assignedToId: v.p || null })) }) },
              { t: "Applied on", v: r.appliedOn ? fd(r.appliedOn) : "Recorded when submitted", edit: () => modal({ title: "When was it applied for?", sub: "Applying on time is what keeps you safe in law — it moves the asset to “Renewal applied”.", fields: [{ k: "d", l: "Applied on", type: "date", req: true, init: r.appliedOn ?? p.today }], okL: "Save", done: async (v) => void (await save({ appliedOn: v.d })) }) },
              { t: "Application number", v: r.ackNo ?? "Recorded when submitted", edit: () => modal({ title: "Acknowledgement or application number", sub: a.title, fields: [{ k: "n", l: "Number", req: true, init: r.ackNo ?? "" }], okL: "Save", done: async (v) => void (await save({ ackNo: v.n })) }) },
              { t: "Cost", v: r.costPaise ? inr(r.costPaise) : "—", edit: () => modal({ title: "What did it cost?", sub: "Fee, challan and any agent's charge.", fields: [{ k: "c", l: "Amount · ₹", type: "number", req: true, init: r.costPaise ? String(r.costPaise / 100) : "" }], okL: "Save", done: async (v) => void (await save({ costRupees: Number(v.c) })) }) },
              { t: "Payment method", v: p.paymentMethod ?? "Not recorded on the asset", edit: null },
              { t: "Approver", v: p.approverName ?? "Department head", edit: null },
              { t: "External contact", v: p.externalContact ?? "None recorded", edit: null },
            ].map((row) => (
              <div key={row.t} className="flex items-center gap-3 border-t border-divider px-5 py-3 first:border-t-0">
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-ink">{row.t}</span>
                  <span className="mt-0.5 block text-xs text-muted">{row.v}</span>
                </span>
                {row.edit && !ro ? (
                  <Btn small onClick={row.edit}>
                    Change
                  </Btn>
                ) : null}
              </div>
            ))}
          </Card>
          <Card className="overflow-hidden">
            <div className="border-b border-divider px-5 py-3">
              <div className={cardTitle}>Notes</div>
              <div className="text-xs text-muted">{r.notes.length} notes</div>
            </div>
            <div className="flex flex-col gap-3 px-5 py-4">
              {r.notes.slice(-6).map((n, i) => (
                <div key={i} className="text-[13px] text-body">
                  <span className="font-semibold text-ink">{n.who}</span> <span className="text-muted">{n.at}</span>
                  <div>{n.t}</div>
                </div>
              ))}
              {!ro ? (
                <>
                  <label className="block">
                    <span className={lbl}>Add a note</span>
                    <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="What happened, who you spoke to, what is next" className={controlClass({ className: "resize-y py-2 leading-[21px]" })} />
                  </label>
                  <div className="flex justify-end">
                    <Btn
                      small
                      kind="p"
                      disabled={!note.trim()}
                      why="Write the note first"
                      onClick={async () => {
                        await save({ note });
                        setNote("");
                      }}
                    >
                      Add note
                    </Btn>
                  </div>
                </>
              ) : null}
            </div>
          </Card>
          {at >= 7 && !ro ? (
            <Card className="col-span-full overflow-hidden">
              <div className="border-b border-divider px-5 py-3">
                <div className={cardTitle}>Complete the renewal</div>
                <div className="text-xs text-muted">From the renewed document in your hand. The new version replaces this one; this one stays in the chain.</div>
              </div>
              <div className="grid grid-cols-1 items-end gap-3.5 px-5 py-4 md:grid-cols-3">
                <label>
                  <span className={lbl}>New end date {p.model === "perpetual" ? "· optional" : ""}</span>
                  <input type="date" value={newEnd} onChange={(e) => setNewEnd(e.target.value)} className={inp} />
                </label>
                <label>
                  <span className={lbl}>New document number</span>
                  <input value={newDoc} onChange={(e) => setNewDoc(e.target.value)} placeholder={a.docNo} className={inp} />
                </label>
                <div>
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
                  <Btn onClick={() => fileRef.current?.click()}>{fileId ? "Replace the scan" : "Upload the renewed document"}</Btn>
                  <div className="mt-1 text-xs text-muted">{fileName || "Optional · its SHA-256 is recorded"}</div>
                </div>
              </div>
              <div className="flex items-center justify-end gap-2 px-5 pb-4">
                {!all ? <span className="text-[13px] text-warn-ink">Tick every step first.</span> : null}
                <Button
                  variant={all && !busy && (newEnd || p.model === "perpetual") ? "primary" : "secondary"}
                  onClick={complete}
                  title={!all ? "Tick every step first" : ""}
                  aria-disabled={!(all && !busy && (newEnd || p.model === "perpetual")) || undefined}
                  className={cx(!(all && !busy && (newEnd || p.model === "perpetual")) && "cursor-not-allowed bg-canvas text-faint")}
                >
                  {busy ? "Completing…" : "Complete renewal"}
                </Button>
              </div>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
