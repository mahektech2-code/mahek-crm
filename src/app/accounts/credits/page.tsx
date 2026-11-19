import { checkCapability } from "@/lib/access-control";
import { getConfig } from "@/lib/config/store";
import { stamp } from "@/lib/format";
import { issuedCreditNotes, pendingCreditNotes } from "@/lib/services/credit-note-service";
import { QueueScreen } from "../queue-screen";
import type { QueueRow } from "../queue-types";
import { IssuedCreditNotes } from "./issued-credit-notes";

export const metadata = { title: "Credit note requests — Accounts — MahekOne" };

/** How many issued notes the list below the queue reads — a cap on the read, not a rule. */
const ISSUED_SHOWN = 200;

export default async function Page() {
  const [{ allowed }, requests, config, issued] = await Promise.all([
    checkCapability("creditnote.issue"),
    pendingCreditNotes(),
    getConfig(),
    issuedCreditNotes(ISSUED_SHOWN),
  ]);

  const rows: QueueRow[] = requests.map((c) => ({
    id: c.complaintId,
    customerId: c.customerId,
    customerName: c.customerName,
    // What was ASKED for. Zero where nobody put a figure on it, which is
    // ordinary — the telecaller was only asked whether the customer wanted one.
    amount: c.amount ?? 0,
    waitingHours: c.waitingHours,
    byName: c.raisedByName ?? "—",
    byWhen: stamp(c.raisedAt),
    byMeta: c.description,
    // Column three is what the complaint was about, column four is the bill it
    // names — a request with no bill is worth flagging, because issuing it puts
    // the money on account instead of against a debt.
    context: c.categoryLabel,
    contextTone: "body",
    middle: c.billNo ?? "none named",
    needsAttention: !c.billNo,
    slowPayer: false,
    overdueBills: 0,
  }));

  return (
    <>
      <QueueScreen
        kind="credits"
        rows={rows}
        canDecide={allowed}
        staleHours={config["payments.confirmationAgeWarningHours"]}
        quietDays={config["payments.reportedQuietDays"]}
      />
      <IssuedCreditNotes
        canCancel={allowed}
        capped={issued.length >= ISSUED_SHOWN}
        rows={issued.map((c) => ({
          complaintId: c.complaintId,
          customerName: c.customerName,
          amount: c.amount,
          reference: c.reference,
          billNo: c.billNo,
          categoryLabel: c.categoryLabel,
          description: c.description,
          issuedWhen: c.issuedAt ? stamp(c.issuedAt) : "—",
          issuedByName: c.issuedByName,
        }))}
      />
    </>
  );
}
