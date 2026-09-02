"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/overlays";
import { PersonPicker, type Person } from "@/components/crm/person-picker";
import { money } from "@/lib/format";
import {
  publishSalesTarget,
  saveSalesTarget,
} from "@/lib/actions/sales-targets";
import type { Baseline, TargetRow } from "@/lib/services/sales-target-service";
import {
  Banner,
  Cell,
  Empty,
  HeadCell,
  Pill,
  Row,
  ScreenHeader,
  Table,
} from "../parts";

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
    collectionTargetBp: null,
    activityTarget: null,
    publishedAt: null,
    bands: [],
    revisions: 0,
    carriedForward: false,
  };
}

/* ---------------------------------------------------------------------------
 * Setting the month.
 *
 * The screen is a list of people and one editor, rather than a form per person
 * on its own page. Targets are set in one sitting for a whole team, and the
 * comparison between two people is most of the decision — a page you have to
 * leave to see the next person is a page where the second target is set
 * without reference to the first.
 * ------------------------------------------------------------------------- */

type Props = {
  period: string;
  rows: TargetRow[];
  /** Everybody NOT already shown — a manager can add one by hand anyway. */
  addable: Person[];
  categories: { id: string; name: string; isResidual: boolean }[];
  baselines: Record<string, Baseline>;
  baselineMonths: number;
  revisionReasons: string[];
};

/** Rupees on the screen, paise in the database. Never the other way round. */
const toPaise = (rupees: string): number | null => {
  const t = rupees.trim();
  if (!t) return null;
  const n = Number(t.replace(/,/g, ""));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
};
const toRupees = (paise: number | null): string =>
  paise === null ? "" : String(Math.round(paise / 100));

/** Litres on the screen, millilitres in the database. */
const toMl = (litres: string): number | null => {
  const t = litres.trim();
  if (!t) return null;
  const n = Number(t.replace(/,/g, ""));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1000) : null;
};
const toLitres = (ml: number | null): string =>
  ml === null ? "" : String(Math.round(ml / 1000));

/** Whole percent on the screen, basis points in the database. */
const toBp = (percent: string): number | null => {
  const t = percent.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n * 100) : null;
};
const toPercent = (bp: number | null): string => (bp === null ? "" : String(Math.round(bp / 100)));

const toCount = (v: string): number | null => {
  const t = v.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isInteger(n) && n >= 0 ? n : null;
};

