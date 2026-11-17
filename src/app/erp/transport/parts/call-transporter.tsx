"use client";

import { useEffect, useState } from "react";
import { Button, checkboxClass, cx, Field, Input, SectionLabel, Select, Td, Textarea, Th, Tr } from "@/components/ui/primitives";
import { erpLogisticsCallHistory, erpLogisticsLogCall } from "@/lib/actions/erp-logistics";
import { addDays, ROAD_STAGES, shortDay, STAGE_SHORT, type Stage } from "@/lib/erp/engines/logistics";
import { lrChange, OUTCOME_LABEL, OUTCOME_TAG, outcomesFor, SOURCE_LABEL, type CallOutcome, type CallSource } from "@/lib/erp/engines/transporter-calls";
import type { Consignment } from "@/lib/erp/logistics";
import type { CallHistory } from "@/lib/erp/transporter-calls";
import { phoneDisplay, stamp } from "@/lib/format";
import { Badge } from "../../_ui/badge";
import { DialogBody, DialogFooter, DialogHeader, DialogTitle, ErpDialog } from "../../_ui/dialog";
import { Icon } from "../../_ui/icons";
import { toggleClass } from "../../_ui/look";
import { lrLabel, plural, useAct } from "./common";

/* ---------------------------------------------------------------------------
 * CALL A TRANSPORTER — one window for one call, however many LRs it covers.
 *
 * Who to ring is here and nowhere else: the list shows no numbers, because a
 * number on every row is a number nobody reads, and the choice that matters is
 * which transporter to ring, not how. Then how it went — four answers, and the
 * window shows only what that answer needs. "Gave an update" opens one row per
 * LR; "nothing new" is what the old "Called — no change" button did; the two
 * that reached nobody leave the calls due. Beside it, every earlier call.
 * ------------------------------------------------------------------------- */

export type TransporterContact = { id: string | null; name: string | null; role: string | null; where: string | null; phones: string[] };
type Group = { key: string; bills: Consignment[] };
type RowState = { stage: string; city: string; expected: string; pickup: string; notify: boolean };

