"use client";

/* ---------------------------------------------------------------------------
 * TAKING A LIST OUT OF FORCE, with the reason on the record.
 *
 * Withdrawing is the same shape as every other reason-taking decision here: a
 * lost lead, a rejected sample, an On Hold. The next person to open this list
 * will ask what happened to it, and "withdrawn" on its own answers nothing —
 * so the reason is required by the action rather than by this form, and it is
 * printed on the list's own header afterwards.
 *
 * It is not a delete. A list somebody quoted from in March is a fact about
 * March, and the orders taken against it still point at it.
 *
 * TWO STEPS: the reason, then the impact list — every shop it prices and the
 * list each falls to, or that nothing does — with the list's name typed to
 * confirm. The reason travels with the confirmation into the one act.
 * ------------------------------------------------------------------------- */

import * as React from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { ImpactDialog } from "@/components/ui/impact-dialog";
import { Button, Callout, Field, Textarea } from "@/components/ui/primitives";
import { withdrawPriceList } from "@/lib/actions/price-lists";

export function WithdrawModal(props: {
  open: boolean;
  onClose: () => void;
  listId: string;
  listName: string;
}) {
  if (!props.open) return null;
  return <WithdrawBody key={props.listId} {...props} />;
}

function WithdrawBody({
  onClose,
  listId,
  listName,
}: {
  onClose: () => void;
  listId: string;
  listName: string;
}) {
  const router = useRouter();
  const { push } = useToast();
  const [reason, setReason] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [checking, setChecking] = React.useState(false);

  function next() {
    if (!reason.trim()) {
      setError("Say why it is being withdrawn. Somebody will ask what happened to this list.");
      return;
    }
    setChecking(true);
  }

  if (checking) {
    return (
      <ImpactDialog
        kind="price-list-withdrawal"
        id={listId}
        confirmLabel="Withdraw it"
        onClose={onClose}
        onConfirm={async (confirmation) => {
          const r = await withdrawPriceList(listId, reason.trim(), confirmation);
          if (r.ok) {
            push(r.message ?? "Withdrawn.");
            router.refresh();
          }
          return r;
        }}
      />
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Withdraw ${listName}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={next}>
            See what it affects
          </Button>
        </>
      }
    >
      <Callout tone="danger">
        Every shop priced from this list falls back to whatever else names them —
        and where nothing does, they have no price at all.
      </Callout>
      <Field label="Why" error={error}>
        <Textarea
          autoFocus
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Superseded by the September revision"
        />
      </Field>
    </Modal>
  );
}