export function TargetsScreen({
  period,
  rows,
  addable,
  categories,
  baselines,
  baselineMonths,
  revisionReasons,
}: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ tone: "info" | "danger"; text: string } | null>(
    null,
  );
  const [manualRows, setManualRows] = useState<TargetRow[]>([]);
  const [picking, setPicking] = useState(false);
  const [pickedId, setPickedId] = useState<string | null>(null);

  const allRows = [...rows, ...manualRows];
  const published = allRows.filter((r) => r.status === "published").length;
  const unset = allRows.filter((r) => !r.targetId).length;

  return (
    <div className="p-6">
      <ScreenHeader
        title="Sales targets"
        subtitle={`${monthName(period)} — what each person is being asked for. Nothing reaches anybody until it is published. The list is telecallers and field sales by default; add anybody else by hand.`}
        actions={
          <div className="flex items-center gap-1 text-[13px]">
            <Link
              href={`/sales/targets?period=${shiftMonth(period, -1)}`}
              className="rounded-[4px] border border-line bg-surface px-2.5 py-1.5 text-body no-underline hover:bg-canvas hover:no-underline"
            >
              ←
            </Link>
            <span className="px-2 text-muted">{monthName(period)}</span>
            <Link
              href={`/sales/targets?period=${shiftMonth(period, 1)}`}
              className="rounded-[4px] border border-line bg-surface px-2.5 py-1.5 text-body no-underline hover:bg-canvas hover:no-underline"
            >
              →
            </Link>
            <Link
              href={`/sales/performance?month=${period}`}
              className="ml-2 rounded-[4px] border border-line bg-surface px-2.5 py-1.5 text-body no-underline hover:bg-canvas hover:no-underline"
            >
              See the month
            </Link>
            {addable.length ? (
              <button
                type="button"
                onClick={() => setPicking(true)}
                className="ml-2 rounded-[4px] border border-line bg-surface px-2.5 py-1.5 text-body hover:bg-canvas"
              >
                + Add someone
              </button>
            ) : null}
          </div>
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
          Not a telecaller or a field salesman on the calling book — everybody else who
          might still need a number this month.
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
            setEditing(person.id);
            setPicking(false);
            setPickedId(null);
          }}
          label="Person"
        />
      </Modal>

      {banner ? (
        <Banner
          tone={banner.tone === "danger" ? "danger" : "info"}
          title={banner.tone === "danger" ? "That did not save" : "Saved"}
          body={banner.text}
        />
      ) : null}

      {unset > 0 ? (
        <Banner
          tone="info"
          title={`${unset} of ${allRows.length} ${unset === 1 ? "person has" : "people have"} no target for ${monthName(period)}`}
          body="Somebody with no target is not scored at all — they appear on the month with their figures and no percentage, which is honest but tells nobody whether it was a good month."
        />
      ) : null}

      {allRows.length === 0 ? (
        <Empty
          title="Nobody to set a target for"
          body="A target can be set for anybody who carries customers — a salesperson on the account, or the back office person where there is no salesperson."
        />
      ) : (
        <Table
          minWidth={1180}
          head={
            <>
              <HeadCell width={170}>Person</HeadCell>
              <HeadCell width={110}>Status</HeadCell>
              <HeadCell align="right" width={150}>Revenue</HeadCell>
              <HeadCell align="right" width={130}>Volume</HeadCell>
              <HeadCell align="right" width={90}>New</HeadCell>
              <HeadCell align="right" width={140}>Collection</HeadCell>
              <HeadCell align="right" width={90}>Activity</HeadCell>
              <HeadCell width={200}>Against their own average</HeadCell>
              <HeadCell width={100}> </HeadCell>
            </>
          }
        >
          {allRows.flatMap((r, i) => {
            const base = baselines[r.userId];
            const line = (
              <Row key={r.userId} striped={i % 2 === 1}>
                <Cell truncate={170}>
                  <span className="font-medium text-ink">{r.userName}</span>
                </Cell>
                <Cell>
                  {r.status === "published" && r.carriedForward ? (
                    <Pill tone="brand">Carried forward</Pill>
                  ) : r.status === "published" ? (
                    <Pill tone="success">Published</Pill>
                  ) : r.status === "draft" ? (
                    <Pill tone="warn">Draft</Pill>
                  ) : (
                    <span className="text-[12px] text-muted">not set</span>
                  )}
                </Cell>
                <Cell align="right">{orDash(r.revenueTargetPaise, money)}</Cell>
                <Cell align="right">
                  {orDash(r.volumeTargetMl, (v) => `${Math.round(v / 1000).toLocaleString("en-IN")} L`)}
                </Cell>
                <Cell align="right">{orDash(r.newCustomerTarget, String)}</Cell>
                <Cell align="right">
                  {orDash(r.collectionTargetBp, (bp) => `${(bp / 100).toFixed(0)}%`)}
                </Cell>
                <Cell align="right">{orDash(r.activityTarget, String)}</Cell>
                <Cell truncate={200}>
                  <Growth target={r.revenueTargetPaise} baseline={base} months={baselineMonths} />
                </Cell>
                <Cell>
                  <button
                    type="button"
                    onClick={() => setEditing(editing === r.userId ? null : r.userId)}
                    className="rounded-[4px] border border-line bg-surface px-2.5 py-1 text-[12px] text-body hover:bg-canvas"
                  >
                    {editing === r.userId ? "Close" : r.targetId ? "Change" : "Set"}
                  </button>
                </Cell>
              </Row>
            );

            if (editing !== r.userId) return [line];
            return [
              line,
              <tr key={`${r.userId}-edit`}>
                <td colSpan={9} className="border-b border-line bg-canvas p-0">
                  <Editor
                    key={`${r.userId}-${period}`}
                    row={r}
                    period={period}
                    baseline={base}
                    categories={categories}
                    revisionReasons={revisionReasons}
                    onDone={(message, tone) => {
                      setBanner({ tone, text: message });
                      if (tone === "info") {
                        setEditing(null);
                        // A person added by hand now has a real target row,
                        // which the refreshed page will bring back through
                        // `rows` — the hand-added placeholder would otherwise
                        // sit beside it as a duplicate.
                        setManualRows((prev) => prev.filter((m) => m.userId !== r.userId));
                        router.refresh();
                      }
                    }}
                  />
                </td>
              </tr>,
            ];
          })}
        </Table>
      )}

      <p className="mt-3 max-w-[860px] text-[13px] text-pretty text-muted">
        A revenue target and a volume target are both set, and the second is the point:
        a price revision raises what a month is worth without a single extra can leaving
        the godown, so litres are what say whether more was actually sold. Published
        targets can be changed, and every change is recorded with its reason and told to
        the person it belongs to. {published} of {rows.length} published.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------- the editor */

