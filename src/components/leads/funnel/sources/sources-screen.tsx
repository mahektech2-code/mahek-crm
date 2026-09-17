"use client";

import { leadHref, type LeadWorkspace } from "@/lib/lead-workspace";
import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Modal } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { REPORT_PERIOD_LABELS, type ReportPeriod } from "@/lib/business-date";
import { renameLeadSource } from "@/lib/actions/lead-sources";
import type { LeadSourceReport, LeadSourceRow } from "@/lib/services/lead-funnel-service";
import { LeadTabs } from "../../lead-tabs";
import {
  Banner,
  Button,
  Cell,
  Empty,
  FilterChips,
  HeadCell,
  MetricRow,
  Pill,
  Row,
  ScreenHeader,
  Table,
  plural,
} from "@/components/console/parts";

/* ---------------------------------------------------------------------------
 * Where business comes from — and the spellings that are the same place twice.
 *
 * `lead_source` is free text with three authors: a handset, a spreadsheet
 * import and an office form. So the interesting half of this screen is not the
 * table, it is the CLUSTERS above it — "Website", "website" and "Web site" are
 * one source reported as three, and every figure computed per source is wrong
 * by however the book happens to have been typed.
 *
 * A client component for exactly one reason: the merge. Everything else here
 * is links and figures the server rendered, and the window chips are hrefs
 * rather than state so a narrowed view can be sent to somebody.
 * ------------------------------------------------------------------------- */

const PERIODS: ReportPeriod[] = ["month", "last-month", "quarter", "last-quarter", "ytd"];

