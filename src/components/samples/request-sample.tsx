"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { Input, Select, Textarea } from "@/components/ui/primitives";
import { Button } from "@/components/console/parts";
import { ProductField } from "@/components/products/product-field";
import { requestSample } from "@/lib/actions/lead-samples";

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
 * ------------------------------------------------------------------------- */

export function RequestSample({
  customerId,
  customerName,
  /** §6's answer, carried forward. Null where nobody has named one. */
  defaultProductId,
  defaultProductName,
  /** §9's answer — what they are going to use it on. */
  defaultApplication,
  reasons,
  canWork,
}: {
  customerId: string;
  customerName: string;
  defaultProductId: string | null;
  defaultProductName: string | null;
  defaultApplication: string | null;
  reasons: ReadonlyArray<{ code: string; label: string }>;
  canWork: boolean;
}) {
  const [open, setOpen] = React.useState(false);

  return (
    <>
      <Button
        size="sm"
        tone="primary"
        disabled={!canWork}
        title={
          canWork
            ? "Raises the request and puts it in front of a manager to approve. The stock does not move until somebody says so."
            : "Asking for a sample is the salesman's and the manager's, the same hat that moves a lead up a rung."
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
          reasons={reasons}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function RequestForm({
  customerId,
  customerName,
  defaultProductId,
  defaultProductName,
  defaultApplication,
  reasons,
  onClose,
}: {
  customerId: string;
  customerName: string;
  defaultProductId: string | null;
  defaultProductName: string | null;
  defaultApplication: string | null;
  reasons: ReadonlyArray<{ code: string; label: string }>;
  onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();

  const [productId, setProductId] = React.useState<string | null>(defaultProductId);
  const [cans, setCans] = React.useState("1");
  const [application, setApplication] = React.useState(defaultApplication ?? "");
  /* The first of the configured codes, so the commonest answer is already
     chosen and the field is never submitted empty by somebody who did not
     notice it. It is still a select rather than a hidden default: "they asked
     for one" and "they are comparing us against the incumbent" are the two
     answers this list exists to tell apart. */
  const [reasonCode, setReasonCode] = React.useState(reasons[0]?.code ?? "");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const quantity = Number(cans);
  const quantityOk = Number.isInteger(quantity) && quantity > 0 && quantity <= 10000;
  const ready = Boolean(productId) && quantityOk && application.trim().length > 0 && Boolean(reasonCode);

  async function save() {
    if (!productId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await requestSample(customerId, {
        productId,
        quantityCans: quantity,
        application: application.trim(),
        reasonCode,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onClose();
      toast.push(result.message ?? "Sample requested.");
      router.refresh();
    } finally {
      /* Cleared whatever happened. An action that rejects rather than returning
         a Result would otherwise leave the button dead until a reload. */
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Ask for a sample" width={520}>
      <div className="mb-3 rounded-[6px] border border-line bg-canvas px-3 py-2.5 text-[13px]">
        <div className="font-medium text-ink">{customerName}</div>
        <div className="text-muted">
          Nothing leaves the godown on this. It is a request, and a manager approves it before
          anybody packs a can.
        </div>
      </div>

      <label className="mb-1 block text-[13px] font-medium text-ink">
        What they are trying · required
      </label>
      <ProductField
        customerId={customerId}
        productId={productId}
        productName={defaultProductName}
        disabled={busy}
        onPick={(id) => setProductId(id)}
      />
      <p className="mt-1 mb-3 text-[12px] text-muted">
        {defaultProductName
          ? "Taken from what this lead said they need. Change it where the customer has asked for something else."
          : "Nobody has named a product on this lead, so there is nothing to carry forward — the catalogue is the only thing that may name one."}
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-[13px] font-medium text-ink">Cans · required</span>
          <Input
            type="number"
            min={1}
            max={10000}
            value={cans}
            disabled={busy}
            onChange={(e) => setCans(e.target.value)}
            className="w-full"
          />
          <span className="mt-1 block text-[12px] text-muted">
            Cans, like every quantity here. Litres are worked out from the pack.
          </span>
        </label>
        <label className="block">
          <span className="mb-1 block text-[13px] font-medium text-ink">Why · required</span>
          <Select
            value={reasonCode}
            disabled={busy}
            onChange={(e) => setReasonCode(e.target.value)}
            className="w-full"
          >
            {reasons.map((r) => (
              <option key={r.code} value={r.code}>
                {r.label}
              </option>
            ))}
          </Select>
          <span className="mt-1 block text-[12px] text-muted">
            A code, so &ldquo;how many trials did we send to beat an incumbent&rdquo; is a
            question somebody can ask.
          </span>
        </label>
      </div>

      <label className="mt-3 block">
        <span className="mb-1 block text-[13px] font-medium text-ink">
          What it is going to be used on · required
        </span>
        <Textarea
          rows={3}
          value={application}
          disabled={busy}
          onChange={(e) => setApplication(e.target.value)}
          className="w-full"
        />
        <span className="mt-1 block text-[12px] text-muted">
          {defaultApplication
            ? "Carried forward from the qualification. Correct it where this trial is for something else."
            : "A trial on the wrong substrate produces an opinion about the wrong thing — and the customer remembers the opinion, not the substrate."}
        </span>
      </label>

      {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}

      <div className="mt-4 flex justify-end gap-2">
        <Button tone="quiet" onClick={onClose}>
          Cancel
        </Button>
        <Button
          tone="primary"
          disabled={busy || !ready}
          title={
            !productId
              ? "Name the product from the catalogue. A sample of something we do not sell is a promise nobody can keep."
              : !quantityOk
                ? "How many cans — a whole number, at least one."
                : !application.trim()
                  ? "Say what it is going to be used on. A trial on the wrong substrate answers the wrong question."
                  : undefined
          }
          onClick={() => void save()}
        >
          {busy ? "Asking…" : "Ask for it"}
        </Button>
      </div>
    </Modal>
  );
}