function Editor({
  row,
  period,
  baseline,
  categories,
  revisionReasons,
  onDone,
}: {
  row: TargetRow;
  period: string;
  baseline: Baseline | undefined;
  categories: { id: string; name: string; isResidual: boolean }[];
  revisionReasons: string[];
  onDone: (message: string, tone: "info" | "danger") => void;
}) {
  const [revenue, setRevenue] = useState(toRupees(row.revenueTargetPaise));
  const [volume, setVolume] = useState(toLitres(row.volumeTargetMl));
  const [newCustomers, setNewCustomers] = useState(
    row.newCustomerTarget === null ? "" : String(row.newCustomerTarget),
  );
  const [collection, setCollection] = useState(toPercent(row.collectionTargetBp));
  const [activity, setActivity] = useState(
    row.activityTarget === null ? "" : String(row.activityTarget),
  );
  const [reason, setReason] = useState("");
  const [reasonNote, setReasonNote] = useState("");
  // Only the categories this target already carries — not every active one.
  // A book with two categories and a book with eight both start from what is
  // actually theirs; "Add category" is how either grows, never a wall of
  // rows to skip past for the categories that do not apply here.
  const [bands, setBands] = useState(() =>
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
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const isPublished = row.status === "published";
  const shareTotal = bands.reduce((s, b) => s + (Number(b.target) || 0), 0);

  function save(thenPublish: boolean) {
    setError(null);
    start(async () => {
      const filled = bands.filter((b) => b.target !== "" || b.minimum !== "");
      const result = await saveSalesTarget({
        userId: row.userId,
        period,
        revenueTargetPaise: toPaise(revenue),
        volumeTargetMl: toMl(volume),
        newCustomerTarget: toCount(newCustomers),
        collectionTargetBp: toBp(collection),
        activityTarget: toCount(activity),
        notes: null,
        bands: filled.map((b) => ({
          categoryId: b.categoryId,
          minimumBp: Math.round((Number(b.minimum) || 0) * 100),
          targetBp: Math.round((Number(b.target) || 0) * 100),
          stretchBp: Math.round(
            (Number(b.stretch) || Number(b.target) || 0) * 100,
          ),
        })),
        reason: isPublished ? reason : undefined,
        reasonNote: isPublished && reasonNote ? reasonNote : undefined,
      });

      if (!result.ok) {
        setError(result.error);
        onDone(result.error, "danger");
        return;
      }
      if (!thenPublish) {
        onDone(`${row.userName}'s target saved as a draft.`, "info");
        return;
      }
      const publishResult = await publishSalesTarget(result.data.targetId);
      if (!publishResult.ok) {
        setError(publishResult.error);
        onDone(publishResult.error, "danger");
        return;
      }
      onDone(`${row.userName}'s target is published. They can see it now.`, "info");
    });
  }

  return (
    <div className="px-5 py-4">
      <div className="mb-4 flex flex-wrap gap-x-8 gap-y-4">
        <Field
          label="Revenue target"
          suffix="₹"
          value={revenue}
          onChange={setRevenue}
          hint={
            baseline
              ? `${money(baseline.revenuePaise)} a month over the last ${baseline.monthsCounted}`
              : undefined
          }
        />
        <Field
          label="Volume target"
          suffix="litres"
          value={volume}
          onChange={setVolume}
          hint={
            baseline?.millilitres
              ? `${Math.round(baseline.millilitres / 1000).toLocaleString("en-IN")} L a month`
              : "no measured history yet"
          }
        />
        <Field
          label="New customers"
          value={newCustomers}
          onChange={setNewCustomers}
          hint={baseline ? `${baseline.newCustomers} a month` : undefined}
        />
        <Field
          label="Collection target"
          suffix="%"
          value={collection}
          onChange={setCollection}
          hint="of what is already overdue at the start of the month"
        />
        <Field
          label="Tasks target"
          value={activity}
          onChange={setActivity}
          hint="tasks marked done"
        />
      </div>

      <div className="mb-2 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
        Product mix — share of the month&rsquo;s value
      </div>
      <p className="mb-3 max-w-[720px] text-[12px] text-muted">
        Three numbers rather than one, because a book selling into furniture and one
        selling into automotive cannot be held to the same 30%. Below the minimum a
        category falls away to nothing; stretch is exceptional. Add only the
        categories that matter for this person — one, two, or all of them.
      </p>

      <div className="mb-2 overflow-x-auto">
        <table className="text-[13px]">
          <thead>
            <tr className="text-[11px] tracking-[0.04em] text-muted uppercase">
              <th className="px-2 py-1 text-left font-medium">Category</th>
              <th className="px-2 py-1 text-right font-medium">Minimum %</th>
              <th className="px-2 py-1 text-right font-medium">Target %</th>
              <th className="px-2 py-1 text-right font-medium">Stretch %</th>
              <th className="px-2 py-1 text-right font-medium">{""}</th>
            </tr>
          </thead>
          <tbody>
            {bands.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-2 py-2 text-[13px] text-muted">
                  No categories added yet. Product mix is left out of this target&rsquo;s
                  score until at least one is added below.
                </td>
              </tr>
            ) : null}
            {bands.map((b, i) => (
              <tr key={b.categoryId}>
                <td className="px-2 py-1 text-body">
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
                  <td key={k} className="px-2 py-1">
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
                <td className="px-2 py-1 text-right">
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
                <td className="px-2 pt-2 text-[12px] text-muted">Targets total</td>
                <td />
                <td
                  className={
                    shareTotal > 100
                      ? "px-2 pt-2 text-right text-[12px] font-medium text-danger tabular-nums"
                      : "px-2 pt-2 text-right text-[12px] text-muted tabular-nums"
                  }
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
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) addCategory(e.target.value);
            }}
            className="rounded-[4px] border border-line bg-surface px-2 py-1 text-[13px]"
          >
            <option value="">+ Add category…</option>
            {available.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.isResidual ? " (everything else)" : ""}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {isPublished ? (
        <div className="mb-4 max-w-[620px] rounded-[6px] border border-warn-edge bg-warn-soft px-4 py-3">
          <div className="mb-2 text-[13px] text-warn-ink">
            This target is published. {row.userName} is being measured against it, so a
            change needs a reason — it goes on the record and {row.userName} is told.
            {row.revisions > 0
              ? ` It has already been changed ${row.revisions} ${row.revisions === 1 ? "time" : "times"}.`
              : ""}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="rounded-[4px] border border-line bg-surface px-2 py-1 text-[13px]"
            >
              <option value="">Pick a reason…</option>
              {revisionReasons.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <input
              value={reasonNote}
              onChange={(e) => setReasonNote(e.target.value)}
              placeholder="Anything worth adding (optional)"
              className="min-w-[260px] flex-1 rounded-[4px] border border-line bg-surface px-2 py-1 text-[13px]"
            />
          </div>
        </div>
      ) : null}

      {error ? (
        <p className="mb-3 max-w-[620px] text-[13px] text-danger">{error}</p>
      ) : null}

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => save(false)}
          className="rounded-[4px] border border-line bg-surface px-3 py-1.5 text-[13px] text-body hover:bg-canvas disabled:opacity-50"
        >
          {isPublished ? "Save the change" : "Save as draft"}
        </button>
        {!isPublished ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => save(true)}
            className="rounded-[4px] bg-brand px-3 py-1.5 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            Save and publish
          </button>
        ) : null}
        <span className="text-[12px] text-muted">
          {isPublished
            ? "Already visible to them."
            : "A draft is invisible to them until it is published."}
        </span>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  suffix,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  suffix?: string;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
        {label}
      </span>
      <span className="flex items-baseline gap-1.5">
        {suffix === "₹" ? <span className="text-[13px] text-muted">₹</span> : null}
        <input
          inputMode="numeric"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="not asked"
          className="w-[130px] rounded-[4px] border border-line bg-surface px-2 py-1 text-[13px] tabular-nums"
        />
        {suffix && suffix !== "₹" ? (
          <span className="text-[12px] text-muted">{suffix}</span>
        ) : null}
      </span>
      {hint ? <span className="mt-1 block text-[11px] text-muted">{hint}</span> : null}
    </label>
  );
}

/**
 * The growth being asked for, said out loud.
 *
 * A revenue target means nothing on its own. "₹13,00,000" beside "they have
 * averaged ₹11,05,000, so this is 17.6% growth" is the same number turned into
 * a decision somebody can defend.
 */
function Growth({
  target,
  baseline,
  months,
}: {
  target: number | null;
  baseline: Baseline | undefined;
  months: number;
}) {
  if (!baseline) return <span className="text-muted">—</span>;
  if (!baseline.revenuePaise) {
    return (
      <span className="text-[12px] text-muted">
        no sales in the last {months} months
      </span>
    );
  }
  if (target === null) {
    return (
      <span className="text-[12px] text-muted">
        averages {money(baseline.revenuePaise)}
      </span>
    );
  }
  const growth = ((target - baseline.revenuePaise) / baseline.revenuePaise) * 100;
  const tone =
    growth > 40 ? "text-warn-ink" : growth < 0 ? "text-muted" : "text-body";
  return (
    <span className={`text-[12px] ${tone}`}>
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

function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number);
  const at = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthName(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  }).format(new Date(Date.UTC(y, m - 1, 15)));
}
