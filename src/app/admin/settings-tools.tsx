"use client";

import * as React from "react";
import { Badge, Button, Card, Textarea, cx } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/overlays";
import type { SchemaTab } from "@/lib/config/schema-contract";
import { SCHEDULED_CHANGES, SETTING_HISTORY } from "./data-platform";
import { readable, savedValue, tabFields, type Values } from "./settings-model";
import { useAdmin } from "./store";

/* ---------------------------------------------------------------------------
 * The tools around a settings section, rather than inside it.
 *
 * A settings screen that only sets values is half a tool. The other half is
 * being able to see what it used to be, what it differs from, what somebody
 * else already scheduled, and how to put it all back.
 * ------------------------------------------------------------------------- */

export function SettingsToolbar({
  tab,
  owner,
  values,
}: {
  tab: SchemaTab;
  owner: string;
  values: Values;
}) {
  const [open, setOpen] = React.useState<null | "compare" | "transfer" | "scheduled">(null);
  const fields = tabFields(tab);
  const differing = fields.filter(
    (f) => JSON.stringify(savedValue(values, f)) !== JSON.stringify(f.def),
  );

  return (
    <>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onClick={() => setOpen("compare")}>
          Compare with defaults
          {differing.length ? <Badge tone="brand">{differing.length}</Badge> : null}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen("transfer")}>
          Export or import configuration
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen("scheduled")}>
          Scheduled changes
          {SCHEDULED_CHANGES.length ? <Badge tone="warn">{SCHEDULED_CHANGES.length}</Badge> : null}
        </Button>
      </div>

      <CompareModal
        open={open === "compare"}
        onClose={() => setOpen(null)}
        tab={tab}
        values={values}
        owner={owner}
      />
      <TransferModal open={open === "transfer"} onClose={() => setOpen(null)} tab={tab} values={values} owner={owner} />
      <ScheduledModal open={open === "scheduled"} onClose={() => setOpen(null)} owner={owner} />
    </>
  );
}

/* --------------------------------------------------- comparison vs defaults */

