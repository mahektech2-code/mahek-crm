"use client";

import { useRouter } from "next/navigation";
import { daysBetween } from "@/lib/format";
import { savePaymentMethod } from "@/lib/actions/locker-assets";
import { Btn, C, Pill, fd, nf, useModal, useToast, type ModalField } from "../_ui/kit";
import { ListBlock } from "../_ui/register-parts";

type PM = { id: string; label: string; kind: string; last4: string; expiresOn: string | null; holder: string; bank: string; personal: boolean; active: boolean; uses: number };

/** Payment methods on file: the last four and the expiry, never a full number or a CVV. */
export function PaymentMethods({ pms, canEdit, today }: { pms: PM[]; canEdit: boolean; today: string }) {
  const modal = useModal();
  const toast = useToast();
  const router = useRouter();
  const open = (p?: PM) => {
    const fields: ModalField[] = [
      { k: "label", l: "Name", req: true, init: p?.label ?? "", ph: "ICICI corporate card" },
      { k: "kind", l: "Type", type: "select", init: p?.kind ?? "Credit card", opts: ["Credit card", "Debit card", "Bank mandate", "UPI mandate", "Wallet", "Manual transfer", "Cheque"] },
      { k: "last4", l: "Last four digits", init: p?.last4 ?? "", hint: "Only the last four. The full number and the CVV are never stored." },
      { k: "exp", l: "Expires on", type: "date", init: p?.expiresOn ?? "" },
      { k: "holder", l: "In whose name", init: p?.holder ?? "" },
      { k: "bank", l: "Issuing bank", init: p?.bank ?? "" },
      { k: "personal", l: "Whose money", type: "select", init: p?.personal ? "personal" : "company", opts: [{ v: "company", l: "The company's" }, { v: "personal", l: "A person's own card — a risk" }] },
      ...(p ? [{ k: "active", l: "In use", type: "select" as const, init: p.active ? "yes" : "no", opts: [{ v: "yes", l: "Yes" }, { v: "no", l: "No — retired" }] }] : []),
    ];
    modal({
      title: p ? `Change ${p.label}` : "Add a payment method",
      sub: "A card that expires before the subscriptions it pays is how services lapse without anybody noticing.",
      fields,
      okL: "Save",
      done: async (v) => {
        const r = await savePaymentMethod({ id: p?.id, label: v.label, kind: v.kind, last4: v.last4, expiresOn: v.exp || null, holder: v.holder, bank: v.bank, personal: v.personal === "personal", active: v.active ? v.active === "yes" : true });
        if (!r.ok) return r.error;
        toast(r.message ?? "Saved");
        router.refresh();
      },
    });
  };
  return (
    <ListBlock
      title="Payment methods"
      sub={`${nf(pms.filter((p) => p.active).length)} in use`}
      right={canEdit ? <Btn small kind="p" onClick={() => open()}>Add</Btn> : undefined}
      items={pms.map((p) => {
        const left = p.expiresOn ? daysBetween(today, p.expiresOn) : null;
        return {
          t: `${p.label}${p.last4 ? ` ····${p.last4}` : ""}`,
          sub: [p.kind, p.bank, p.holder, p.expiresOn ? `expires ${fd(p.expiresOn)}` : "no expiry", `${p.uses} ${p.uses === 1 ? "asset" : "assets"}`].filter(Boolean).join(" · "),
          red: !p.active ? false : left != null && left < 0,
          badge: !p.active ? <Pill label="Retired" bg={C.soft} fg={C.muted} /> : p.personal ? <Pill label="Personal card" bg={C.redSoft} fg={C.red} /> : left != null && left <= 60 ? <Pill label={left < 0 ? "Expired" : `In ${left} days`} bg={C.amberSoft} fg={C.amber} /> : undefined,
          action: canEdit ? <Btn small onClick={() => open(p)}>Change</Btn> : undefined,
        };
      })}
      emptyLine="No payment method is recorded. Add the cards and mandates that pay for subscriptions."
    />
  );
}
