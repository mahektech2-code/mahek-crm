"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { Input } from "@/components/ui/primitives";
import { Button } from "@/components/console/parts";
import { ProductField } from "@/components/products/product-field";
import { declineSampleRequest, requestSample } from "@/lib/actions/lead-samples";
import { qualifiedForSample, sampleReadyStage } from "@/lib/engines/lead-ladder";
import { SAMPLE_SENDING_MODES, stageLabel, type LeadSalesType, type LeadStage } from "@/lib/lead-labels";

/* ---------------------------------------------------------------------------
 * §15 — ASKING FOR A SAMPLE FROM A DESK, which until now nobody could do.
 *
 * `requestSample` has been finished, audited, notified and covered by an
 * integration test since the module shipped, and nothing under `src/components`
 * or `src/app` imported it — so the only way a sample could be asked for at all
 * was a salesman standing in a shop with the handset open (`handleSample`, one
 * file over). That is the commonest path and it is not the only one: a customer
 * rings the office and asks for two cans to try, a manager working a stalled
 * lead decides a trial is what will move it, and the sample review is what
 * §L opens Negotiation with. `sample_trial` is a GATED rung, so an action with
 * no door does not merely fail to help — it freezes the funnel for anybody who
 * is not holding a phone.
 *
 * **THE PRODUCT AND THE APPLICATION ARE CARRIED FORWARD, never re-asked.**
 * Both are already on the lead — `lead_required_product_id` and `application`
 * are two of the eight qualification conditions the gate READS rather than
 * ticks, so a lead that has got as far as being offered a sample has answered
 * them. This product's first principle is that a fact established by whoever
 * was in the shop is not collected a second time by somebody at a desk; the
 * specification says the same thing about this form in as many words, that only
 * the quantity and the reason are new. So both fields open filled in.
 *
 * **They are EDITABLE rather than fixed, and that is not a contradiction.**
 * `requestSample` demands a product id of its own — it re-reads the catalogue
 * and refuses a retired SKU, because a sample of something we no longer sell is
 * a promise nobody can keep — so the field has to be able to hold an answer
 * whatever the lead says. A lead with no product named would otherwise open a
 * form that cannot be submitted and says nothing about why, and a customer who
 * asked for the thinner rather than the primer he was qualified on would have
 * to have his lead edited before his sample could be raised. Carrying the
 * answer forward is what saves the typing; freezing it would cost the accuracy.
 *
 * **The reason is a CODE from `leads.sampleReasons`**, handed down from the
 * server, never a list written out here. A manager rewording "wants to compare
 * it with a competitor" must not orphan the samples already carrying the code,
 * and a list typed into a screen is the same mistake as a product list typed
 * into a screen.
 *
 * **Without `lead.work` the control is drawn and DISABLED with the reason on
 * the hover**, this product's rule for something somebody might reasonably
 * expect to hold. The action checks the capability too — a disabled button is
 * a fact about a component, not about the system.
 *
 * **AND A LEAD BELOW PROSPECT IS SAID OUT LOUD, BEFORE THE BUTTON.** Mahek's
 * answer 05 is that a sample normally wants the lead qualified first — the
 * product, the monthly requirement, the potential, the competitor and the
 * basic requirement are all answered on the way to Prospect, and a trial with
 * none of them behind it has nothing to be measured against. It is emphatically
 * not a refusal: a salesman who believes a can in a shopkeeper's hand is what
 * opens the relationship may ask anyway, and the Sales Manager decides. So the
 * form stays submittable and the sentence appears where he can still read it —
 * "Lead not qualified — Manager approval required." Drawn only after the save
 * it would be an objection to a decision already made, which is the mistake the
 * check-in override was written the other way round to avoid.
 * ------------------------------------------------------------------------- */

