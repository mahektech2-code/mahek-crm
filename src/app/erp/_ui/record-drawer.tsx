"use client";

import type { ListRow, ListSpec } from "@/lib/erp/ui";
import { cellText } from "@/lib/erp/ui";
import { Button, cx, SectionLabel } from "@/components/ui/primitives";
import { Drawer, DrawerHeader } from "@/components/ui/overlays";
import { FlagBadge, StatusBadge } from "./badge";
import { Icon } from "./icons";
import { useErpUi } from "./erp-ui";
import { renderPanel } from "./panels";
import "./panels/index";

/* ---------------------------------------------------------------------------
 * A record, opened from its row, in the CRM's right-hand drawer. Every column
 * the person may see, then the record's extra fields, calculated ones marked;
 * the contact shortcuts; anything a screen draws of its own (allocation,
 * evidence); and the actions — available ones as buttons, unavailable ones
 * disabled with the reason said under them.
 * ------------------------------------------------------------------------- */

export function RecordDrawer({ screen, kind, row, onClose }: { screen: ListSpec; kind: string; row: ListRow; onClose: () => void }) {
  const ui = useErpUi();
  const titleCol = screen.cols.find((c) => c.t === "b") ?? screen.cols[0];
  const title = row.title ?? (titleCol ? cellText(titleCol, row.v[titleCol.k]) : "");
  const fields = [
    ...screen.cols
      .filter((c) => c.t !== "f" && c.k !== titleCol?.k)
      .map((c) => ({ l: c.l, v: c.t === "s" ? String(row.v[c.k] ?? "—") : cellText(c, row.v[c.k]), der: false, status: c.t === "s" })),
    ...(row.fields ?? []).map((f) => ({ ...f, der: !!f.der, status: false })),
  ];
  const acts = row.actions ?? [];
  const blocked = acts.filter((a) => a.why);
  const hiddenCount = screen.hidden.length + (row.hiddenFields ?? 0);

  /* An action does NOT close the record: the list refreshes under it, so the
     person sees what the action changed and can take the next one. A record
     the action removes from the list (deleted, filtered out) closes on its
     own, because the list no longer holds a row to draw. */
  return (
    <Drawer open onClose={onClose} width={600} label={title}>
      <DrawerHeader onClose={onClose}>
        <div className="text-xs font-medium tracking-[0.04em] text-muted uppercase">{kind}</div>
        <div className="mt-0.5 text-lg leading-6 font-semibold text-ink">{title}</div>
        {row.header ? <div className="mt-0.5 text-[13px] text-body">{row.header}</div> : null}
        {row.flags.length ? (
          <div className="mt-2 flex flex-wrap gap-1">
            {row.flags.map((f) => (
              <FlagBadge key={f} flag={f} />
            ))}
          </div>
        ) : null}
      </DrawerHeader>
      <div className="grid min-h-0 flex-1 auto-rows-max grid-cols-[minmax(0,1fr)] content-start gap-4 overflow-y-auto px-5 py-4">
        {row.panel ? renderPanel(row.panel.kind, { data: row.panel.data, row, screen: screen.screen }) : null}
        {row.contacts?.length ? (
          <div className="flex flex-wrap gap-2">
            {row.contacts.map((k) => (
              <a
                key={k.href}
                href={k.href}
                target="_blank"
                rel="noopener"
                className="inline-flex h-8 items-center rounded-[4px] border border-line bg-surface px-2.5 text-[13px] text-[#5223E0] no-underline hover:bg-canvas"
              >
                {k.l}
              </a>
            ))}
          </div>
        ) : null}
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3.5">
          {fields.map((f, i) => (
            <div key={`${f.l}:${i}`} className="min-w-0">
              <dt className="flex items-center gap-1.5 text-xs font-medium tracking-[0.04em] text-muted uppercase">
                {f.l}
                {f.der ? <span className="rounded-[3px] bg-divider px-1.5 text-[11px] tracking-normal normal-case">Calculated</span> : null}
              </dt>
              <dd className="mt-0.5">
                {f.status && f.v !== "—" ? (
                  <StatusBadge value={f.v} />
                ) : (
                  <span className={cx("block text-sm break-words tabular-nums", f.v === "—" ? "text-line-strong" : "text-ink")}>{f.v}</span>
                )}
              </dd>
            </div>
          ))}
        </dl>
        {hiddenCount ? (
          <div className="flex items-center gap-1.5 text-[13px] text-muted">
            <Icon n="lock" s={14} />
            {hiddenCount} field{hiddenCount > 1 ? "s are" : " is"} not shown on your account.
          </div>
        ) : null}
        {blocked.length ? (
          <div className="rounded-[4px] bg-canvas px-3 py-2.5">
            <SectionLabel>Not available yet</SectionLabel>
            {blocked.map((b) => (
              <div key={b.id} className="py-0.5 text-[13px] text-body">
                <span className="font-medium text-ink">{b.l}</span> — {b.why}
              </div>
            ))}
          </div>
        ) : null}
        {!acts.length && screen.readOnly ? (
          <div className="text-[13px] text-muted">Read-only. These entries are written by their source records, never by hand.</div>
        ) : null}
        {row.by ? <div className="text-xs text-muted">{row.by}</div> : null}
      </div>
      {acts.length ? (
        <div className="flex flex-none flex-wrap justify-end gap-2.5 border-t border-divider px-5 py-3">
          {acts.map((a) => {
            const okA = !a.why;
            return (
              <Button
                key={a.id}
                variant={a.primary && okA ? "primary" : "secondary"}
                onClick={() => okA && ui.act(screen.screen, a, row.id)}
                title={a.why || a.l}
                disabled={!okA}
                className={cx(a.ai && okA && !a.primary && "border-brand text-[#5223E0]")}
              >
                {a.ai ? <Icon n="spark" /> : null}
                {a.l}
              </Button>
            );
          })}
        </div>
      ) : null}
    </Drawer>
  );
}
