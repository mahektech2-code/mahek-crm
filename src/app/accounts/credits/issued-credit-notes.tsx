"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Modal, RowMenu } from "@/components/ui/overlays";
import { ImpactDialog } from "@/components/ui/impact-dialog";
import { Button, Field, Textarea } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { cancelCreditNoteAction } from "@/lib/actions/accounts";
import { money } from "@/lib/format";
import { Cell, HeadCell, Pager, Row, Table } from "../parts";

/* ---------------------------------------------------------------------------
 * Credit notes already issued, under the requests queue — the one place an
 * issued one can be taken back from by name. Cancelling asks the reason
 * first (the telecaller repeats it to the customer), then shows what it moves
 * across MahekOne, and only then writes: the Adjustment receipt is reversed,
 * never deleted, and the bills are rebuilt from the money left.
 * ------------------------------------------------------------------------- */

export type IssuedRow = {
  complaintId: string;
  customerName: string;
  amount: number;
  reference: string | null;
  billNo: string | null;
  categoryLabel: string;
  description: string;
  issuedWhen: string;
  issuedByName: string | null;
};

export function IssuedCreditNotes({ rows, canCancel, capped }: { rows: IssuedRow[]; canCancel: boolean; capped: boolean }) {
  const router = useRouter();
  const { push } = useToast();
  const [page, setPage] = React.useState(1);
  const [perPage, setPerPage] = React.useState(25);
  const [asking, setAsking] = React.useState<IssuedRow | null>(null);
  const [confirming, setConfirming] = React.useState<{ row: IssuedRow; reason: string; key: number } | null>(null);

  const shown = rows.slice((page - 1) * perPage, page * perPage);

  return (
    <section className="px-6 pb-12">
      <h2 className="mb-1 text-base font-semibold text-ink">Issued credit notes</h2>
      <p className="mb-3 text-[13px] text-muted">
        Newest first{capped ? ` — the latest ${rows.length}` : ""}. Cancelling one puts its amount back on the bill it came off.
      </p>
      {rows.length === 0 ? (
        <p className="rounded-[6px] border border-dashed border-line px-4 py-6 text-center text-[13px] text-muted">
          No credit note is standing issued.
        </p>
      ) : (
        <div className="overflow-hidden rounded-[6px] border border-line bg-surface">
          <Table
            minWidth={960}
            head={
              <>
                <HeadCell width={300}>Customer</HeadCell>
                <HeadCell>Issued</HeadCell>
                <HeadCell>Complaint</HeadCell>
                <HeadCell>Bill · CN no.</HeadCell>
                <HeadCell align="right">Amount</HeadCell>
                <HeadCell width={56} />
              </>
            }
          >
            {shown.map((r, i) => (
              <Row key={r.complaintId} striped={i % 2 === 1}>
                <Cell truncate={300}>
                  <span title={r.customerName} className="block truncate text-sm font-medium text-ink">
                    {r.customerName}
                  </span>
                  <span title={r.description} className="mt-px block truncate text-[13px] text-muted">
                    {r.description}
                  </span>
                </Cell>
                <Cell truncate={190}>
                  <span className="block truncate text-sm text-body">{r.issuedWhen}</span>
                  <span className="mt-px block truncate text-[13px] text-muted">{r.issuedByName ?? "—"}</span>
                </Cell>
                <Cell>{r.categoryLabel}</Cell>
                <Cell truncate={190}>
                  <span className="block truncate">{r.billNo ?? "on account"}</span>
                  <span className="mt-px block truncate text-[13px] text-muted">{r.reference ?? "no number"}</span>
                </Cell>
                <Cell align="right" className="font-medium text-ink">
                  {money(r.amount)}
                </Cell>
                <Cell align="right">
                  <RowMenu
                    items={[
                      {
                        label: "Cancel credit note",
                        destructive: true,
                        disabled: !canCancel,
                        title: canCancel ? undefined : "Cancelling a credit note is the accounts team's, as issuing one is",
                        onSelect: () => setAsking(r),
                      },
                    ]}
                  />
                </Cell>
              </Row>
            ))}
          </Table>
          <Pager
            total={rows.length}
            page={page}
            perPage={perPage}
            onPage={setPage}
            onPerPage={(n) => {
              setPerPage(n);
              setPage(1);
            }}
          />
        </div>
      )}

      {asking ? (
        <ReasonModal
          key={asking.complaintId}
          row={asking}
          onClose={() => setAsking(null)}
          onNext={(reason) => {
            setConfirming({ row: asking, reason, key: Date.now() });
            setAsking(null);
          }}
        />
      ) : null}
      {confirming ? (
        <ImpactDialog
          key={confirming.key}
          kind="accounts-creditnote-cancel"
          id={confirming.row.complaintId}
          onClose={() => setConfirming(null)}
          onConfirm={async (confirmation) => {
            const r = await cancelCreditNoteAction(confirming.row.complaintId, confirming.reason, confirmation);
            if (r.ok) {
              push(r.message ?? "Credit note cancelled");
              router.refresh();
            }
            return r;
          }}
        />
      ) : null}
    </section>
  );
}

function ReasonModal({ row, onClose, onNext }: { row: IssuedRow; onClose: () => void; onNext: (reason: string) => void }) {
  const [reason, setReason] = React.useState("");
  return (
    <Modal
      open
      onClose={onClose}
      title={`Cancel the ${money(row.amount)} credit note to ${row.customerName}`}
      footer={
        <>
          <Button onClick={onClose}>Back</Button>
          <Button
            variant="danger"
            disabled={!reason.trim()}
            title={reason.trim() ? undefined : "Say why first"}
            onClick={() => onNext(reason.trim())}
          >
            Continue
          </Button>
        </>
      }
    >
      <Field
        label="Why it is being cancelled"
        hint="The telecaller who raised it has to explain this to the customer, and it stays on the statement beside the reversed credit."
      >
        <Textarea autoFocus rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </Modal>
  );
}