export function SourcesScreen({
  workspace,
  report,
  allSources,
  period,
  canWork,
}: {
  /** Which app is drawing this. See `lib/lead-workspace.ts`. */
  workspace: LeadWorkspace;
  report: LeadSourceReport;
  /**
   * Every source in the BOOK, not just this window's.
   *
   * Somebody tidying "Web site" away has to be able to merge it into
   * "Website" even where "Website" raised nothing this quarter. A picker
   * narrowed to the window would make the merge look impossible rather than
   * merely unlisted.
   */
  allSources: Array<{ source: string; leads: number }>;
  period: ReportPeriod;
  /** `lead.work`. Checked again in the action — a hidden control is not a rule. */
  canWork: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [merging, setMerging] = React.useState<LeadSourceRow | null>(null);

  const attributed = report.total - report.unattributed;

  return (
    <div className="p-6">
      <LeadTabs workspace={workspace} />

      <ScreenHeader
        title="Sources & attribution"
        subtitle="Every distinct lead_source in the window, what it converted, and which of them are one source spelled twice. The column is free text with three authors, so the cleanup is part of the report rather than a separate job somebody remembers."
      />

      <FilterChips
        current={period}
        options={PERIODS.map((p) => ({
          key: p,
          label: REPORT_PERIOD_LABELS[p],
          href: leadHref(workspace, `leads/funnel/sources?period=${p}`),
        }))}
      />

      <MetricRow
        metrics={[
          {
            label: "Leads raised",
            value: String(report.total),
            sub: `${report.range.from} to ${report.range.to}`,
          },
          { label: "Distinct sources", value: String(report.rows.length) },
          {
            label: "No source recorded",
            value: String(report.unattributed),
            sub: attributed > 0 ? `of ${report.total} raised` : undefined,
            tone: report.unattributed > 0 ? "warn" : undefined,
          },
          {
            label: "Same source, two spellings",
            value: String(report.clusters.length),
            sub: report.clusters.length > 0 ? "clusters below" : "nothing to merge",
            tone: report.clusters.length > 0 ? "warn" : undefined,
          },
        ]}
      />

      {/*
        The unattributed count is a FINDING rather than a footnote. A lead with
        no source is a lead nobody can credit, and on a book fed by a sheet it
        is routinely the largest single row — which is exactly the number the
        table below cannot show, because it has no row to show it on.
      */}
      {report.unattributed > 0 ? (
        <Banner
          tone="warn"
          title={`${plural(report.unattributed, "lead")} carry no source at all`}
          body="They are in no row below, because there is nothing to group them under. Attribution cannot be reconstructed after the fact — whoever raises a lead is the only person who knows where it came from — so this number only ever goes down for leads raised from here on."
        />
      ) : null}

      {report.clusters.length > 0 ? (
        <section className="mb-5 rounded-[6px] border border-warn bg-warn-soft px-5 py-4">
          <h2 className="text-sm font-semibold text-ink">
            {plural(report.clusters.length, "spelling cluster")} — the same source, typed differently
          </h2>
          <p className="mt-1 max-w-[760px] text-[13px] leading-[18px] text-pretty text-body">
            Case, punctuation and spacing folded away, these are one value. Merging rewrites the
            column so nothing else in the product has to learn about it — the leads list&rsquo;s
            filter, the owner&rsquo;s attribution and every export go on reading one string.
          </p>
          <ul className="mt-3 space-y-2">
            {report.clusters.map((c) => (
              <li key={c.fingerprint} className="flex flex-wrap items-baseline gap-2 text-[13px]">
                {c.spellings.map((s, i) => (
                  <span key={s.source} className="inline-flex items-center gap-1.5">
                    {i > 0 ? <span className="text-muted">·</span> : null}
                    <span className="font-medium text-ink">{s.source}</span>
                    <span className="tabular-nums text-muted">({s.leads})</span>
                    {i === 0 ? <Pill tone="success">biggest</Pill> : null}
                  </span>
                ))}
                <span className="text-muted">
                  — {plural(c.leads, "lead")} between them
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {report.rows.length === 0 ? (
        <Empty
          title="No source recorded on any lead in this window"
          body="Which is itself the finding, rather than an empty screen: nothing raised between these dates says where it came from, so there is no attribution to report and nothing to merge."
        />
      ) : (
        <Table
          minWidth={980}
          head={
            <>
              <HeadCell width={280}>Source</HeadCell>
              <HeadCell align="right" width={90}>
                Leads
              </HeadCell>
              <HeadCell align="right" width={110}>
                Converted
              </HeadCell>
              <HeadCell align="right" width={120}>
                Decided against
              </HeadCell>
              <HeadCell align="right" width={110}>
                Still open
              </HeadCell>
              <HeadCell align="right" width={110}>
                Conversion
              </HeadCell>
              <HeadCell width={160} />
            </>
          }
        >
          {report.rows.map((r, i) => {
            const clustered = report.clusters.some((c) => c.fingerprint === r.fingerprint);
            return (
              <Row key={r.source} striped={i % 2 === 1}>
                <Cell truncate={280}>
                  <Link
                    href={leadHref(workspace, `leads?source=${encodeURIComponent(r.source)}`)}
                    className="text-[#5223E0]"
                  >
                    {r.source}
                  </Link>
                  {clustered ? (
                    <span className="ml-2">
                      <Pill tone="warn">duplicate spelling</Pill>
                    </span>
                  ) : null}
                </Cell>
                <Cell align="right">{r.leads}</Cell>
                <Cell align="right">{r.converted}</Cell>
                <Cell align="right">{r.closedUnconverted}</Cell>
                {/*
                  Still open is printed and never divided. A source whose leads
                  were all raised last week has not converted nothing — it has
                  not finished, and a rate over a denominator of zero is not a
                  low rate.
                */}
                <Cell align="right" className="text-muted">
                  {r.stillOpen}
                </Cell>
                <Cell align="right">
                  {r.rate === null ? (
                    <span
                      className="text-muted"
                      title="Nothing from this source has closed its follow-forward window yet."
                    >
                      Not yet
                    </span>
                  ) : (
                    `${(r.rate * 100).toFixed(1)}%`
                  )}
                </Cell>
                <Cell align="right">
                  <Button
                    size="sm"
                    disabled={!canWork}
                    title={
                      canWork
                        ? undefined
                        : "Merging a source rewrites the column across the book — it takes lead.work."
                    }
                    onClick={() => setMerging(r)}
                  >
                    Merge into…
                  </Button>
                </Cell>
              </Row>
            );
          })}
        </Table>
      )}

      {/*
        Keyed on the source being merged, so the dialog REMOUNTS with fresh
        state rather than an effect resetting it when the prop changes — the
        React Compiler rules are on and every modal in this app does this.
      */}
      {merging ? (
        <MergeDialog
          key={merging.source}
          from={merging}
          options={allSources.filter((s) => s.source !== merging.source)}
          onClose={() => setMerging(null)}
          onDone={(message) => {
            setMerging(null);
            toast.push(message);
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ M-14 */

function MergeDialog({
  from,
  options,
  onClose,
  onDone,
}: {
  from: LeadSourceRow;
  options: Array<{ source: string; leads: number }>;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [to, setTo] = React.useState("");
  const [typed, setTyped] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  /* The typed confirmation is the target, not the word "MERGE". It makes the
     person read the name they are merging INTO, which is the half of this that
     is irreversible — the old spelling is gone from every row afterwards and
     there is nothing left saying which rows used to carry it except the audit
     row this write leaves behind. */
  const confirmed = to.length > 0 && typed.trim() === to;

  const submit = async () => {
    setBusy(true);
    setError(null);
    const res = await renameLeadSource(from.source, to);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onDone(res.message ?? "Merged.");
  };

  return (
    <Modal open onClose={onClose} title="Merge a lead source" width={520}>
      <p className="text-[13px] leading-[18px] text-body">
        Every lead carrying <strong className="text-ink">{from.source}</strong> will carry the
        source you pick instead. The column is rewritten rather than mapped, so the leads list, the
        owner&rsquo;s attribution and every export go on reading one string with nothing to learn.
      </p>

      <div className="mt-3 rounded-[6px] border border-line bg-canvas px-3 py-2.5 text-[13px]">
        <div className="font-medium text-ink">
          {from.source} — {plural(from.leads, "lead")} in this window
        </div>
        <div className="text-muted">
          The merge is BOOK-WIDE, not narrowed to what you can see. A half-done merge leaves the old
          spelling alive on somebody else&rsquo;s rows and reads as finished, which is worse than
          not doing it.
        </div>
      </div>

      <label className="mt-3 block">
        <span className="mb-1 block text-[13px] font-medium text-ink">Merge into</span>
        <select
          value={to}
          onChange={(e) => {
            setTo(e.target.value);
            setTyped("");
          }}
          className="w-full rounded-[4px] border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-brand"
        >
          <option value="">Pick the spelling to keep…</option>
          {options.map((o) => (
            <option key={o.source} value={o.source}>
              {o.source} ({o.leads})
            </option>
          ))}
        </select>
      </label>

      {to ? (
        <label className="mt-3 block">
          <span className="mb-1 block text-[13px] font-medium text-ink">
            Type <span className="font-mono">{to}</span> to confirm
          </span>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoFocus
            className="w-full rounded-[4px] border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-brand"
          />
        </label>
      ) : null}

      {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}

      <div className="mt-4 flex justify-end gap-2">
        <Button tone="quiet" onClick={onClose}>
          Cancel
        </Button>
        <Button
          tone="primary"
          disabled={busy || !confirmed}
          title={
            confirmed ? undefined : "Pick a source and type its name back — this cannot be undone."
          }
          onClick={submit}
        >
          {busy ? "Merging…" : "Merge"}
        </Button>
      </div>
    </Modal>
  );
}
