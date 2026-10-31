"use client";

import { useState } from "react";
import type { ListRow, ListSpec, Tone } from "@/lib/erp/ui";
import { cellText } from "@/lib/erp/ui";
import { Button, cx, SectionLabel } from "@/components/ui/primitives";
import { eyebrowClass, insetClass } from "./look";
import { FlagBadge, flagsBesideStatus, StatusBadge } from "./badge";
import { useKit } from "./kit";
import { Icon } from "./icons";
import { useErpUi } from "./erp-ui";
import { renderPanel } from "./panels";
import { DialogBody, DialogTitle, DialogFooter, DialogHeader, ErpDialog, MoreMenu, TabBar, type DialogTab } from "./dialog";
import "./panels/index";

/* ---------------------------------------------------------------------------
 * A record, opened from its row, in a dialog with TABS. What a screen draws of
 * its own (the purchase flow, a trace, test evidence) is the first tab and is
 * named for what it is; Details is every column the person may see and the
 * record's extra fields, calculated ones marked, three to a row. The actions
 * stay in the foot on every tab. One that cannot be taken yet is drawn with a
 * lock; pressing it says why in one line, rather than a tab of reasons.
 * ------------------------------------------------------------------------- */

/** More actions than this and the rest go under "More". */
const BUTTONS_MAX = 4;
/** Actions drawn in red in the More menu: they remove or undo something. */
const DANGER = /^(delete|cancel|retire|remove|deactivate|withdraw|void|reject|undo|mark inactive)/i;

/** What each screen-drawn panel's tab is called. A kind not named here is "Overview". */
export const PANEL_TAB: Record<string, string> = {
  purchaseFlow: "Purchase flow",
  purchaseOrder: "Receiving",
  returnFlow: "Return",
  scrap: "Drum",
  stockCount: "Count",
  testEvidence: "Test evidence",
  trace: "Trace",
  video: "Video",
  canPhotos: "Photos",
  canGroup: "Group",
  money: "Summary",
  orderTracking: "Customer tracking",
  orderInvoice: "Invoice",
};

