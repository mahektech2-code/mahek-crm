"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  Card,
  Field,
  PageHeader,
  SectionLabel,
  Select,
  Td,
  Th,
  Tr,
  cx,
} from "@/components/ui/primitives";
import { Tabs } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { Icon } from "@/components/shell/icons";
import {
  importBills,
  importCustomers,
  type ImportSummary,
} from "@/lib/actions/import";
import { parseCsv } from "@/lib/csv";

const CUSTOMER_COLUMNS = [
  ["name", "Business name, as it appears on the bill", "required"],
  ["contactPerson", "Person you actually speak to", "required"],
  ["phone", "10-digit mobile — also the key for re-imports", "required"],
  ["city", "City", "required"],
  ["ownerName", "Telecaller who owns the account", "optional"],
  ["gstin", "GSTIN", "optional"],
  ["creditTermDays", "Credit terms in days (default 30)", "optional"],
  ["cycleDays", "Typical days between orders (default 30)", "optional"],
  ["route", "Delivery route", "optional"],
];

const BILL_COLUMNS = [
  ["billNo", "Bill number — the key for re-imports", "required"],
  ["phone", "Customer's telephone, to match the account", "required"],
  ["billDate", "YYYY-MM-DD", "required"],
  ["dueDate", "YYYY-MM-DD", "required"],
  ["amount", "Bill value in rupees", "required"],
  ["paid", "Amount already received, in rupees (default 0)", "optional"],
];

export function ImportScreen({
  team,
}: {
  team: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const { run } = useToast();

  const [tab, setTab] = React.useState<"customers" | "bills">("customers");
  const [ownerId, setOwnerId] = React.useState(team[0]?.id ?? "");
  const [rows, setRows] = React.useState<Array<Record<string, string>> | null>(null);
  const [fileName, setFileName] = React.useState("");
  const [summary, setSummary] = React.useState<ImportSummary | null>(null);
  const [busy, setBusy] = React.useState(false);

  const columns = tab === "customers" ? CUSTOMER_COLUMNS : BILL_COLUMNS;

  function reset() {
    setRows(null);
    setFileName("");
    setSummary(null);
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setRows(parseCsv(text));
    setFileName(file.name);
    setSummary(null);
  }

  return (
    <div className="max-w-[1000px] px-6 pt-6 pb-10">
      <Link
        href="/crm/customers"
        className="mb-2.5 inline-flex items-center gap-1.5 text-[13px] text-muted no-underline hover:text-body hover:no-underline"
      >
        <Icon name="chevronLeft" size={14} />
        All customers
      </Link>

      <PageHeader
        title="Import from CSV"
        subtitle="Bring the real Mahek book in. Re-importing the same sheet updates the rows it already knows rather than duplicating them."
      />

      <Tabs
        value={tab}
        onChange={(t) => {
          setTab(t);
          reset();
        }}
        className="mb-4"
        tabs={[
          { key: "customers", label: "Customers" },
          { key: "bills", label: "Sales bills" },
        ]}
      />

      <Card className="mb-4 p-5">
        <SectionLabel>Columns this file needs</SectionLabel>
        <table className="mt-3">
          <thead>
            <tr>
              <Th>Column</Th>
              <Th>What it holds</Th>
              <Th>Required</Th>
            </tr>
          </thead>
          <tbody>
            {columns.map(([key, what, required]) => (
              <Tr key={key}>
                <Td className="font-mono text-[13px] text-ink">{key}</Td>
                <Td>{what}</Td>
                <Td>
                  <Badge tone={required === "required" ? "brand" : "muted"}>
                    {required}
                  </Badge>
                </Td>
              </Tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-[13px] text-muted">
          Column order does not matter — the header row is what is read. Extra
          columns are ignored.
        </p>
      </Card>

      <Card className="mb-4 p-5">
        <div className="flex items-end gap-4">
          <Field label="CSV file" className="flex-1">
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={onFile}
              className="block w-full cursor-pointer text-sm text-body file:mr-3 file:cursor-pointer file:rounded-[4px] file:border file:border-line-strong file:bg-surface file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-body hover:file:bg-canvas"
            />
          </Field>
          {tab === "customers" ? (
            <Field
              label="Owner for rows with no telecaller named"
              className="w-[280px]"
            >
              <Select value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
                {team.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
        </div>

        {rows ? (
          <div className="mt-4 flex items-center gap-3">
            <span className="text-sm text-body">
              <strong className="font-medium text-ink">{fileName}</strong> —{" "}
              {rows.length} row{rows.length === 1 ? "" : "s"} ready
            </span>
            <span className="flex-1" />
            <Button variant="secondary" onClick={reset}>
              Clear
            </Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                const result = await run(
                  tab === "customers"
                    ? importCustomers(rows, ownerId)
                    : importBills(rows),
                );
                setBusy(false);
                if (result.ok && result.data) {
                  setSummary(result.data);
                  router.refresh();
                }
              }}
            >
              {busy ? "Importing…" : `Import ${rows.length} rows`}
            </Button>
          </div>
        ) : null}
      </Card>

      {rows && !summary ? (
        <Card className="mb-4 overflow-auto">
          <div className="border-b border-divider px-5 py-3 text-xs font-medium tracking-[0.04em] text-muted uppercase">
            First five rows, as the importer reads them
          </div>
          <table>
            <thead>
              <tr>
                {Object.keys(rows[0] ?? {}).map((k) => (
                  <Th key={k}>{k}</Th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 5).map((r, i) => (
                <Tr key={i}>
                  {Object.keys(rows[0] ?? {}).map((k) => (
                    <Td key={k}>{r[k]}</Td>
                  ))}
                </Tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}

      {summary ? (
        <Card className="overflow-hidden">
          <div className="flex gap-8 border-b border-divider px-5 py-4">
            <span>
              <SectionLabel>Created</SectionLabel>
              <span className="text-[22px] font-semibold text-success">
                {summary.created}
              </span>
            </span>
            <span>
              <SectionLabel>Updated</SectionLabel>
              <span className="text-[22px] font-semibold text-ink">
                {summary.updated}
              </span>
            </span>
            <span>
              <SectionLabel>Skipped</SectionLabel>
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
              href="/crm/customers"
              className="flex h-9 items-center rounded-[4px] border border-brand bg-brand px-4 text-sm font-medium text-white no-underline hover:bg-brand-hover hover:no-underline"
            >
              See the book
            </Link>
          </div>

          {summary.skipped.length ? (
            <>
              <div className="bg-warn-soft px-5 py-2.5 text-[13px] text-warn-ink">
                These rows were left out. Fix them in the sheet and import again —
                the rows that already went in will update, not duplicate.
              </div>
              <table>
                <thead>
                  <tr>
                    <Th>Row</Th>
                    <Th>Name</Th>
                    <Th>Why it was skipped</Th>
                  </tr>
                </thead>
                <tbody>
                  {summary.skipped.map((s) => (
                    <Tr key={s.row}>
                      <Td>{s.row}</Td>
                      <Td className="text-ink">{s.name}</Td>
                      <Td className="text-danger">{s.problem}</Td>
                    </Tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <div className="px-5 py-6 text-center text-[15px] text-muted">
              Every row went in cleanly.
            </div>
          )}
        </Card>
      ) : null}
    </div>
  );
}
