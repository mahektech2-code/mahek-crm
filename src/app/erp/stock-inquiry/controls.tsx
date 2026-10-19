"use client";

import { useRouter, useSearchParams } from "next/navigation";
import type { ActionSpec } from "@/lib/erp/ui";
import { RowMenu, Tabs } from "@/components/ui/overlays";
import { controlClass } from "@/components/ui/primitives";
import { erpStockInquiryHref, type InquiryStage } from "@/lib/erp/stock-links";
import { PeriodPicker } from "../_ui/period-picker";
import { useErpUi } from "../_ui/erp-ui";
import { labelClass } from "../_ui/look";

/** The stage tabs, the item, the godown and the period: each a URL parameter, so a link opens the same view. */
export function InquiryControls({
  stage,
  stages,
  items,
  itemId,
  godowns,
  godownId,
  pd,
  pdLabel,
}: {
  stage: string;
  stages: { k: string; l: string }[];
  items: { id: string; name: string }[];
  itemId: string;
  godowns: { id: string; name: string }[];
  godownId: string | null;
  pd: string;
  pdLabel: string;
}) {
  const router = useRouter();
  const sp = useSearchParams();
  const go = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    router.push(erpStockInquiryHref({ stage: (p.get("stage") || stage) as InquiryStage, item: p.get("item") ?? undefined, godown: p.get("godown") ?? undefined, pd: p.get("pd") ?? undefined }));
  };
  return (
    <div className="flex flex-col gap-3">
      <Tabs tabs={stages.map((s) => ({ key: s.k, label: s.l }))} value={stage} onChange={(k) => go({ stage: k, item: null })} />
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-[280px] flex-1 flex-col gap-1 sm:max-w-[420px]">
          <span className={labelClass}>Item</span>
          <select value={itemId} onChange={(e) => go({ item: e.target.value || null })} className={controlClass({ className: "h-8.5 cursor-pointer" })}>
            <option value="">Choose an item…</option>
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-[180px] flex-col gap-1">
          <span className={labelClass}>Godown</span>
          <select value={godownId ?? ""} onChange={(e) => go({ godown: e.target.value || null })} className={controlClass({ className: "h-8.5 cursor-pointer" })}>
            <option value="">All godowns</option>
            {godowns.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
        <PeriodPicker pd={pd} label={pdLabel} dateLabel="Movement date" onPick={(v) => go({ pd: v })} />
      </div>
    </div>
  );
}

/** A lot's ⋯ menu on the inquiry: the same Adjust stock the Stock on hand row offers. */
export function LotMenu({ screen, rowId, actions }: { screen: string; rowId: string; actions: ActionSpec[] }) {
  const ui = useErpUi();
  if (!actions.length) return null;
  return <RowMenu items={actions.map((a) => ({ label: a.l, onSelect: () => ui.act(screen, a, rowId) }))} />;
}
