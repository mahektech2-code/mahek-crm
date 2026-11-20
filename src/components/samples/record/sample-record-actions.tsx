"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { Input, Textarea } from "@/components/ui/primitives";
import { Button } from "@/components/console/parts";
import { ProductField } from "@/components/products/product-field";
import { CancelSample } from "@/components/samples/cancel-sample";
import { editSampleRequest } from "@/lib/actions/lead-samples";
import { SAMPLE_SENDING_MODES, type SampleState } from "@/lib/lead-labels";
import { cleanWhole } from "@/lib/format";

/* ---------------------------------------------------------------------------
 * THE SAMPLE RECORD'S OWN ACTIONS — Edit the request and Cancel the sample.
 *
 * The record was read-only and every write lived on the desk, so somebody who
 * opened a sample from the lead, a link or a notification had to go and find
 * it again among five lanes to call it off. Cancel here is the desk's own
 * (`CancelSample`: a coded reason, then the impact modal). Edit is the
 * request's product, can count, note, sending date and mode, for the person
 * who asked for it or the lead's manager, while nothing has been sent — the
 * server says the same in `editSampleRequest`.
 * ------------------------------------------------------------------------- */

const CANCELLABLE: SampleState[] = ["requested", "approved", "dispatched", "received", "trial_done"];

export function SampleRecordActions({
  sample,
  cancelReasons,
  canWork,
  canEdit,
}: {
  sample: {
    id: string;
    customerId: string;
    customerName: string;
    state: SampleState;
    productId: string | null;
    productName: string | null;
    quantityCans: number | null;
    application: string | null;
    plannedSendDate: string | null;
    sendingMode: string | null;
  };
  cancelReasons: { code: string; label: string }[];
  /** `lead.work` — the same hat the desk's Cancel asks for. */
  canWork: boolean;
  /** The requester or the lead's manager, before dispatch — `sampleEditableBy`. */
  canEdit: boolean;
}) {
  const [editing, setEditing] = React.useState(false);
  const preDispatch = sample.state === "requested" || sample.state === "approved";
  return (
    <>
      {preDispatch ? (
        <Button
          size="sm"
          tone="quiet"
          disabled={!canEdit}
          title={
            canEdit
              ? "Change the product, cans, note, sending date or mode before it goes out"
              : "Only the person who asked for this sample, or the lead's manager, can change the request"
          }
          onClick={() => setEditing(true)}
        >
          Edit request
        </Button>
      ) : null}
      {CANCELLABLE.includes(sample.state) ? (
        <CancelSample
          sampleId={sample.id}
          what={`${sample.productName ?? "Sample"} for ${sample.customerName}`}
          reasons={cancelReasons}
          canWork={canWork}
        />
      ) : null}
      {editing ? <EditSampleForm key={sample.id} sample={sample} onClose={() => setEditing(false)} /> : null}
    </>
  );
}

function EditSampleForm({
  sample,
  onClose,
}: {
  sample: React.ComponentProps<typeof SampleRecordActions>["sample"];
  onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const approved = sample.state === "approved";
  const [productId, setProductId] = React.useState<string | null>(sample.productId);
  const [cans, setCans] = React.useState(sample.quantityCans ? String(sample.quantityCans) : "");
  const [application, setApplication] = React.useState(sample.application ?? "");
  const [sendingDate, setSendingDate] = React.useState(sample.plannedSendDate ?? "");
  const [sendingMode, setSendingMode] = React.useState<string | null>(sample.sendingMode);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const ready = Boolean(productId) && Boolean(sendingDate) && Boolean(sendingMode);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const n = cans.trim() ? Number(cans) : null;
      const result = await editSampleRequest(sample.id, {
        productId: productId!,
        quantityCans: n && n > 0 ? Math.round(n) : null,
        application: application.trim() || null,
        sendingDate,
        sendingMode: sendingMode!,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onClose();
      toast.push(result.message ?? "Saved.");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Edit the sample request" width={520}>
      <div className="mb-3 rounded-[6px] border border-line bg-canvas px-3 py-2.5 text-[13px]">
        <div className="font-medium text-ink">{sample.customerName}</div>
        <div className="text-muted">
          {approved
            ? "Approved, not yet sent. The product and cans are what the manager approved, so they stay — to send something else, cancel this and ask again."
            : "Waiting for approval. The manager decides on what this says when they open it."}
        </div>
      </div>

      <label className="mb-1 block text-[13px] font-medium text-ink">Product · required</label>
      {approved ? (
        <div className="mb-3 text-[13px] text-body">{sample.productName ?? "—"}</div>
      ) : (
        <div className="mb-3">
          <ProductField
            customerId={sample.customerId}
            productId={productId}
            productName={sample.productName}
            disabled={busy}
            onPick={(id) => setProductId(id)}
          />
        </div>
      )}

      <label className="mb-3 block">
        <span className="mb-1 block text-[13px] font-medium text-ink">Cans (optional)</span>
        <Input
          inputMode="numeric"
          value={cans}
          disabled={busy || approved}
          onChange={(e) => setCans(cleanWhole(e.target.value))}
          className="w-32"
        />
      </label>

      <label className="mb-3 block">
        <span className="mb-1 block text-[13px] font-medium text-ink">What it is for (optional)</span>
        <Textarea
          rows={2}
          value={application}
          disabled={busy}
          onChange={(e) => setApplication(e.target.value)}
          placeholder="The surface or job it will be tried on"
          className="w-full"
        />
      </label>

      <label className="mb-3 block">
        <span className="mb-1 block text-[13px] font-medium text-ink">Sample sending date · required</span>
        <Input type="date" value={sendingDate} disabled={busy} onChange={(e) => setSendingDate(e.target.value)} className="w-full" />
      </label>

      <div className="mb-1 block text-[13px] font-medium text-ink">Sending mode · required</div>
      <div className="flex gap-2">
        {SAMPLE_SENDING_MODES.map((m) => (
          <label
            key={m.code}
            className={`flex flex-1 cursor-pointer items-center gap-2 rounded-[6px] border px-3 py-2 text-[13px] ${
              sendingMode === m.code ? "border-brand bg-brand-soft text-ink" : "border-line bg-surface text-body"
            }`}
          >
            <input
              type="radio"
              name="edit-sending-mode"
              value={m.code}
              checked={sendingMode === m.code}
              disabled={busy}
              onChange={() => setSendingMode(m.code)}
            />
            {m.label}
          </label>
        ))}
      </div>

      {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}

      <div className="mt-4 flex justify-end gap-2">
        <Button tone="quiet" onClick={onClose}>
          Keep as it is
        </Button>
        <Button
          tone="primary"
          disabled={busy || !ready}
          title={ready ? undefined : "A product, the sending date and the mode are needed."}
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </Modal>
  );
}