export function RequestSample({
  customerId,
  customerName,
  /** §6's answer, carried forward. Null where nobody has named one. */
  defaultProductId,
  defaultProductName,
  /** §9's answer — what they are going to use it on. */
  defaultApplication,
  /* The rung this lead is standing on, and which ladder it is climbing — the
     two answers `qualifiedForSample` needs. Null on an account that is not a
     lead at all, which answers qualified, because a shop that has been buying
     for four years plainly has nothing left to establish. */
  leadStage,
  salesType,
  reasons,
  canWork,
  blocked = null,
}: {
  customerId: string;
  customerName: string;
  defaultProductId: string | null;
  defaultProductName: string | null;
  defaultApplication: string | null;
  leadStage: LeadStage | null;
  salesType: LeadSalesType | null;
  reasons: ReadonlyArray<{ code: string; label: string }>;
  canWork: boolean;
  /** Why the server would refuse a request right now. Null when it would not. */
  blocked?: string | null;
}) {
  const [open, setOpen] = React.useState(false);

  return (
    <>
      <Button
        size="sm"
        tone="primary"
        disabled={!canWork || Boolean(blocked)}
        title={
          !canWork
            ? "You cannot ask for samples on this lead."
            : blocked
              ? blocked
              : "Sends the request to a manager to approve. No stock moves until they do."
        }
        onClick={() => setOpen(true)}
      >
        Request a sample
      </Button>
      {/*
       * A `key` on the form rather than an effect resetting its fields when the
       * dialog reopens. The React Compiler rules are on and this codebase's
       * every modal does the same: a remount gives fresh initial state, and a
       * `setState` in an effect body is a second render plus a rule nobody can
       * see from the call site.
       */}
      {open ? (
        <RequestForm
          key={customerId}
          customerId={customerId}
          customerName={customerName}
          defaultProductId={defaultProductId}
          defaultProductName={defaultProductName}
          defaultApplication={defaultApplication}
          leadStage={leadStage}
          salesType={salesType}
          reasons={reasons}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

/**
 * The form on its own, for a caller that opens it from somewhere other than
 * this button — the call assistant, which has heard the product, the quantity
 * and the application and opens the form holding them. Everything else is the
 * same form: the same unqualified warning, the same action, the same refusal.
 */
export function RequestSampleForm(props: React.ComponentProps<typeof RequestForm>) {
  return <RequestForm {...props} />;
}

function RequestForm({
  customerId,
  customerName,
  defaultProductId,
  defaultProductName,
  leadStage,
  salesType,
  onClose,
  onRequested,
}: {
  customerId: string;
  customerName: string;
  defaultProductId: string | null;
  defaultProductName: string | null;
  /* The three below are still handed in by callers that used to ask for them. They
     are not asked any more: Step 1 is four questions and none of these is one. */
  defaultApplication?: string | null;
  defaultCans?: number | null;
  reasons?: ReadonlyArray<{ code: string; label: string }>;
  leadStage: LeadStage | null;
  salesType: LeadSalesType | null;
  onClose: () => void;
  onRequested?: () => void;
}) {
  const router = useRouter();
  const toast = useToast();

  /* SAMPLE / TRIAL, STEP 1 OF 2: Sample requested?, Product name, Sample sending
     date, Sending mode. No answer is defaulted, so nothing is submitted that a
     person did not choose. */
  const [requested, setRequested] = React.useState<"yes" | "no" | null>(null);
  const [productId, setProductId] = React.useState<string | null>(defaultProductId);
  const [sendingDate, setSendingDate] = React.useState("");
  const [sendingMode, setSendingMode] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  /* Pure, and the SAME function the action reads on the way in. */
  const unqualified = !qualifiedForSample(leadStage, salesType);
  const wantedStage = sampleReadyStage(salesType);

  const ready =
    requested === "no" ||
    (requested === "yes" && Boolean(productId) && Boolean(sendingDate) && Boolean(sendingMode));

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const result =
        requested === "no"
          ? await declineSampleRequest(customerId)
          : await requestSample(customerId, {
              productId: productId!,
              sendingDate,
              sendingMode: sendingMode!,
            });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onClose();
      onRequested?.();
      toast.push(result.message ?? "Recorded.");
      router.refresh();
    } finally {
      /* Cleared whatever happened. An action that rejects rather than returning
         a Result would otherwise leave the button dead until a reload. */
      setBusy(false);
    }
  }

  const choice = (name: string, value: string, label: string, checked: boolean, onPick: () => void) => (
    <label
      key={value}
      className={`flex flex-1 cursor-pointer items-center gap-2 rounded-[6px] border px-3 py-2 text-[13px] ${
        checked ? "border-brand bg-brand-soft text-ink" : "border-line bg-surface text-body"
      }`}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={busy}
        onChange={onPick}
      />
      {label}
    </label>
  );

  return (
    <Modal open onClose={onClose} title="Sample / Trial" width={520}>
      <div className="mb-3 rounded-[6px] border border-line bg-canvas px-3 py-2.5 text-[13px]">
        <div className="font-medium text-ink">{customerName}</div>
        <div className="text-muted">
          Sample / Trial · Sample Request. Nothing leaves the godown on this. It is a request, and a
          manager approves it before anybody packs a can.
        </div>
        {/*
         * The warning sits INSIDE the same block as the subject rather than in
         * a banner of its own, because it is a fact about this lead and not an
         * error about this form.
         */}
        {unqualified ? (
          <div className="mt-1.5 border-t border-line pt-1.5 text-warn-ink">
            Lead not qualified — Manager approval required.
            <span className="block text-muted">
              It is at {stageLabel(leadStage as LeadStage)}, and a sample normally waits for{" "}
              {stageLabel(wantedStage)}. Ask anyway if a can in their hand is what opens this one —
              the manager decides, and is told this was the rung.
            </span>
          </div>
        ) : null}
      </div>

      <div className="mb-1 block text-[13px] font-medium text-ink">Sample requested? · required</div>
      <div className="mb-3 flex gap-2">
        {choice("requested", "yes", "Yes", requested === "yes", () => setRequested("yes"))}
        {choice("requested", "no", "No", requested === "no", () => setRequested("no"))}
      </div>

      {requested === "no" ? (
        <p className="mb-2 text-[12px] text-muted">
          Nothing is started. The answer is written on this lead&apos;s history, and Step 2 stays
          locked because there is no sample for it to be about. A sample can be asked for later.
        </p>
      ) : null}

      {requested === "yes" ? (
        <>
          <label className="mb-1 block text-[13px] font-medium text-ink">
            Product name · required
          </label>
          <ProductField
            customerId={customerId}
            productId={productId}
            productName={defaultProductName}
            disabled={busy}
            onPick={(id) => setProductId(id)}
          />
          <p className="mt-1 mb-3 text-[12px] text-muted">
            Search the catalogue and pick from it. A sample of something we do not sell is a
            promise nobody can keep.
          </p>

          <label className="block">
            <span className="mb-1 block text-[13px] font-medium text-ink">
              Sample sending date · required
            </span>
            <Input
              type="date"
              value={sendingDate}
              disabled={busy}
              onChange={(e) => setSendingDate(e.target.value)}
              className="w-full"
            />
            <span className="mt-1 block text-[12px] text-muted">
              The day it is planned to go. This does not mark it as approved, sent or received.
            </span>
          </label>

          <div className="mt-3 mb-1 block text-[13px] font-medium text-ink">Sending mode · required</div>
          <div className="flex gap-2">
            {SAMPLE_SENDING_MODES.map((m) =>
              choice("sendingMode", m.code, m.label, sendingMode === m.code, () => setSendingMode(m.code)),
            )}
          </div>
        </>
      ) : null}

      {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}

      <div className="mt-4 flex justify-end gap-2">
        <Button tone="quiet" onClick={onClose}>
          Cancel
        </Button>
        <Button
          tone="primary"
          disabled={busy || !ready}
          title={
            requested === null
              ? "Answer whether a sample is being requested."
              : requested === "yes" && !productId
                ? "Name the product from the catalogue."
                : requested === "yes" && !sendingDate
                  ? "Pick the day it is planned to go."
                  : requested === "yes" && !sendingMode
                    ? "Courier or Hand Delivery."
                    : undefined
          }
          onClick={() => void save()}
        >
          {busy ? "Saving…" : requested === "no" ? "Record: no sample" : "Ask for it"}
        </Button>
      </div>
    </Modal>
  );
}
