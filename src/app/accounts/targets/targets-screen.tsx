"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  MetricStrip,
  MoneyInput,
  PageHeader,
  Progress,
  SectionLabel,
  Select,
  Td,
  Th,
  Tr,
  cx,
} from "@/components/ui/primitives";
import { Drawer, DrawerHeader, Modal, RowMenu, Tabs } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { PersonPicker, type Person } from "@/components/crm/person-picker";
import { APP_TIMEZONE } from "@/lib/business-date";
import { money, periodLabel } from "@/lib/format";
import {
  publishSalesTarget,
  saveSalesTarget,
  targetRevisionHistory,
  type TargetRevisionEntry,
} from "@/lib/actions/sales-targets";
import type { Baseline, TargetRow } from "@/lib/services/sales-target-service";
import type { PerformanceReading } from "@/lib/services/performance-service";

/** A row for somebody added by hand, before they have ever been saved. */
function blankRow(person: Person): TargetRow {
  return {
    userId: person.id,
    userName: person.name,
    targetId: null,
    status: null,
    revenueTargetPaise: null,
    volumeTargetMl: null,
    newCustomerTarget: null,
    collectionTargetPaise: null,
    activityTarget: null,
    publishedAt: null,
    bands: [],
    revisions: 0,
    carriedForward: false,
  };
}

/* ---------------------------------------------------------------------------
 * Sales targets, set and managed from the Accounts desk.
 *
 * Two tabs rather than two screens: SETTING a target and watching how it is
 * landing are one job here, not two — the desk deciding whether to revise a
 * number needs the same month's scorecard in front of it, not a link to
 * another app it may not even hold. "Set targets" is the editor; "This
 * month's scorecard" is `readingsForPeriod`, the exact reading the Sales
 * Dashboard and a person's own Performance screen are built from, so a figure
 * here can never disagree with the one they see.
 * ------------------------------------------------------------------------- */

type Tab = "set" | "scorecard";

