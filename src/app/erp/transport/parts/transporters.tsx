"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/modal";
import { Badge, Button, Card } from "@/components/ui/primitives";
import { erpLogisticsTransporter } from "@/lib/actions/erp-logistics";
import type { Transporter } from "@/lib/erp/logistics";
import { CallLink, Empty, useAct } from "./common";

/**
 * The transport companies logistics rings, with their numbers and — where the
 * company has one — the page that tracks an LR online. Bills and LRs carry the
 * transporter as a name, so a name here is what gives a card its call button.
 */
type Load = { active: number; road: number };

export function Transporters({ rows, load, canWrite }: { rows: Transporter[]; load: Record<string, Load>; canWrite: boolean }) {
  const [edit, setEdit] = useState<Partial<Transporter> | null>(null);
  return (
    <div className="space-y-3">
      {canWrite ? (
        <div className="flex justify-end">
          <Button variant="primary" size="sm" onClick={() => setEdit({ active: true })}>
            Add transporter
          </Button>
        </div>
      ) : null}
      <Card className="overflow-hidden">
        <div className="grid grid-cols-[minmax(160px,1.4fr)_minmax(140px,1fr)_minmax(140px,1fr)_minmax(140px,1.2fr)_110px_80px] gap-3 border-b border-divider bg-canvas px-4 py-2 text-[12px] font-medium text-muted">
          <span>Transporter</span>
          <span>Phone</span>
          <span>Contact</span>
          <span>Godown</span>
          <span>With them now</span>
          <span />
        </div>
        {rows.length ? (
          rows.map((t) => {
            const l = load[t.name.toLowerCase()] ?? { active: 0, road: 0 };
            return (
              <div key={t.id} className="grid grid-cols-[minmax(160px,1.4fr)_minmax(140px,1fr)_minmax(140px,1fr)_minmax(140px,1.2fr)_110px_80px] items-center gap-3 border-b border-divider px-4 py-2.5 text-sm last:border-0">
                <span className="min-w-0">
                  <span className="block truncate font-medium text-ink">{t.name}</span>
                  {!t.active ? <Badge tone="muted">Not in use</Badge> : t.trackingUrl ? <span className="text-[12px] text-success">Online tracking</span> : null}
                </span>
                <span className="min-w-0">
                  <CallLink phone={t.phone} name={t.name} />
                  {t.altPhone ? <span className="block text-[12px] text-muted">{t.altPhone}</span> : null}
                </span>
                <span className="truncate text-[13px] text-body">{t.contactPerson ?? "—"}</span>
                <span className="truncate text-[13px] text-body">{t.address ?? "—"}</span>
                <span className="text-[13px] text-body">{l.active ? `${l.active} bill${l.active === 1 ? "" : "s"}${l.road ? ` · ${l.road} on road` : ""}` : "—"}</span>
                <span className="text-right">
                  {canWrite ? (
                    <Button size="sm" variant="ghost" onClick={() => setEdit(t)}>
                      Edit
                    </Button>
                  ) : null}
                </span>
              </div>
            );
          })
        ) : (
          <Empty>No transporters yet. Add the companies you send goods with.</Empty>
        )}
      </Card>
      {edit ? <EditTransporter key={edit.id ?? "new"} t={edit} onClose={() => setEdit(null)} /> : null}
    </div>
  );
}

function EditTransporter({ t, onClose }: { t: Partial<Transporter>; onClose: () => void }) {
  const { run, pending } = useAct();
  const [v, setV] = useState({ name: t.name ?? "", phone: t.phone ?? "", altPhone: t.altPhone ?? "", contactPerson: t.contactPerson ?? "", address: t.address ?? "Bhiwandi", trackingUrl: t.trackingUrl ?? "", active: t.active ?? true });
  const cls = "mt-0.5 block h-8.5 w-full rounded-[4px] border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-brand";
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => setV({ ...v, [k]: e.target.value });
  return (
    <Modal
      open
      onClose={onClose}
      title={t.id ? `Edit ${t.name}` : "Add a transporter"}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={pending || !v.name.trim()} onClick={() => run(() => erpLogisticsTransporter({ id: t.id ?? null, ...v }), (r) => r.ok && onClose())}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3 text-[12px] text-muted">
        <label className="col-span-2">Name (as it is written on bills and LRs)<input value={v.name} onChange={set("name")} className={cls} /></label>
        <label>Phone<input value={v.phone} onChange={set("phone")} inputMode="tel" className={cls} /></label>
        <label>Second phone<input value={v.altPhone} onChange={set("altPhone")} inputMode="tel" className={cls} /></label>
        <label>Contact person<input value={v.contactPerson} onChange={set("contactPerson")} className={cls} /></label>
        <label>Godown / address<input value={v.address} onChange={set("address")} className={cls} /></label>
        <label className="col-span-2">
          Online tracking page
          <input value={v.trackingUrl} onChange={set("trackingUrl")} placeholder="https://… with {lr} where the LR number goes" className={cls} />
          <span className="mt-0.5 block">Where the company tracks an LR online, its card on the road gets a link straight to it.</span>
        </label>
        <label className="col-span-2 flex items-center gap-2 text-sm text-body">
          <input type="checkbox" checked={v.active} onChange={(e) => setV({ ...v, active: e.target.checked })} className="accent-[#6835FB]" /> In use
        </label>
      </div>
    </Modal>
  );
}
