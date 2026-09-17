"use client";

import { leadHref, type LeadWorkspace } from "@/lib/lead-workspace";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, Field, Input, Select, cx } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { parseCsv } from "@/lib/csv";
import { salesTypeLabel } from "@/lib/lead-labels";
import {
  captureLeadBatch,
  previewBulkIntake,
  type BulkPreview,
  type BulkSummary,
} from "@/lib/actions/lead-intake";
import type { NextActionOwner } from "@/lib/services/lead-intake-service";
import {
  Banner,
  Button,
  Cell,
  Empty,
  HeadCell,
  MetricRow,
  Pill,
  Row,
  ScreenHeader,
  Table,
} from "@/components/console/parts";
import { plural } from "@/components/console/words";

/* ---------------------------------------------------------------------------
 * Screen 34.
 *
 * **The preview is the server's reading of the file, not the browser's.** The
 * file is parsed here — `parseCsv`, the same parser the CRM's import uses — and
 * then handed straight back to `previewBulkIntake`, which applies the rules
 * `captureLeadBatch` will apply. A validator typed into this screen to make the
 * preview quick would be a second copy of those rules, and it would drift
 * inside one release; the half that drifts is always the half somebody is
 * reading just before they press the button.
 *
 * **NOTHING IS WRITTEN UNTIL THE BUTTON IS PRESSED, and the button says what it
 * is waiting for.** A disabled control on this screen always carries its reason
 * on itself, because the two things that can stop it — a file with no clean row
 * in it, and §24 wanting an action nobody has typed — look identical from the
 * outside.
 *
 * Two things this import will never do, both of them scars:
 *
 *   `active_in_order_system` — migration `0021` had to clear what an import
 *   last wrote to it. Setting it on every row it touched muted the entire
 *   calling book: a full database and an empty Call Log, with the cause sitting
 *   in a column no screen shows.
 *
 *   `owner_id` defaulted to whoever ran the import — on a thousand rows that is
 *   one person's name on every scoped list in the product, and nobody reads it
 *   as an artefact of an import. The control below defaults to Unassigned.
 * ------------------------------------------------------------------------- */

const COLUMNS: Array<[string, string, "required" | "optional"]> = [
  ["name", "Shop or business name", "required"],
  ["phone", "Ten-digit mobile — also how a duplicate is caught", "required"],
  ["city", "Town", "required"],
  ["source", "Where the lead came from", "required"],
  [
    "salesType",
    "direct, distributor or third_party. EMPTY means nobody has decided, which is a real answer — an unrecognised word is refused rather than read as empty",
    "optional",
  ],
  ["companyName", "Registered name where it differs", "optional"],
  ["contactPerson", "Person you speak to", "optional"],
  ["address", "What there is of it", "optional"],
  ["customerType", "dealer, manufacturer, distributor or retailer", "optional"],
  ["monthlyLitres", "Monthly requirement in LITRES — never cans", "optional"],
  ["competitor", "Who they buy from now", "optional"],
  ["product", "What they want, in their own words", "optional"],
  ["application", "What they use it on", "optional"],
];