export function CallTransporterDialog({
  transporter,
  own,
  groups,
  contacts,
  today,
  callEveryDays,
  notifyOn,
  canWrite,
  onClose,
}: {
  transporter: string;
  own: boolean;
  groups: Group[];
  contacts: TransporterContact[];
  today: string;
  callEveryDays: number;
  notifyOn: boolean;
  canWrite: boolean;
  onClose: () => void;
}) {
  const { run, pending } = useAct();
  const [source, setSource] = useState<CallSource>("call");
  const [outcome, setOutcome] = useState<CallOutcome | null>(null);
  const [contactAt, setContactAt] = useState(0);
  const [spokeTo, setSpokeTo] = useState(contacts[0]?.name ?? "");
  const [nextCall, setNextCall] = useState(addDays(today, callEveryDays));
  const [note, setNote] = useState("");
  const [rows, setRows] = useState<Record<string, RowState>>(() =>
    Object.fromEntries(groups.map((g) => [g.key, { stage: g.bills[0].stage, city: "", expected: g.bills[0].expectedDeliveryOn ?? "", pickup: g.bills[0].pickupPoint ?? "", notify: notifyOn }])),
  );
  const [history, setHistory] = useState<CallHistory | null>(null);
  const [historyError, setHistoryError] = useState("");
  const [tab, setTab] = useState<"all" | "calls" | "them">("all");

  useEffect(() => {
    let live = true;
    erpLogisticsCallHistory(transporter).then(
      (r) => {
        if (!live) return;
        if (r.ok) setHistory(r.data);
        else setHistoryError(r.error);
      },
      () => live && setHistoryError("The history could not be read."),
    );
    return () => {
      live = false;
    };
  }, [transporter]);

  const who = own ? "driver" : "transporter";
  const bills = groups.flatMap((g) => g.bills);
  const stages = own ? ROAD_STAGES.filter((s) => s !== "Ready for Pickup") : ROAD_STAGES;
  const changeOf = (g: Group) => {
    const r = rows[g.key];
    const b = g.bills[0];
    return lrChange({ lrNo: b.lrNo, stage: b.stage, expectedOn: b.expectedDeliveryOn }, { stage: r.stage, city: r.city, expectedOn: r.expected });
  };
  const changed = groups.filter((g) => changeOf(g));
  const telling = changed.filter((g) => rows[g.key].notify).length;
  const missingPickup = changed.some((g) => rows[g.key].stage === "Ready for Pickup" && !rows[g.key].pickup.trim());

  const pickOutcome = (o: CallOutcome) => {
    setOutcome(o);
    /* Each answer opens on the day it usually means: news books the usual gap, a call-back today, no answer leaves the call due. */
    setNextCall(o === "no_answer" ? "" : o === "call_back" ? today : addDays(today, callEveryDays));
  };
  const pickSource = (s: CallSource) => {
    setSource(s);
    if (outcome && !outcomesFor(s).includes(outcome)) setOutcome(null);
  };
  const setRow = (key: string, patch: Partial<RowState>) => setRows((all) => ({ ...all, [key]: { ...all[key], ...patch } }));

  const blocked = !outcome ? "Say how the call went." : outcome === "update" && !changed.length ? "Nothing has moved yet — change a row, or pick “Answered — nothing new”." : missingPickup ? "Say where the party collects it." : outcome === "call_back" && !nextCall ? "Say when to call back." : null;

  const footNote = !outcome
    ? `${plural(groups.length, "LR")} · ${plural(bills.length, "bill")}`
    : outcome === "update"
      ? `${plural(changed.length, "LR")} changed${telling && notifyOn ? ` · ${plural(telling, "customer")} will be told` : " · nobody is messaged"}`
      : outcome === "no_change"
        ? `Nothing moves · next call ${nextCall ? shortDay(nextCall) : "as usual"} · nobody is messaged`
        : nextCall
          ? `Logs the attempt · ring again ${shortDay(nextCall)}`
          : "Logs the attempt · the calls stay due";

  const save = () => {
    if (!outcome) return;
    const c = contacts[contactAt];
    run(
      () =>
        erpLogisticsLogCall({
          transporter,
          transportIds: bills.map((b) => b.id),
          outcome,
          source,
          contactId: source === "call" ? (c?.id ?? null) : null,
          spokeTo: source === "call" ? spokeTo : null,
          phone: source === "call" ? (c?.phones[0] ?? null) : null,
          note,
          nextCallOn: nextCall || null,
          lrs:
            outcome === "update"
              ? changed.map((g) => {
                  const r = rows[g.key];
                  return { transportIds: g.bills.map((b) => b.id), stage: r.stage, city: r.city, expectedOn: r.expected, pickupPoint: r.pickup, notify: r.notify };
                })
              : undefined,
        }),
      (r) => r.ok && onClose(),
    );
  };

  const shown = (history?.rows ?? []).filter((h) => (tab === "all" ? true : tab === "calls" ? h.source === "call" : h.source !== "call"));
  const due = groups.filter((g) => g.bills.some((b) => b.nextCallOn && b.nextCallOn <= today)).length;

  return (
    <ErpDialog onClose={onClose} label={`Call ${transporter}`} size="xl">
      <DialogHeader onClose={onClose}>
        <DialogTitle>Call {transporter}</DialogTitle>
        <div className="text-meta text-muted">
          {plural(groups.length, own ? "trip" : "LR")} on the road · {plural(bills.length, "bill")}
          {due ? ` · ${plural(due, "call")} due` : ""}
        </div>
      </DialogHeader>
      <div className="flex min-h-0 flex-1">
        <DialogBody className="flex-1 border-r border-divider">
          <div className="grid gap-2">
            <SectionLabel>How the news came</SectionLabel>
            <div className="flex flex-wrap gap-2">
              {(["call", "whatsapp", "tracking"] as CallSource[]).map((s) => (
                <button key={s} type="button" aria-pressed={source === s} onClick={() => pickSource(s)} className={toggleClass(source === s)}>
                  {SOURCE_LABEL[s]}
                </button>
              ))}
            </div>
          </div>

          {source === "call" ? (
            <div className="grid gap-2">
              <SectionLabel>Who to ring</SectionLabel>
              {contacts.length ? (
                <div className="grid grid-cols-2 gap-2">
                  {contacts.map((c, i) => (
                    <div key={c.id ?? i} className={cx("flex items-center gap-3 rounded-card border px-3 py-2.5", i === contactAt ? "border-brand bg-brand-soft/40" : "border-line bg-surface")}>
                      <button
                        type="button"
                        onClick={() => {
                          setContactAt(i);
                          setSpokeTo(c.name ?? "");
                        }}
                        className="min-w-0 flex-1 cursor-pointer text-left"
                      >
                        <div className="truncate text-sm font-semibold text-ink">{[c.name ?? "No name", c.role].filter(Boolean).join(" · ")}</div>
                        <div className="truncate text-meta text-muted">{c.where ?? (own ? "Driver" : "Transporter")}</div>
                      </button>
                      <div className="flex flex-none flex-col items-end gap-1">
                        {c.phones.map((p, j) => (
                          <a
                            key={p}
                            href={`tel:${p.replace(/[^\d+]/g, "")}`}
                            onClick={() => {
                              setContactAt(i);
                              setSpokeTo(c.name ?? "");
                            }}
                            className={cx("inline-flex items-center gap-1.5 rounded-control px-2.5 py-1.5 text-meta font-semibold", j === 0 ? "bg-success text-white" : "border border-line text-body")}
                          >
                            <Icon n="phone" s={13} />
                            {phoneDisplay(p)}
                          </a>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-card border border-dashed border-line px-3 py-2.5 text-meta text-muted">{own ? "No driver's number was recorded at dispatch." : "No number for this transporter — add one under Transporters."}</div>
              )}
            </div>
          ) : null}

          <div className="grid gap-2">
            <SectionLabel>{source === "call" ? "How did the call go?" : "What did it say?"}</SectionLabel>
            <div role="radiogroup" aria-label="How it went" className="grid grid-cols-4 gap-2">
              {outcomesFor(source).map((o) => (
                <button key={o} type="button" role="radio" aria-checked={outcome === o} onClick={() => pickOutcome(o)} className={cx(toggleClass(outcome === o), "h-auto justify-center py-2.5 text-center whitespace-normal")}>
                  {OUTCOME_LABEL[o]}
                </button>
              ))}
            </div>
          </div>

          {outcome === "update" ? (
            <div className="grid gap-2">
              <div className="flex items-baseline gap-2">
                <SectionLabel>What they said about each {own ? "trip" : "LR"}</SectionLabel>
                <span className="text-meta text-muted">Leave a row as it is if nothing changed</span>
              </div>
              <div className="overflow-x-auto rounded-card border border-line">
                <table className="w-full min-w-[640px] border-collapse text-sm">
                  <thead>
                    <Tr>
                      <Th>{own ? "Vehicle · party" : "LR · party"}</Th>
                      <Th>Now at</Th>
                      <Th>Stage</Th>
                      <Th>Expected</Th>
                      <Th>Tell</Th>
                    </Tr>
                  </thead>
                  <tbody>
                    {groups.map((g) => {
                      const b = g.bills[0];
                      const r = rows[g.key];
                      const what = changeOf(g);
                      return (
                        <Tr key={g.key} className={what ? "bg-brand-soft/30" : ""}>
                          <Td className="align-top">
                            <div className="font-mono font-medium text-ink">{own ? (b.vehicleNo ?? "Vehicle") : lrLabel(b.lrNo)}</div>
                            <div className="max-w-[180px] truncate text-meta text-muted" title={[...new Set(g.bills.map((x) => x.party))].join(", ")}>
                              {[...new Set(g.bills.map((x) => x.party))].join(", ")}
                            </div>
                            {what ? <div className="mt-0.5 text-2xs text-brand-hover">{what}</div> : null}
                          </Td>
                          <Td className="align-top">
                            <Input aria-label="Now at" value={r.city} onChange={(e) => setRow(g.key, { city: e.target.value })} placeholder={b.currentCity ?? "City"} className="w-[120px]" />
                          </Td>
                          <Td className="align-top">
                            <Select aria-label="Stage" value={r.stage} onChange={(e) => setRow(g.key, { stage: e.target.value })}>
                              {!stages.includes(b.stage as Stage) ? <option value={b.stage}>{STAGE_SHORT[b.stage as Stage] ?? b.stage}</option> : null}
                              {stages.map((s) => (
                                <option key={s} value={s}>
                                  {STAGE_SHORT[s]}
                                </option>
                              ))}
                            </Select>
                            {r.stage === "Ready for Pickup" ? <Input aria-label="Collect from" value={r.pickup} onChange={(e) => setRow(g.key, { pickup: e.target.value })} placeholder="Collect from…" className="mt-1.5" /> : null}
                          </Td>
                          <Td className="align-top">
                            <Input aria-label="Expected" type="date" value={r.expected} min={today} onChange={(e) => setRow(g.key, { expected: e.target.value })} className="w-[140px]" />
                          </Td>
                          <Td className="align-top">
                            {what ? (
                              <label className="inline-flex items-center gap-1.5 text-meta" title={notifyOn ? "Send the customer a WhatsApp about this" : "Customer messages are switched off in settings"}>
                                <input type="checkbox" className={checkboxClass} checked={r.notify && notifyOn} disabled={!notifyOn} onChange={(e) => setRow(g.key, { notify: e.target.checked })} />
                                WhatsApp
                              </label>
                            ) : (
                              <span className="text-meta text-muted">—</span>
                            )}
                          </Td>
                        </Tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-meta text-muted">The godown it left from and pickup contacts are on each LR&apos;s own Update.</p>
            </div>
          ) : null}

          {outcome === "no_change" ? (
            <div className="rounded-card border border-divider bg-canvas px-3.5 py-3 text-sm text-body">
              Nothing moves on the {plural(groups.length, own ? "trip" : "LR")}. The call is recorded and the next one booked. Customers are not messaged.
            </div>
          ) : null}
          {outcome === "no_answer" || outcome === "call_back" ? (
            <div className="rounded-card border border-warn-line bg-warn-soft px-3.5 py-3 text-sm text-warn-ink">
              {outcome === "no_answer" ? "The calls stay due. Pick a day below only if you want to try again later rather than today." : "The calls move to the day they asked you to ring."}
            </div>
          ) : null}

          {outcome ? (
            <div className="grid grid-cols-2 gap-3">
              {source === "call" && (outcome === "update" || outcome === "no_change") ? (
                <Field label="Spoke to" optional>
                  <Input value={spokeTo} onChange={(e) => setSpokeTo(e.target.value)} placeholder={`Who at the ${who}`} />
                </Field>
              ) : (
                <div />
              )}
              <Field label={outcome === "call_back" ? "Call back on" : "Next call"} required={outcome === "call_back"} optional={outcome === "no_answer"}>
                <Input type="date" value={nextCall} min={today} onChange={(e) => setNextCall(e.target.value)} />
              </Field>
              <div className="col-span-2">
                <Field label="Note" optional>
                  <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={outcome === "update" ? "Anything else they said — kept with the call, not sent to the customer" : ""} />
                </Field>
              </div>
            </div>
          ) : null}
        </DialogBody>

        <aside aria-label="Call history" className="flex w-[360px] flex-none flex-col bg-canvas/60">
          <div className="grid gap-3 px-5 pt-5 pb-3">
            <div className="flex items-baseline gap-2">
              <span className="text-md font-semibold text-ink">Call history</span>
              <span className="text-meta text-muted">last 60 days</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Figure value={history ? (history.stats.answeredPct == null ? "—" : `${history.stats.answeredPct}%`) : "…"} label="answered" />
              <Figure value={history ? String(history.stats.calls) : "…"} label="calls · 30 d" />
              <Figure value={history ? String(history.stats.datesMoved) : "…"} label="dates moved" />
            </div>
            <div role="tablist" className="flex gap-1.5">
              {(
                [
                  ["all", "Everything"],
                  ["calls", "Our calls"],
                  ["them", "From them"],
                ] as const
              ).map(([k, l]) => (
                <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={toggleClass(tab === k, "h-7 rounded-full text-xs")}>
                  {l}
                </button>
              ))}
            </div>
          </div>
          <ol className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
            {historyError ? <li className="text-meta text-danger">{historyError}</li> : null}
            {!history && !historyError ? <li className="text-meta text-muted">Reading…</li> : null}
            {history && !shown.length ? <li className="text-meta text-muted">{history.rows.length ? "Nothing of that kind." : "No calls logged yet. Every call saved from this window is kept here."}</li> : null}
            {shown.map((h) => (
              <li key={h.id} className="flex gap-3">
                <div className="flex w-3 flex-none flex-col items-center">
                  <span className={cx("mt-1 block h-2.5 w-2.5 rounded-full", h.source !== "call" ? "bg-brand" : h.outcome === "no_answer" ? "bg-danger" : h.outcome === "call_back" ? "bg-warn" : "bg-success")} />
                  <span className="my-0.5 w-0.5 flex-1 bg-line" />
                </div>
                <div className="min-w-0 flex-1 pb-4">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs font-semibold text-ink">{stamp(h.at)}</span>
                    <Badge label={h.source === "call" ? OUTCOME_TAG[h.outcome] : SOURCE_LABEL[h.source]} tone={h.source !== "call" ? "brand" : h.outcome === "no_answer" ? "danger" : h.outcome === "call_back" ? "warn" : "success"} />
                  </div>
                  <div className="text-meta text-muted">{[h.by ? `By ${h.by}` : null, h.spokeTo ? `spoke to ${h.spokeTo}` : null, plural(h.lrCount, "bill")].filter(Boolean).join(" · ")}</div>
                  {h.note ? <div className="mt-1 text-sm text-body">{h.note}</div> : null}
                  {h.changes.length ? (
                    <div className="mt-1.5 grid gap-0.5 rounded-control border border-divider bg-surface px-2 py-1.5 text-meta text-body">
                      {h.changes.map((c, i) => (
                        <div key={i}>
                          <span className="font-mono">{c.lrNo ?? "—"}</span> · {c.what}
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {h.nextCallOn ? <div className="mt-1 text-2xs text-muted">Next call {shortDay(h.nextCallOn)}</div> : null}
                </div>
              </li>
            ))}
          </ol>
        </aside>
      </div>
      <DialogFooter left={blocked && outcome ? blocked : footNote}>
        <Button onClick={onClose}>Cancel</Button>
        {canWrite ? (
          <Button variant="primary" disabled={pending || !!blocked} onClick={save}>
            {outcome === "update" ? "Save update" : outcome === "no_change" ? "Save — nothing new" : outcome ? "Save attempt" : "Save"}
          </Button>
        ) : null}
      </DialogFooter>
    </ErpDialog>
  );
}

function Figure({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-card border border-divider bg-surface px-2.5 py-2">
      <div className="text-lg font-bold text-ink tabular-nums">{value}</div>
      <div className="text-2xs text-muted">{label}</div>
    </div>
  );
}