export function TargetsScreen({
  period,
  rows,
  addable,
  categories,
  baselines,
  baselineMonths,
  revisionReasons,
  readings,
  unattributed,
}: {
  period: string;
  rows: TargetRow[];
  /** Everybody NOT already shown — added by hand anyway, from this screen too. */
  addable: Person[];
  categories: { id: string; name: string; isResidual: boolean }[];
  baselines: Record<string, Baseline>;
  baselineMonths: number;
  revisionReasons: string[];
  readings: PerformanceReading[];
  unattributed: { revenuePaise: number; customers: number };
}) {
  const router = useRouter();

  const [tab, setTab] = React.useState<Tab>("set");
  const [editing, setEditing] = React.useState<TargetRow | null>(null);
  const [historyFor, setHistoryFor] = React.useState<TargetRow | null>(null);
  const [manualRows, setManualRows] = React.useState<TargetRow[]>([]);
  const [picking, setPicking] = React.useState(false);
  const [pickedId, setPickedId] = React.useState<string | null>(null);

  const allRows = [...rows, ...manualRows];
  const published = allRows.filter((r) => r.status === "published").length;
  const draft = allRows.filter((r) => r.status === "draft").length;
  const unset = allRows.filter((r) => !r.targetId).length;

  return (
    <div className="px-6 pt-6 pb-10">
      <PageHeader
        title="Sales targets"
        subtitle="Per person, per month — revenue, volume, new customers, collection and product mix. Nothing reaches anybody until it is published. The list is telecallers and field sales by default; add anybody else by hand."
        actions={
          <>
            <Select
              value={period}
              onChange={(e) => router.push(`/accounts/targets?period=${e.target.value}`)}
              className="h-9"
            >
              {periodOptions(period).map((p) => (
                <option key={p} value={p}>
                  {periodLabel(p)}
                </option>
              ))}
            </Select>
            {addable.length ? (
              <Button variant="secondary" onClick={() => setPicking(true)}>
                + Add someone
              </Button>
            ) : null}
          </>
        }
      />

      <Modal
        open={picking}
        onClose={() => {
          setPicking(false);
          setPickedId(null);
        }}
        title="Add someone to this month's targets"
        width={420}
      >
        <p className="mb-3 text-[13px] text-muted">
          Not a telecaller or a field salesman on the calling book — everybody else who might
          still need a number this month.
        </p>
        <PersonPicker
          people={addable}
          value={pickedId}
          onChange={(id) => {
            setPickedId(id);
            const person = addable.find((p) => p.id === id);
            if (!person) return;
            setManualRows((prev) =>
              prev.some((r) => r.userId === person.id) ? prev : [...prev, blankRow(person)],
            );
            setEditing(blankRow(person));
            setPicking(false);
            setPickedId(null);
          }}
          label="Person"
        />
      </Modal>

      {unattributed.revenuePaise > 0 ? (
        <div className="mb-4 rounded-[6px] border border-warn-edge bg-warn-soft px-4 py-3 text-[13px] text-warn-ink">
          {money(unattributed.revenuePaise)} this month belongs to no one&rsquo;s target —{" "}
          {unattributed.customers} {unattributed.customers === 1 ? "customer has" : "customers have"}{" "}
          neither a salesperson nor a back office person. Setting either seat on the customer
          record fixes it; nothing here guesses who it should count towards.
        </div>
      ) : null}

      <MetricStrip
        metrics={[
          { label: "People", value: String(allRows.length) },
          { label: "Published", value: String(published), tone: published ? "success" : "ink" },
          { label: "Draft", value: String(draft) },
          { label: "Not set", value: String(unset), tone: unset ? "danger" : "ink" },
        ]}
      />

      <Tabs
        value={tab}
        onChange={setTab}
        className="mb-4"
        tabs={[
          { key: "set", label: "Set targets", count: allRows.length },
          { key: "scorecard", label: "This month's scorecard", count: readings.length },
        ]}
      />

      {tab === "set" ? (
        <Card className="overflow-auto">
          <table>
            <thead>
              <tr>
                <Th>Person</Th>
                <Th>Status</Th>
                <Th align="right">Revenue</Th>
                <Th align="right">Volume</Th>
                <Th align="right">New</Th>
                <Th align="right">Collection</Th>
                <Th align="right">Activity</Th>
                <Th>Against their own average</Th>
                <Th align="right" />
              </tr>
            </thead>
            <tbody>
              {allRows.map((r) => {
                const base = baselines[r.userId];
                return (
                  <Tr key={r.userId} className="hover:bg-canvas">
                    <Td className="font-medium text-ink">{r.userName}</Td>
                    <Td>
                      {r.status === "published" && r.carriedForward ? (
                        <Badge tone="brand" title="Copied forward from last month's published target, untouched since.">
                          Carried forward
                        </Badge>
                      ) : r.status === "published" ? (
                        <Badge tone="success">Published</Badge>
                      ) : r.status === "draft" ? (
                        <Badge tone="warn">Draft</Badge>
                      ) : (
                        <span className="text-[12px] text-muted">Not set</span>
                      )}
                    </Td>
                    <Td align="right">{orDash(r.revenueTargetPaise, money)}</Td>
                    <Td align="right">
                      {orDash(r.volumeTargetMl, (v) => `${Math.round(v / 1000).toLocaleString("en-IN")} L`)}
                    </Td>
                    <Td align="right">{orDash(r.newCustomerTarget, String)}</Td>
                    <Td align="right">{orDash(r.collectionTargetPaise, money)}</Td>
                    <Td align="right">{orDash(r.activityTarget, String)}</Td>
                    <Td>
                      <Growth target={r.revenueTargetPaise} baseline={base} months={baselineMonths} />
                    </Td>
                    <Td align="right">
                      <span className="flex justify-end">
                        <RowMenu
                          items={[
                            {
                              label: r.targetId ? "Change target" : "Set target",
                              onSelect: () => setEditing(r),
                            },
                            {
                              label: "Revision history",
                              onSelect: () => setHistoryFor(r),
                              disabled: r.revisions === 0,
                              title: r.revisions === 0 ? "Never revised since it was published." : undefined,
                            },
                          ]}
                        />
                      </span>
                    </Td>
                  </Tr>
                );
              })}
              {!allRows.length ? (
                <Tr>
                  <Td colSpan={9} className="py-8 text-center text-muted">
                    Nobody carries a customer book this month, so there is nobody to set a target
                    for.
                  </Td>
                </Tr>
              ) : null}
            </tbody>
          </table>
        </Card>
      ) : (
        <Scorecard readings={readings} />
      )}

      <TargetEditorModal
        row={editing}
        period={period}
        categories={categories}
        baseline={editing ? baselines[editing.userId] : undefined}
        baselineMonths={baselineMonths}
        revisionReasons={revisionReasons}
        onClose={() => setEditing(null)}
        onSaved={() => {
          // A person added by hand now has a real target row, which the
          // refreshed page brings back through `rows` — the hand-added
          // placeholder would otherwise sit beside it as a duplicate.
          if (editing) {
            const savedUserId = editing.userId;
            setManualRows((prev) => prev.filter((m) => m.userId !== savedUserId));
          }
          setEditing(null);
          router.refresh();
        }}
      />

      <RevisionHistoryDrawer row={historyFor} onClose={() => setHistoryFor(null)} />

      <p className="mt-3 max-w-[860px] text-[13px] text-pretty text-muted">
        A revenue target and a volume target are both set, and the second is the point: a price
        revision raises what a month is worth without a single extra can leaving the godown, so
        litres are what say whether more was actually sold. Published targets can be changed, and
        every change is recorded with its reason and told to the person it belongs to.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------- the editor */

const toPaise = (rupees: string): number | null => {
  const t = rupees.trim();
  if (!t) return null;
  const n = Number(t.replace(/,/g, ""));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
};
const toRupees = (paise: number | null): string =>
  paise === null ? "" : String(Math.round(paise / 100));

const toMl = (litres: string): number | null => {
  const t = litres.trim();
  if (!t) return null;
  const n = Number(t.replace(/,/g, ""));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1000) : null;
};
const toLitres = (ml: number | null): string =>
  ml === null ? "" : String(Math.round(ml / 1000));

const toCount = (v: string): number | null => {
  const t = v.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isInteger(n) && n >= 0 ? n : null;
};

type Band = {
  categoryId: string;
  name: string;
  isResidual: boolean;
  minimum: string;
  target: string;
  stretch: string;
};

function TargetEditorModal({
  row,
  period,
  categories,
  baseline,
  baselineMonths,
  revisionReasons,
  onClose,
  onSaved,
}: {
  row: TargetRow | null;
  period: string;
  categories: { id: string; name: string; isResidual: boolean }[];
  baseline: Baseline | undefined;
  baselineMonths: number;
  revisionReasons: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  if (!row) return null;
  return (
    <TargetEditorModalBody
      key={`${row.userId}-${period}`}
      row={row}
      period={period}
      categories={categories}
      baseline={baseline}
      baselineMonths={baselineMonths}
      revisionReasons={revisionReasons}
      onClose={onClose}
      onSaved={onSaved}
    />
  );
}

function TargetEditorModalBody({
  row,
  period,
  categories,
  baseline,
  baselineMonths,
  revisionReasons,
  onClose,
  onSaved,
}: {
  row: TargetRow;
  period: string;
  categories: { id: string; name: string; isResidual: boolean }[];
  baseline: Baseline | undefined;
  baselineMonths: number;
  revisionReasons: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { run } = useToast();
  const [revenue, setRevenue] = React.useState(toRupees(row.revenueTargetPaise));
  const [volume, setVolume] = React.useState(toLitres(row.volumeTargetMl));
  const [newCustomers, setNewCustomers] = React.useState(
    row.newCustomerTarget === null ? "" : String(row.newCustomerTarget),
  );
  const [collection, setCollection] = React.useState(toRupees(row.collectionTargetPaise));
  const [activity, setActivity] = React.useState(
    row.activityTarget === null ? "" : String(row.activityTarget),
  );
  const [reason, setReason] = React.useState("");
  const [reasonNote, setReasonNote] = React.useState("");
  // Only the categories this target already carries — not every active one.
  // A book with two categories and a book with eight both start from what is
  // actually theirs; "Add category" is how either grows, never a wall of
  // rows to skip past for the categories that do not apply here.
  const [bands, setBands] = React.useState<Band[]>(() =>
    row.bands.map((existing) => {
      const cat = categories.find((c) => c.id === existing.categoryId);
      return {
        categoryId: existing.categoryId,
        name: existing.name,
        isResidual: cat?.isResidual ?? false,
        minimum: String(existing.minimumBp / 100),
        target: String(existing.targetBp / 100),
        stretch: String(existing.stretchBp / 100),
      };
    }),
  );
  const available = categories.filter((c) => !bands.some((b) => b.categoryId === c.id));

  function addCategory(categoryId: string) {
    const cat = categories.find((c) => c.id === categoryId);
    if (!cat) return;
    setBands([
      ...bands,
      { categoryId: cat.id, name: cat.name, isResidual: cat.isResidual, minimum: "", target: "", stretch: "" },
    ]);
  }

  function removeCategory(categoryId: string) {
    setBands(bands.filter((b) => b.categoryId !== categoryId));
  }

  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const isPublished = row.status === "published";
  const shareTotal = bands.reduce((s, b) => s + (Number(b.target) || 0), 0);

  async function save(thenPublish: boolean) {
    setError(null);
    setBusy(true);
    try {
      const filled = bands.filter((b) => b.target !== "" || b.minimum !== "");
      const result = await run(
        saveSalesTarget({
          userId: row.userId,
          period,
          revenueTargetPaise: toPaise(revenue),
          volumeTargetMl: toMl(volume),
          newCustomerTarget: toCount(newCustomers),
          collectionTargetPaise: toPaise(collection),
          activityTarget: toCount(activity),
          notes: null,
          bands: filled.map((b) => ({
            categoryId: b.categoryId,
            minimumBp: Math.round((Number(b.minimum) || 0) * 100),
            targetBp: Math.round((Number(b.target) || 0) * 100),
            stretchBp: Math.round((Number(b.stretch) || Number(b.target) || 0) * 100),
          })),
          reason: isPublished ? reason : undefined,
          reasonNote: isPublished && reasonNote ? reasonNote : undefined,
        }),
      );
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (!thenPublish) {
        onSaved();
        return;
      }
      const publishResult = await run(publishSalesTarget(result.data.targetId));
      if (!publishResult.ok) {
        setError(publishResult.error);
        return;
      }
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`${row.targetId ? "Change target" : "Set target"} · ${row.userName}`}
      width={640}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => save(false)}>
            {isPublished ? "Save the change" : "Save as draft"}
          </Button>
          {!isPublished ? (
            <Button variant="primary" disabled={busy} onClick={() => save(true)}>
              Save and publish
            </Button>
          ) : null}
        </>
      }
    >
      <div className="mb-4 grid grid-cols-2 gap-3.5">
        <Field
          label="Revenue target"
          hint={
            baseline
              ? `${money(baseline.revenuePaise)} a month over the last ${baseline.monthsCounted}`
              : undefined
          }
        >
          <MoneyInput value={revenue} onChange={(e) => setRevenue(e.target.value)} placeholder="not asked" />
        </Field>
        <Field
          label="Volume target (litres)"
          hint={
            baseline?.millilitres
              ? `${Math.round(baseline.millilitres / 1000).toLocaleString("en-IN")} L a month`
              : "no measured history yet"
          }
        >
          <Input inputMode="numeric" value={volume} onChange={(e) => setVolume(e.target.value)} placeholder="not asked" />
        </Field>
        <Field
          label="New customers"
          hint={baseline ? `${baseline.newCustomers} a month` : undefined}
        >
          <Input inputMode="numeric" value={newCustomers} onChange={(e) => setNewCustomers(e.target.value)} placeholder="not asked" />
        </Field>
        <Field
          label="Collection target"
          hint={baseline ? `${money(baseline.collectionPaise)} a month` : undefined}
        >
          <MoneyInput value={collection} onChange={(e) => setCollection(e.target.value)} placeholder="not asked" />
        </Field>
        <Field label="Visits and calls" hint="calls logged plus visits made">
          <Input inputMode="numeric" value={activity} onChange={(e) => setActivity(e.target.value)} placeholder="not asked" />
        </Field>
        <div className="flex items-end">
          <Growth
            target={toPaise(revenue)}
            baseline={baseline}
            months={baselineMonths}
          />
        </div>
      </div>

      <SectionLabel>Product mix — share of the month&rsquo;s value</SectionLabel>
      <p className="mt-1 mb-3 text-[12px] text-muted">
        Three numbers rather than one, because a book selling into furniture and one selling into
        automotive cannot be held to the same 30%. Below the minimum a category falls away to
        nothing; stretch is exceptional. Add only the categories that matter for this person —
        one, two, or all of them.
      </p>
      <div className="mb-2 overflow-x-auto rounded-[4px] border border-line">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-line bg-canvas text-[11px] tracking-[0.04em] text-muted uppercase">
              <th className="px-2.5 py-1.5 text-left font-medium">Category</th>
              <th className="px-2.5 py-1.5 text-right font-medium">Minimum %</th>
              <th className="px-2.5 py-1.5 text-right font-medium">Target %</th>
              <th className="px-2.5 py-1.5 text-right font-medium">Stretch %</th>
              <th className="px-2.5 py-1.5 text-right font-medium">{""}</th>
            </tr>
          </thead>
          <tbody>
            {bands.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-2.5 py-2 text-[13px] text-muted">
                  No categories added yet. Product mix is left out of this target&rsquo;s score
                  until at least one is added below.
                </td>
              </tr>
            ) : null}
            {bands.map((b, i) => (
              <tr key={b.categoryId} className="border-b border-divider last:border-0">
                <td className="px-2.5 py-1.5 text-body">
                  {b.name}
                  {b.isResidual ? (
                    <span
                      className="ml-1.5 text-[11px] text-muted"
                      title="Everything not classified into another category, plus any order line whose product could not be matched to the catalogue."
                    >
                      (everything else)
                    </span>
                  ) : null}
                </td>
                {(["minimum", "target", "stretch"] as const).map((k) => (
                  <td key={k} className="px-2.5 py-1.5">
                    <input
                      inputMode="decimal"
                      value={b[k]}
                      onChange={(e) => {
                        const next = [...bands];
                        next[i] = { ...next[i], [k]: e.target.value };
                        setBands(next);
                      }}
                      className="w-[74px] rounded-[4px] border border-line bg-surface px-2 py-1 text-right tabular-nums"
                    />
                  </td>
                ))}
                <td className="px-2.5 py-1.5 text-right">
                  <button
                    type="button"
                    onClick={() => removeCategory(b.categoryId)}
                    title={`Remove ${b.name} from this target`}
                    className="rounded-[4px] px-1.5 py-0.5 text-[12px] text-muted hover:bg-canvas hover:text-danger"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
            {bands.length > 0 ? (
              <tr>
                <td className="px-2.5 pt-2 pb-1.5 text-[12px] text-muted">Targets total</td>
                <td />
                <td
                  className={cx(
                    "px-2.5 pt-2 pb-1.5 text-right text-[12px] tabular-nums",
                    shareTotal > 100 ? "font-medium text-danger" : "text-muted",
                  )}
                >
                  {shareTotal.toFixed(1)}%
                </td>
                <td />
                <td />
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {available.length > 0 ? (
        <div className="mb-4">
          <Select
            value=""
            onChange={(e) => {
              if (e.target.value) addCategory(e.target.value);
            }}
          >
            <option value="">+ Add category…</option>
            {available.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.isResidual ? " (everything else)" : ""}
              </option>
            ))}
          </Select>
        </div>
      ) : null}

      {isPublished ? (
        <div className="mb-4 rounded-[6px] border border-warn-edge bg-warn-soft px-3.5 py-3">
          <div className="mb-2 text-[13px] text-warn-ink">
            This target is published. {row.userName} is being measured against it, so a change
            needs a reason — it goes on the record and {row.userName} is told.
            {row.revisions > 0
              ? ` It has already been changed ${row.revisions} ${row.revisions === 1 ? "time" : "times"}.`
              : ""}
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <Field label="Reason">
              <Select value={reason} onChange={(e) => setReason(e.target.value)}>
                <option value="">Pick a reason…</option>
                {revisionReasons.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Note (optional)">
              <Input
                value={reasonNote}
                onChange={(e) => setReasonNote(e.target.value)}
                placeholder="Anything worth adding"
              />
            </Field>
          </div>
        </div>
      ) : null}

      {error ? <p className="text-[13px] text-danger">{error}</p> : null}
    </Modal>
  );
}

function Growth({
  target,
  baseline,
  months,
}: {
  target: number | null;
  baseline: Baseline | undefined;
  months: number;
}) {
  if (!baseline) return <span className="text-[12px] text-muted">no history yet</span>;
  if (!baseline.revenuePaise) {
    return <span className="text-[12px] text-muted">no sales in the last {months} months</span>;
  }
  if (target === null) {
    return <span className="text-[12px] text-muted">averages {money(baseline.revenuePaise)}</span>;
  }
  const growth = ((target - baseline.revenuePaise) / baseline.revenuePaise) * 100;
  const tone = growth > 40 ? "text-warn-ink" : growth < 0 ? "text-muted" : "text-body";
  return (
    <span className={cx("text-[12px]", tone)}>
      {growth >= 0 ? "+" : ""}
      {growth.toFixed(1)}% on {money(baseline.revenuePaise)}
    </span>
  );
}

function orDash(v: number | null, render: (n: number) => string) {
  return v === null ? (
    <span className="text-muted">—</span>
  ) : (
    <span className="tabular-nums">{render(v)}</span>
  );
}

/* --------------------------------------------------------------- history */

function RevisionHistoryDrawer({
  row,
  onClose,
}: {
  row: TargetRow | null;
  onClose: () => void;
}) {
  return (
    <Drawer open={Boolean(row)} onClose={onClose} width={480} label="Revision history">
      <DrawerHeader onClose={onClose}>
        <div>
          <div className="text-lg font-semibold text-ink">Revision history</div>
          {row ? <div className="text-[13px] text-muted">{row.userName}</div> : null}
        </div>
      </DrawerHeader>
      {/*
       * Keyed on the target, so switching rows without closing the drawer
       * remounts this with fresh state rather than resetting it in an effect
       * — the same rule `ConfirmDialog` and `CallPanel` follow.
       */}
      {row?.targetId ? <RevisionHistoryBody key={row.targetId} targetId={row.targetId} /> : null}
    </Drawer>
  );
}

function RevisionHistoryBody({ targetId }: { targetId: string }) {
  const [entries, setEntries] = React.useState<TargetRevisionEntry[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    targetRevisionHistory(targetId).then((result) => {
      if (cancelled) return;
      if (result.ok) setEntries(result.data);
      else setError(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, [targetId]);

  return (
    <div className="flex-1 overflow-y-auto px-5 py-4">
      {error ? <p className="text-[13px] text-danger">{error}</p> : null}
      {!error && entries === null ? <p className="text-[13px] text-muted">Loading…</p> : null}
      {entries?.length === 0 ? (
        <p className="text-[13px] text-muted">Never revised since it was published.</p>
      ) : null}
      {entries?.map((e, i) => (
        <div key={i} className="border-b border-divider py-3 last:border-0">
          <div className="text-[13px] font-medium text-ink">
            {e.from ?? "not set"} → {e.to ?? "not set"}
          </div>
          <div className="mt-0.5 text-[12px] text-muted">
            {e.reason}
            {e.reasonNote ? ` — ${e.reasonNote}` : ""}
          </div>
          <div className="mt-1 text-[11px] text-muted">
            {e.changedByName ?? "Somebody"} ·{" "}
            {new Intl.DateTimeFormat("en-IN", {
              dateStyle: "medium",
              timeStyle: "short",
              timeZone: APP_TIMEZONE,
            }).format(new Date(e.changedAt))}
          </div>
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------- scorecard */

function componentOf(reading: PerformanceReading, key: string) {
  return reading.score.components.find((c) => c.key === key) ?? null;
}

function achievementCell(reading: PerformanceReading, key: string) {
  const c = componentOf(reading, key);
  if (!c || c.target === 0) return <span className="text-muted">—</span>;
  const bp = c.achievementBp ?? 0;
  const pct = Math.round(bp / 100);
  const tone = pct >= 100 ? "success" : pct >= 60 ? "brand" : "danger";
  return (
    <span className="flex min-w-[130px] items-center gap-2">
      <Progress value={Math.min(100, pct)} tone={tone} className="w-14 flex-none" />
      <span className="text-[12px] tabular-nums text-body">{pct}%</span>
    </span>
  );
}

function Scorecard({ readings }: { readings: PerformanceReading[] }) {
  const scored = readings.filter((r) => r.hasTarget);
  const days = readings[0];

  return (
    <>
      <p className="mb-3 max-w-[860px] text-[13px] text-muted">
        {scored.length} of {readings.length} carrying a target this month, scored against orders
        approved, receipts confirmed, calls logged and visits made so far —{" "}
        {days ? `${days.workingDaysElapsed} of ${days.workingDaysTotal} working days in` : "the month just starting"}
        . A draft target is shown here so its number can be judged before it is published; nobody
        sees a score against a draft on their own screen.
      </p>
      <Card className="overflow-auto">
        <table>
          <thead>
            <tr>
              <Th>Person</Th>
              <Th>Target</Th>
              <Th align="right">Score</Th>
              <Th>Revenue</Th>
              <Th>Volume</Th>
              <Th>New customers</Th>
              <Th>Collection</Th>
              <Th>Alerts</Th>
            </tr>
          </thead>
          <tbody>
            {readings.map((r) => (
              <Tr key={r.userId} className="hover:bg-canvas">
                <Td className="font-medium text-ink">{r.userName}</Td>
                <Td>
                  {!r.hasTarget ? (
                    <span className="text-[12px] text-muted">no target</span>
                  ) : (
                    <Badge tone="neutral">this month</Badge>
                  )}
                </Td>
                <Td align="right">
                  {r.hasTarget ? (
                    <span className="font-medium text-ink tabular-nums">
                      {(r.score.totalBp / 100).toFixed(0)}
                    </span>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                  {r.hasTarget ? (
                    <span className="ml-1 text-[11px] text-muted">{r.rating}</span>
                  ) : null}
                </Td>
                <Td>{r.hasTarget ? achievementCell(r, "revenue") : money(r.actuals.revenuePaise)}</Td>
                <Td>
                  {r.hasTarget
                    ? achievementCell(r, "volume")
                    : `${Math.round(r.actuals.millilitres / 1000).toLocaleString("en-IN")} L`}
                </Td>
                <Td>{r.hasTarget ? achievementCell(r, "newCustomers") : String(r.actuals.newCustomers)}</Td>
                <Td>{r.hasTarget ? achievementCell(r, "collection") : money(r.actuals.collectionPaise)}</Td>
                <Td>
                  {r.alerts.length ? (
                    <span className="flex flex-wrap gap-1">
                      {r.alerts.map((a) => (
                        <Badge
                          key={a.key}
                          tone={a.severity === "high" ? "danger" : "warn"}
                          title={a.message}
                        >
                          {a.key.replace(/-/g, " ")}
                        </Badge>
                      ))}
                    </span>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </Td>
              </Tr>
            ))}
            {!readings.length ? (
              <Tr>
                <Td colSpan={8} className="py-8 text-center text-muted">
                  Nobody has sold or been set a target this month yet.
                </Td>
              </Tr>
            ) : null}
          </tbody>
        </table>
      </Card>
    </>
  );
}

function recentPeriods(): string[] {
  const now = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: APP_TIMEZONE,
      year: "numeric",
      month: "2-digit",
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );

  // Next month first — targets for the month ahead are set in advance, most
  // often in the last week of the one before, so "next month" has to be a
  // choice in this list rather than something only reachable by typing a URL.
  let year = Number(now.year);
  let month = Number(now.month) + 1;
  if (month === 13) {
    month = 1;
    year += 1;
  }

  const out: string[] = [];
  for (let i = 0; i < 8; i++) {
    out.push(`${year}-${String(month).padStart(2, "0")}`);
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
  }
  return out;
}

/**
 * `recentPeriods()` plus whichever period is actually on the URL.
 *
 * A bookmark, a roll-forward, or a link from an old month can all land on a
 * period outside that window — a `<select>` bound to a value with no matching
 * `<option>` renders as though nothing were selected, which reads as the
 * screen having lost track of what it is showing.
 */
function periodOptions(current: string): string[] {
  const options = recentPeriods();
  return options.includes(current)
    ? options
    : [...options, current].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}
