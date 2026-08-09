import { checkCapability } from "@/lib/access-control";
import { getConfig } from "@/lib/config/store";
import { stamp } from "@/lib/format";
import { pendingCreditNotes } from "@/lib/services/credit-note-service";
import { QueueScreen } from "../queue-screen";
import type { QueueRow } from "../queue-types";

export const metadata = { title: "Credit note requests — Accounts — MahekOne" };

export default async function Page() {
  const [{ allowed }, requests, config] = await Promise.all([
    checkCapability("creditnote.issue"),
    pendingCreditNotes(),
    getConfig(),
  ]);

  const rows: QueueRow[] = requests.map((c) => ({
    id: c.complaintId,
    customerId: c.customerId,
    customerName: c.customerName,
    // What was ASKED for. Zero where nobody put a figure on it, which is
    // ordinary — the telecaller was only asked whether the customer wanted one.
    amount: c.amount ?? 0,
    waitingHours: c.waitingHours,
    byName: c.raisedByName
      ? `${c.raisedByName} · ${stamp(c.raisedAt)}`
      : stamp(c.raisedAt),
    byMeta: c.description,
    middle: c.categoryLabel,
    context: c.billNo ?? "none named",
    contextTone: c.billNo ? "body" : "warn",
    slowPayer: false,
    overdueBills: 0,
  }));

  return (
    <QueueScreen
      kind="credits"
      rows={rows}
      canDecide={allowed}
      staleHours={config["payments.confirmationAgeWarningHours"]}
      quietDays={config["payments.reportedQuietDays"]}
    />
  );
}
