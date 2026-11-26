"use client";

import { CardGrid } from "@/components/ui/card-grid";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { addShipmentAction, courierEventAction } from "@/lib/hire/actions/onboarding";
import { COURIER_FLOW, COURIER_STATUS_LABEL, courierOverall, type CourierStatus } from "@/lib/hire/engines/onboarding";
import { Btn, Callout, Label, Locked, Panel, Pill, fd, type Tone } from "../_ui/kit";

export type ShipmentView = {
  id: string;
  direction: "outbound" | "return";
  company: string | null;
  trackingNo: string | null;
  status: string;
  dueOn: string | null;
  docs: string[];
  events: { status: string; on: string; remarks: string | null; by: string | null }[];
};

const inputCls = "h-9 w-full rounded-[4px] border border-line-strong bg-surface px-2.5 text-sm text-heading outline-none focus:border-brand";
const label = (s: string) => COURIER_STATUS_LABEL[s as CourierStatus] ?? s;
const tone = (s: string, late: boolean): Tone => (s === "issue" || late ? "danger" : s === "delivered" || s === "received" ? "success" : s === "to_be_sent" ? "neutral" : "warn");

type Draft = { status: string; on: string; company: string; trackingNo: string; remarks: string };

function ShipmentCard({ s, canEdit, open, todayYmd, onSave, busy }: { s: ShipmentView; canEdit: boolean; open: boolean; todayYmd: string; onSave: (d: Draft) => void; busy: boolean }) {
  const flow = COURIER_FLOW[s.direction];
  const next = flow[flow.indexOf(s.status as CourierStatus) + 1] ?? null;
  const [d, setD] = useState<Draft>({ status: next ?? s.status, on: todayYmd, company: s.company ?? "", trackingNo: s.trackingNo ?? "", remarks: "" });
  const late = s.direction === "return" && s.status !== "received" && s.dueOn != null && s.dueOn < todayYmd;
  const doneHere = s.status === (s.direction === "outbound" ? "delivered" : "received");
  return (
    <div className={cx("rounded-[6px] border p-4", late || s.status === "issue" ? "border-warn-line bg-warn-soft/40" : "border-line")}>
      <div className="mb-1 flex items-center gap-2">
        <span className="flex-1 text-sm font-semibold text-heading">{s.direction === "outbound" ? "Outbound · to the candidate" : "Return · signed copies"}</span>
        <Pill tone={tone(s.status, late)}>{late ? `${label(s.status)} · late` : label(s.status)}</Pill>
      </div>
      <div className="mb-3 text-xs text-muted">
        {[s.company, s.trackingNo ? `AWB ${s.trackingNo}` : null, s.docs.length ? s.docs.join(", ") : null, s.dueOn && !doneHere ? `due back by ${fd(s.dueOn)}` : null].filter(Boolean).join(" · ") || "No courier details yet"}
      </div>
      <ol className="m-0 mb-3 flex list-none flex-col gap-2 p-0 text-[13px]">
        {s.events.map((e, i) => (
          <li key={i} className="flex gap-2.5">
            <span className={cx("mt-1 h-2.5 w-2.5 flex-none rounded-full", e.status === "issue" ? "bg-danger" : "bg-success")} />
            <span>
              <span className="font-medium text-heading">{label(e.status)}</span> · {fd(e.on)}
              {e.by ? ` · ${e.by}` : ""}
              {e.remarks ? <span className="block text-xs text-muted">“{e.remarks}”</span> : null}
            </span>
          </li>
        ))}
      </ol>
      {!doneHere && open ? (
        canEdit ? (
          <div className="grid grid-cols-2 gap-2.5">
            <label>
              <Label className="mb-1.5">Courier company</Label>
              <input value={d.company} onChange={(e) => setD({ ...d, company: e.target.value })} placeholder="e.g. DTDC" className={inputCls} />
            </label>
            <label>
              <Label className="mb-1.5">AWB / tracking no.</Label>
              <input value={d.trackingNo} onChange={(e) => setD({ ...d, trackingNo: e.target.value })} placeholder="Tracking number" className={inputCls} />
            </label>
            <label>
              <Label className="mb-1.5">Status</Label>
              <select value={d.status} onChange={(e) => setD({ ...d, status: e.target.value })} className={inputCls}>
                {[...flow, "issue" as const].map((k) => (
                  <option key={k} value={k}>
                    {label(k)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <Label className="mb-1.5">Date</Label>
              <input type="date" max={todayYmd} value={d.on} onChange={(e) => setD({ ...d, on: e.target.value })} className={inputCls} />
            </label>
            <label className="col-span-2">
              <Label className="mb-1.5">HR remarks · optional</Label>
              <input value={d.remarks} onChange={(e) => setD({ ...d, remarks: e.target.value })} className={inputCls} />
            </label>
            <div className="col-span-2">
              <Btn size="sm" kind="primary" disabled={busy || !d.on} onClick={() => onSave(d)}>
                Record {label(d.status).toLowerCase()}
              </Btn>
            </div>
          </div>
        ) : null
      ) : null}
    </div>
  );
}

export function CourierPanel({ applicationId, shipments, hardCopyDocs, canEdit, editWhy, open, todayYmd }: { applicationId: string; shipments: ShipmentView[]; hardCopyDocs: { key: string; label: string }[]; canEdit: boolean; editWhy: string; open: boolean; todayYmd: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [adding, setAdding] = useState(false);
  const [dir, setDir] = useState<"outbound" | "return">(shipments.some((s) => s.direction === "outbound") ? "return" : "outbound");
  const [nd, setNd] = useState<Draft>({ status: COURIER_FLOW[dir][0], on: todayYmd, company: "", trackingNo: "", remarks: "" });
  const overall = courierOverall(hardCopyDocs.length > 0, shipments);

  const run = (p: Promise<{ ok: boolean; message?: string; error?: string }>, after?: () => void) =>
    start(async () => {
      const r = await p;
      toast.push(r.ok ? (r.message ?? "Saved.") : (r.error ?? "That did not save."), r.ok ? "info" : "error");
      if (r.ok) {
        after?.();
        router.refresh();
      }
    });

  return (
    <Panel
      title="Courier"
      sub={hardCopyDocs.length ? `Hard copies of ${hardCopyDocs.map((d) => d.label).join(", ")}` : "No document of this role needs a paper copy"}
      actions={
        open && hardCopyDocs.length ? (
          canEdit ? (
            <Btn size="sm" onClick={() => setAdding((a) => !a)}>
              {adding ? "Cancel" : "+ Add shipment"}
            </Btn>
          ) : (
            <Locked size="sm" why={editWhy}>
              Add shipment
            </Locked>
          )
        ) : null
      }
    >
      {adding ? (
        <div className="mb-4 grid grid-cols-2 gap-2.5 rounded-[6px] border border-line bg-page p-3">
          <label>
            <Label className="mb-1.5">Direction</Label>
            <select
              value={dir}
              onChange={(e) => {
                const v = e.target.value as "outbound" | "return";
                setDir(v);
                setNd({ ...nd, status: COURIER_FLOW[v][0] });
              }}
              className={inputCls}
            >
              <option value="outbound">Outbound · to the candidate</option>
              <option value="return">Return · signed copies back</option>
            </select>
          </label>
          <label>
            <Label className="mb-1.5">Status</Label>
            <select value={nd.status} onChange={(e) => setNd({ ...nd, status: e.target.value })} className={inputCls}>
              {[...COURIER_FLOW[dir], "issue" as const].map((k) => (
                <option key={k} value={k}>
                  {label(k)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <Label className="mb-1.5">Courier company</Label>
            <input value={nd.company} onChange={(e) => setNd({ ...nd, company: e.target.value })} className={inputCls} />
          </label>
          <label>
            <Label className="mb-1.5">AWB / tracking no.</Label>
            <input value={nd.trackingNo} onChange={(e) => setNd({ ...nd, trackingNo: e.target.value })} className={inputCls} />
          </label>
          <label>
            <Label className="mb-1.5">Date</Label>
            <input type="date" max={todayYmd} value={nd.on} onChange={(e) => setNd({ ...nd, on: e.target.value })} className={inputCls} />
          </label>
          <label>
            <Label className="mb-1.5">Remarks · optional</Label>
            <input value={nd.remarks} onChange={(e) => setNd({ ...nd, remarks: e.target.value })} className={inputCls} />
          </label>
          <div className="col-span-2">
            <Btn
              size="sm"
              kind="primary"
              disabled={pending || !nd.on}
              onClick={() =>
                run(addShipmentAction(applicationId, { direction: dir, status: nd.status, on: nd.on, company: nd.company, trackingNo: nd.trackingNo, remarks: nd.remarks, docKeys: hardCopyDocs.map((d) => d.key) }), () => setAdding(false))
              }
            >
              Record shipment
            </Btn>
          </div>
        </div>
      ) : null}
      {shipments.length ? (
        <CardGrid min={280}>
          {shipments.map((s) => (
            <ShipmentCard
              key={`${s.id}:${s.status}`}
              s={s}
              canEdit={canEdit}
              open={open}
              todayYmd={todayYmd}
              busy={pending}
              onSave={(d) => run(courierEventAction(s.id, { status: d.status, on: d.on, remarks: d.remarks, company: d.company, trackingNo: d.trackingNo }))}
            />
          ))}
        </CardGrid>
      ) : (
        <div className="text-[13px] text-muted">{hardCopyDocs.length ? "No shipment yet. Sending an approved hard-copy document opens one to fill in." : "Nothing to send."}</div>
      )}
      {hardCopyDocs.length ? (
        <Callout tone={overall === "completed" ? "success" : overall === "issue" ? "danger" : "neutral"} className="mt-4">
          {overall === "completed"
            ? "Every hard copy is back with the company."
            : "This stage passes when every document is Signed and every hard copy is Received by company. Delivering the outbound copies opens the return leg with its due date."}
        </Callout>
      ) : null}
    </Panel>
  );
}