function CompareModal({
  open,
  onClose,
  tab,
  values,
  owner,
}: {
  open: boolean;
  onClose: () => void;
  tab: SchemaTab;
  values: Values;
  owner: string;
}) {
  const fields = tabFields(tab);
  const rows = fields.map((f) => ({
    label: f.label,
    now: readable(savedValue(values, f)),
    def: readable(f.def),
    differs: JSON.stringify(savedValue(values, f)) !== JSON.stringify(f.def),
  }));
  const differing = rows.filter((r) => r.differs);

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={680}
      title={`${owner} · ${tab.label} against its defaults`}
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="text-sm leading-[21px] text-body">
        {differing.length
          ? `${differing.length} of ${rows.length} settings in this section have been tuned away from what the app declares. This is the fastest way to understand how a system has been set up.`
          : "Every setting in this section is still on the value the app declares."}
      </div>
      <div className="mt-3.5 overflow-hidden rounded-[4px] border border-line">
        {rows.map((r, i) => (
          <div
            key={r.label}
            className={cx(
              "flex items-baseline gap-3 px-3.5 py-2.5",
              i ? "border-t border-canvas" : "",
              r.differs ? "bg-brand-soft" : "",
            )}
          >
            <span className="min-w-0 flex-1 text-sm text-ink">{r.label}</span>
            <span className="w-[140px] flex-none text-right font-mono text-[13px] text-muted line-through decoration-line-strong">
              {r.differs ? r.def : ""}
            </span>
            <span
              className={cx(
                "w-[140px] flex-none text-right font-mono text-[13px]",
                r.differs ? "font-medium text-ink" : "text-muted",
              )}
            >
              {r.now}
            </span>
          </div>
        ))}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------- export and import */

function TransferModal({
  open,
  onClose,
  tab,
  values,
  owner,
}: {
  open: boolean;
  onClose: () => void;
  tab: SchemaTab;
  values: Values;
  owner: string;
}) {
  const { notify } = useAdmin();
  const fields = tabFields(tab);
  const current = Object.fromEntries(fields.map((f) => [f.key, savedValue(values, f)]));
  const [incoming, setIncoming] = React.useState("");

  let parsed: Record<string, unknown> | null = null;
  let parseError = "";
  if (incoming.trim()) {
    try {
      parsed = JSON.parse(incoming) as Record<string, unknown>;
    } catch {
      parseError = "That is not valid configuration. Paste the file exactly as it was exported.";
    }
  }

  const diff = parsed
    ? fields
        .filter((f) => f.key in parsed! && JSON.stringify(parsed![f.key]) !== JSON.stringify(current[f.key]))
        .map((f) => ({ label: f.label, from: readable(current[f.key]), to: readable(parsed![f.key]) }))
    : [];
  const unknownKeys = parsed ? Object.keys(parsed).filter((k) => !fields.some((f) => f.key === k)) : [];

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={680}
      title={`${owner} · ${tab.label} configuration`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!parsed || !!parseError || diff.length === 0}
            title={
              parseError
                ? "Fix the file first"
                : parsed && diff.length === 0
                  ? "Nothing in that file differs from what is set now"
                  : !parsed
                    ? "Paste a configuration file to import"
                    : undefined
            }
            onClick={() => {
              notify(`${diff.length} settings would be applied as one change set`);
              onClose();
            }}
          >
            Apply {diff.length || ""} change{diff.length === 1 ? "" : "s"}
          </Button>
        </>
      }
    >
      <div className="text-sm leading-[21px] text-body">
        Export this section, tune it elsewhere, and bring it back. Nothing is applied until the diff below has been read.
      </div>

      <Card className="mt-3.5 p-3.5">
        <div className="flex items-center gap-3">
          <span className="min-w-0 flex-1 text-sm font-medium text-ink">
            {fileName(owner, tab.key)}
          </span>
          <span className="text-[13px] text-muted">{fields.length} settings</span>
          <Button size="sm" variant="ghost" onClick={() => notify("Configuration exported")}>
            Export
          </Button>
        </div>
      </Card>

      <label className="mt-4 block">
        <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">
          Import — paste a configuration file
        </span>
        <Textarea
          value={incoming}
          invalid={!!parseError}
          onChange={(e) => setIncoming(e.target.value)}
          placeholder={JSON.stringify({ [fields[0]?.key ?? "key"]: "value" }, null, 2)}
          className="h-[120px] font-mono text-[13px]"
        />
        {parseError ? <span className="mt-1 block text-[13px] text-danger">{parseError}</span> : null}
      </label>

      {parsed && !parseError ? (
        <div className="mt-4">
          <div className="mb-1.5 text-xs font-medium tracking-[0.04em] text-muted uppercase">
            What would change
          </div>
          <div className="overflow-hidden rounded-[4px] border border-line">
            {diff.length === 0 ? (
              <div className="px-3.5 py-3 text-sm text-muted">
                Nothing in that file differs from what is set now.
              </div>
            ) : null}
            {diff.map((d, i) => (
              <div key={d.label} className={cx("px-3.5 py-2.5", i ? "border-t border-canvas" : "")}>
                <div className="text-sm font-medium text-ink">{d.label}</div>
                <div className="font-mono text-[13px] text-muted">
                  {d.from} → <span className="text-ink">{d.to}</span>
                </div>
              </div>
            ))}
          </div>
          {unknownKeys.length ? (
            <div className="mt-2 text-[13px] text-warn-ink">
              {unknownKeys.length} key{unknownKeys.length === 1 ? "" : "s"} in that file are not declared by this app and
              would be ignored: {unknownKeys.join(", ")}.
            </div>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}

function fileName(owner: string, tabKey: string): string {
  const slug = owner.toLowerCase().replace(/\s+/g, "-");
  return slug === tabKey ? `${slug}.json` : `${slug}-${tabKey}.json`;
}

/* ------------------------------------------------------- scheduled changes */

function ScheduledModal({ open, onClose, owner }: { open: boolean; onClose: () => void; owner: string }) {
  const { notify } = useAdmin();
  return (
    <Modal
      open={open}
      onClose={onClose}
      width={620}
      title="Scheduled changes"
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="text-sm leading-[21px] text-body">
        Changes agreed now and applied later — a festival uplift, a year-end tightening. They are listed here so nobody
        is surprised by a threshold that moved on its own.
      </div>
      <div className="mt-3.5 overflow-hidden rounded-[4px] border border-line">
        {SCHEDULED_CHANGES.filter((s) => s.app === owner || owner === "Platform").length === 0 ? (
          <div className="px-3.5 py-3 text-sm text-muted">Nothing is scheduled for {owner}.</div>
        ) : null}
        {SCHEDULED_CHANGES.filter((s) => s.app === owner || owner === "Platform").map((s, i) => (
          <div key={s.id} className={cx("px-3.5 py-3", i ? "border-t border-canvas" : "")}>
            <div className="flex items-baseline gap-2.5">
              <span className="min-w-0 flex-1 text-sm font-medium text-ink">{s.setting}</span>
              <Badge tone="warn">{s.when}</Badge>
            </div>
            <div className="mt-0.5 font-mono text-[13px] text-muted">
              {s.from} → <span className="text-ink">{s.to}</span>
            </div>
            <div className="mt-1 text-[13px] text-muted">
              {s.why} · set by {s.by}
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="mt-2 text-danger"
              onClick={() => notify(`Scheduled change cancelled — ${s.setting} stays as it is`)}
            >
              Cancel this change
            </Button>
          </div>
        ))}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------- inline setting history */

export function SettingHistory({ settingKey, label }: { settingKey: string; label: string }) {
  const [open, setOpen] = React.useState(false);
  const rows = SETTING_HISTORY[settingKey];
  if (!rows) return null;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="cursor-pointer border-none bg-transparent p-0 text-[11px] text-brand hover:underline"
      >
        {rows.length} earlier value{rows.length === 1 ? "" : "s"}
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        width={480}
        title={label}
        footer={
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Close
          </Button>
        }
      >
        <div className="text-sm text-body">
          Every value this setting has held. Shown here rather than in Audit, because this is where the question gets
          asked.
        </div>
        <div className="mt-3.5 border-l-2 border-brand-softer pl-3.5">
          {rows.map((r, i) => (
            <div key={`${r.value}-${r.t}`} className="py-2">
              <div className="flex items-baseline gap-2.5">
                <span className="font-mono text-sm text-ink">{r.value}</span>
                {i === 0 ? <Badge tone="success">Current</Badge> : null}
              </div>
              <div className="text-[13px] text-muted">
                {r.by} · {r.t}
              </div>
            </div>
          ))}
        </div>
      </Modal>
    </>
  );
}