export function RecordDialog({
  screen,
  kind,
  row,
  onClose,
  stages,
}: {
  screen: ListSpec;
  kind: string;
  row: ListRow;
  onClose: () => void;
  /** v4: the list's status values in order, drawn as a stage bar over the record. */
  stages?: { key: string; values: string[] };
}) {
  const ui = useErpUi();
  const { flags: words, tones } = useKit();
  const flags = flagsBesideStatus(row, screen.cols, words);
  const titleCol = screen.cols.find((c) => c.t === "b") ?? screen.cols[0];
  const title = row.title ?? (titleCol ? cellText(titleCol, row.v[titleCol.k]) : "");
  /* A record field that carries the same label as a column is the column said
     in full ("QC: Approved by … · passed" beside "QC: Approved"), so it takes
     the column's place rather than appearing a second time. */
  const extra = (row.fields ?? []).map((f) => ({ ...f, der: !!f.der, status: false }));
  const fuller = new Map(extra.map((f) => [f.l.toLowerCase(), f]));
  const covered = new Set(row.panel?.covers ?? []);
  const fields = [
    ...screen.cols
      .filter((c) => c.t !== "f" && c.k !== titleCol?.k && !covered.has(c.k))
      .map((c) => fuller.get(c.l.toLowerCase()) ?? { l: c.l, v: c.t === "s" ? String(row.v[c.k] ?? "—") : cellText(c, row.v[c.k]), der: false, status: c.t === "s" }),
    ...extra.filter((f) => !screen.cols.some((c) => c.t !== "f" && c.k !== titleCol?.k && !covered.has(c.k) && c.l.toLowerCase() === f.l.toLowerCase())),
  ];
  const acts = row.actions ?? [];
  const hiddenCount = screen.hidden.length + (row.hiddenFields ?? 0);
  /* The record's status is said once, in the heading, where it is read first —
     only a column CALLED Status or Stage: a badge column like "Material type"
     reads as a status in a heading and is not one. */
  const status = fields.find((f) => f.status && f.v !== "—" && /^(status|stage)$/i.test(f.l.trim()));
  const shown = fields.filter((f) => f !== status);

  const panel = row.panel ? renderPanel(row.panel.kind, { data: row.panel.data, row, screen: screen.screen }) : null;
  const more = (row.panels ?? []).map((p, i) => ({ key: `panel${i + 1}`, label: PANEL_TAB[p.kind] ?? "More", node: renderPanel(p.kind, { data: p.data, row, screen: screen.screen }) }));
  const tabs: DialogTab[] = [
    ...(panel ? [{ key: "panel", label: PANEL_TAB[row.panel!.kind] ?? "Overview" }] : []),
    { key: "details", label: "Details", count: shown.length },
    ...more.map((m) => ({ key: m.key, label: m.label })),
  ];
  /* Why the held-back action just pressed cannot be taken — a tablet has no hover for a title. */
  const [why, setWhy] = useState<{ l: string; why: string } | null>(null);
  const [tab, setTab] = useState(tabs[0].key);
  const active = tabs.some((t) => t.key === tab) ? tab : tabs[0].key;

  /* An action does NOT close the record: the list refreshes under it, so the
     person sees what the action changed and can take the next one. A record
     the action removes from the list (deleted, filtered out) closes on its
     own, because the list no longer holds a row to draw. */
  return (
    <ErpDialog onClose={onClose} label={title} size={panel || more.length ? "lg" : "md"} tall={tabs.length > 1}>
      <DialogHeader onClose={onClose} aside={status ? <StatusBadge value={status.v} /> : null}>
        <SectionLabel>{kind}</SectionLabel>
        <DialogTitle className="mt-0.5">{title}</DialogTitle>
        {row.header ? <div className="mt-0.5 text-meta text-body">{row.header}</div> : null}
        {flags.length ? (
          <div className="mt-2 flex flex-wrap gap-1">
            {flags.map((f) => (
              <FlagBadge key={f} flag={f} />
            ))}
          </div>
        ) : null}
        {row.contacts?.length ? (
          <div className="mt-2.5 flex flex-wrap gap-2">
            {row.contacts.map((k) => (
              <a
                key={k.href}
                href={k.href}
                target="_blank"
                rel="noopener"
                className="inline-flex h-8 items-center rounded-control border border-line bg-surface px-2.5 text-meta text-brand-hover no-underline hover:bg-canvas"
              >
                {k.l}
              </a>
            ))}
          </div>
        ) : null}
      </DialogHeader>
      {tabs.length > 1 ? <TabBar tabs={tabs} active={active} onChange={setTab} /> : null}
      <DialogBody>
        {stages ? <StageBar values={stages.values} at={String(row.v[stages.key] ?? "")} tones={tones} /> : null}
        {active === "panel" ? panel : null}
        {more.map((m) => (active === m.key ? <div key={m.key}>{m.node}</div> : null))}
        {active === "details" ? (
          <>
            <dl className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2.5">
              {shown.map((f, i) => (
                <div key={`${f.l}:${i}`} className="min-w-0 rounded-card border border-line px-3.5 py-3">
                  <dt className={cx(eyebrowClass, "flex items-center gap-1.5 text-faint")}>
                    {f.l}
                    {f.der ? (
                      <span title="Worked out for you" className="flex">
                        <Icon n="calc" s={12} />
                        <span className="sr-only">Worked out for you</span>
                      </span>
                    ) : null}
                  </dt>
                  <dd className="mt-1">
                    {f.status && f.v !== "—" ? (
                      <StatusBadge value={f.v} />
                    ) : (
                      <span className={cx("block text-md font-semibold break-words tabular-nums", f.v === "—" ? "text-line-strong" : "text-ink")}>{f.v}</span>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
            {hiddenCount ? (
              <div className="flex items-center gap-1.5 text-meta text-muted" title="Not shown on your account">
                <Icon n="lock" s={14} />
                {hiddenCount} hidden
              </div>
            ) : null}
          </>
        ) : null}
        {why ? (
          <div role="status" className={cx(insetClass, "flex items-start gap-2 text-sm text-body")}>
            <span className="mt-0.5 flex text-muted">
              <Icon n="lock" s={14} />
            </span>
            <span>
              <span className="font-medium text-ink">{why.l}</span> · {why.why}
            </span>
          </div>
        ) : null}
      </DialogBody>
      {acts.length || row.by ? (
        <DialogFooter left={row.by}>
          {(() => {
            /* Four buttons are read at a glance; seven are a row somebody reads
               word by word. The primary and the first ready actions get buttons,
               the rest — held-back ones included, with their reason — go under More. */
            /* The primary keeps its button even while it is held back: it is the
               action the record is waiting on, and pressing it says why. */
            const primary = acts.filter((a) => a.primary);
            const ordered = [...primary, ...acts.filter((a) => !a.primary)];
            const ready = acts.filter((a) => !a.primary && !a.why);
            const shown = (acts.length <= BUTTONS_MAX ? ordered : [...primary, ...ready].slice(0, BUTTONS_MAX - 1)).reverse();
            const rest = acts.length <= BUTTONS_MAX ? [] : ordered.filter((a) => !shown.includes(a));
            return (
              <>
                <MoreMenu
                  items={rest.map((a) => ({
                    key: a.id,
                    label: a.l,
                    disabled: !!a.why,
                    why: a.why,
                    danger: DANGER.test(a.l),
                    onSelect: () => (a.why ? setWhy({ l: a.l, why: a.why }) : ui.act(screen.screen, a, row.id)),
                  }))}
                />
                {shown.map((a) => {
            const okA = !a.why;
            return (
              <Button
                key={a.id}
                variant={a.primary && okA ? "primary" : "secondary"}
                onClick={() => (okA ? ui.act(screen.screen, a, row.id) : setWhy({ l: a.l, why: a.why! }))}
                title={a.why || a.l}
                aria-disabled={!okA}
                className={cx(a.ai && okA && !a.primary && "border-brand text-brand-hover", !okA && "cursor-help opacity-50")}
              >
                {!okA ? <Icon n="lock" s={14} /> : a.ai ? <Icon n="spark" /> : null}
                {a.l}
              </Button>
            );
                })}
              </>
            );
          })()}
        </DialogFooter>
      ) : null}
    </ErpDialog>
  );
}

/**
 * The v4 stage bar: one segment per stage, those behind the record in brand,
 * the one it is at in lime (red where that stage is a problem), the rest grey.
 * Drawn only where the record's status is one of the stages.
 */
function StageBar({ values, at, tones }: { values: string[]; at: string; tones: Record<string, Tone> }) {
  const cur = values.indexOf(at);
  if (cur < 0 || values.length < 2) return null;
  return (
    <ol className="grid gap-2.5" style={{ gridTemplateColumns: `repeat(${values.length}, minmax(0, 1fr))` }}>
      {values.map((v, i) => (
        <li key={v} className="flex min-w-0 flex-col gap-2">
          <span className={cx("h-1 rounded-full", i < cur ? "bg-brand" : i === cur ? (tones[v] === "danger" ? "bg-danger" : "bg-brand-lime") : "bg-divider")} />
          <span className={cx("truncate text-meta", i > cur ? "text-faint" : "text-ink", i === cur ? "font-bold" : "font-medium")} title={v}>
            {v}
          </span>
        </li>
      ))}
    </ol>
  );
}