export function BulkScreen({
  workspace,
  owners,
  today,
  requireNextAction,
  canWork,
}: {
  /** Which app is drawing this. See `lib/lead-workspace.ts`. */
  workspace: LeadWorkspace;
  owners: NextActionOwner[];
  today: string;
  requireNextAction: boolean;
  canWork: boolean;
}) {
  const router = useRouter();
  const { push } = useToast();

  const [rows, setRows] = React.useState<Array<Record<string, string>> | null>(null);
  const [fileName, setFileName] = React.useState("");
  const [preview, setPreview] = React.useState<BulkPreview | null>(null);
  const [summary, setSummary] = React.useState<BulkSummary | null>(null);
  const [busy, setBusy] = React.useState(false);

  const [ownerId, setOwnerId] = React.useState("");
  const [action, setAction] = React.useState("");
  const [actionDate, setActionDate] = React.useState(today);
  const [actionOwnerId, setActionOwnerId] = React.useState("");

  function reset() {
    setRows(null);
    setFileName("");
    setPreview(null);
    setSummary(null);
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const parsed = parseCsv(text);
    setRows(parsed);
    setFileName(file.name);
    setSummary(null);
    setPreview(null);

    setBusy(true);
    try {
      const result = await previewBulkIntake(parsed);
      if (result.ok) setPreview(result.data);
      else push(result.error, "error");
    } finally {
      setBusy(false);
    }
  }

  /*
   * WHY THE COMMIT CAN BE REFUSED, in the order somebody hits them. One
   * sentence each, and whichever is true rides on the button's own `title` —
   * a dead control that does not say why is the thing this codebase keeps
   * calling out.
   */
  const blockedBecause = !canWork
    ? "Raising leads takes the lead.work capability, which this account does not hold."
    : !preview
      ? "Choose a file first."
      : !preview.ready
        ? "Not one row in this file can go in. Fix them in the sheet and offer it again."
        : requireNextAction && !(action.trim() && actionDate && actionOwnerId)
          ? "§24: every lead in this file would land owing nothing to anybody. Say what happens next, on what day, and who is doing it."
          : null;

  async function commit() {
    if (!rows) return;
    setBusy(true);
    try {
      const result = await captureLeadBatch(rows, {
        ownerId: ownerId || null,
        nextAction:
          action.trim() && actionOwnerId
            ? { action: action.trim(), date: actionDate, ownerId: actionOwnerId }
            : undefined,
      });
      if (result.ok) {
        setSummary(result.data);
        if (result.message) push(result.message);
        router.refresh();
      } else {
        push(result.error, "error");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <ScreenHeader
        title="Bulk intake"
        subtitle="A file of leads, read and checked before a single row is written. Every row that cannot go in is named with the reason, by its row number in your sheet, so the file can be fixed and offered again."
        actions={
          <Link
            href={leadHref(workspace, "leads/intake")}
            className="inline-flex h-9 items-center rounded-[4px] border border-line bg-surface px-3.5 text-sm text-body no-underline hover:bg-canvas hover:no-underline"
          >
            One at a time
          </Link>
        }
      />

      <Banner
        tone="info"
        title="Two things this import will not do"
        body="It never marks a lead as live in the external order system — an import that did once muted the entire calling book, and migration 0021 exists to clear it. And it never puts your own name on the rows as their owner: a thousand leads carrying one person's name reads as that person's book on every list in the product. Rows land unassigned unless you name a salesman below, and unassigned is said in words."
      />

      <Card className="mb-4 p-5">
        <div className="mb-3 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
          Columns this file may carry
        </div>
        <Table
          minWidth={620}
          head={
            <>
              <HeadCell width={150}>Column</HeadCell>
              <HeadCell>What it holds</HeadCell>
              <HeadCell width={110}>Required</HeadCell>
            </>
          }
        >
          {COLUMNS.map(([key, what, need], i) => (
            <Row key={key} striped={i % 2 === 1}>
              <Cell className="font-mono text-[13px] text-ink">{key}</Cell>
              <Cell>{what}</Cell>
              <Cell>
                <Pill tone={need === "required" ? "brand" : "neutral"}>{need}</Pill>
              </Cell>
            </Row>
          ))}
        </Table>
        <p className="mt-3 text-[13px] text-muted">
          The header row is what is read, so column order does not matter and
          extra columns are ignored. Spelling is forgiving about case, spaces and
          underscores and about nothing else.
        </p>
      </Card>

      <Card className="mb-4 p-5">
        <Field label="CSV file">
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={onFile}
            className="block w-full cursor-pointer text-sm text-body file:mr-3 file:cursor-pointer file:rounded-[4px] file:border file:border-line-strong file:bg-surface file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-body hover:file:bg-canvas"
          />
        </Field>

        {rows ? (
          <div className="mt-3 flex items-center gap-3 text-sm text-body">
            <strong className="font-medium text-ink">{fileName}</strong>
            <span>{plural(rows.length, "row")} read</span>
            <span className="flex-1" />
            <Button onClick={reset}>Clear</Button>
          </div>
        ) : null}
      </Card>

      {preview ? (
        <>
          <MetricRow
            metrics={[
              { label: "Rows read", value: String(preview.rows.length) },
              { label: "Ready", value: String(preview.ready) },
              {
                label: "Left out",
                value: String(preview.blocked),
                tone: preview.blocked ? "warn" : undefined,
              },
            ]}
          />

          <Card className="mb-4 p-5">
            <h2 className="mb-1 text-lg font-semibold text-ink">
              What everything in this file gets
            </h2>
            <p className="mb-4 max-w-[760px] text-[13px] text-pretty text-muted">
              A spreadsheet of leads names nobody and promises nothing, and §24
              says an active lead may not sit with nothing owed by anybody. So it
              is asked ONCE, here, for the whole file — the alternatives were to
              invent an action per row or to switch the rule off for imports, and
              both of those are how a thousand leads land owing nothing.
            </p>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Whose book these join"
                hint="Unassigned is the default, and it is a real answer. Your own name on a thousand rows is not."
              >
                <Select value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
                  <option value="">Unassigned — said in words on every list</option>
                  {owners.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={requireNextAction ? "The action, for every row" : "The action (optional here)"}>
                <Input
                  value={action}
                  onChange={(e) => setAction(e.target.value)}
                  placeholder="Ring and qualify"
                />
              </Field>
              <Field label="On what day">
                <Input
                  type="date"
                  value={actionDate}
                  onChange={(e) => setActionDate(e.target.value)}
                />
              </Field>
              <Field label="Owed by">
                <Select
                  value={actionOwnerId}
                  onChange={(e) => setActionOwnerId(e.target.value)}
                >
                  <option value="">Nobody chosen</option>
                  {owners.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name} — {plural(o.owed, "lead")} already owed
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <div className="mt-4 flex items-center gap-3">
              <Button
                tone="primary"
                disabled={busy || Boolean(blockedBecause)}
                title={blockedBecause ?? (busy ? "Working…" : undefined)}
                onClick={commit}
              >
                {busy
                  ? "Working…"
                  : blockedBecause
                    ? blockedBecause
                    : `Raise ${plural(preview.ready, "lead")}`}
              </Button>
              {preview.blocked ? (
                <span className="text-[13px] text-muted">
                  {plural(preview.blocked, "row")} will be left out, listed below
                  by row number.
                </span>
              ) : null}
            </div>
          </Card>

          <Card className="mb-4 overflow-hidden">
            <div className="border-b border-divider px-5 py-3 text-[11px] font-medium tracking-[0.04em] text-muted uppercase">
              Every row, as the importer reads it
            </div>
            <Table
              minWidth={900}
              head={
                <>
                  <HeadCell width={64}>Row</HeadCell>
                  <HeadCell width={200}>Name</HeadCell>
                  <HeadCell width={130}>Phone</HeadCell>
                  <HeadCell width={130}>Town</HeadCell>
                  <HeadCell width={150}>Ladder</HeadCell>
                  <HeadCell>Verdict</HeadCell>
                </>
              }
            >
              {preview.rows.map((r, i) => (
                <Row key={r.row} striped={i % 2 === 1}>
                  <Cell className="tabular-nums">{r.row}</Cell>
                  <Cell>{r.name || <span className="text-muted">—</span>}</Cell>
                  <Cell className="tabular-nums">{r.phone}</Cell>
                  <Cell>{r.city}</Cell>
                  <Cell>
                    <span
                      className={cx("text-[13px]", r.salesType ? "text-body" : "text-muted")}
                    >
                      {r.salesType ? salesTypeLabel(r.salesType) : "Nobody decided"}
                    </span>
                  </Cell>
                  <Cell>
                    {r.problems.length ? (
                      <span className="text-[13px] text-danger">
                        {r.problems.join(" ")}
                      </span>
                    ) : (
                      <Pill tone="success">Ready</Pill>
                    )}
                  </Cell>
                </Row>
              ))}
            </Table>
          </Card>
        </>
      ) : rows && !busy ? (
        <Empty
          title="Nothing readable in that file"
          body="The header row is what is read. If it carries none of the column names above, every row comes back empty — which is a fault in the file rather than in the leads."
        />
      ) : null}

      {summary ? (
        <Card className="overflow-hidden">
          <div className="flex gap-8 border-b border-divider px-5 py-4">
            <span>
              <span className="mb-1 block text-[11px] tracking-[0.04em] text-muted uppercase">
                Raised
              </span>
              <span className="text-[22px] font-semibold text-success">
                {summary.created}
              </span>
            </span>
            <span>
              <span className="mb-1 block text-[11px] tracking-[0.04em] text-muted uppercase">
                Left out
              </span>
              <span
                className={cx(
                  "text-[22px] font-semibold",
                  summary.skipped.length ? "text-danger" : "text-ink",
                )}
              >
                {summary.skipped.length}
              </span>
            </span>
            <span className="flex-1" />
            <Link
              href={leadHref(workspace, "leads")}
              className="flex h-9 items-center rounded-[4px] border border-brand bg-brand px-4 text-sm font-medium text-white no-underline hover:bg-brand-hover hover:no-underline"
            >
              See the book
            </Link>
          </div>

          {summary.skipped.length ? (
            <Table
              minWidth={620}
              head={
                <>
                  <HeadCell width={64}>Row</HeadCell>
                  <HeadCell width={220}>Name</HeadCell>
                  <HeadCell>Why it was left out</HeadCell>
                </>
              }
            >
              {summary.skipped.map((s, i) => (
                <Row key={`${s.row}-${s.name}`} striped={i % 2 === 1}>
                  <Cell className="tabular-nums">{s.row}</Cell>
                  <Cell>{s.name}</Cell>
                  <Cell className="text-danger">{s.problem}</Cell>
                </Row>
              ))}
            </Table>
          ) : (
            <div className="px-5 py-6 text-center text-[15px] text-muted">
              Every row went in.
            </div>
          )}
        </Card>
      ) : null}
    </div>
  );
}
