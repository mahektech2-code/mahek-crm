"use client";

import * as React from "react";
import Link from "next/link";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  MetricStrip,
  PageHeader,
  SectionLabel,
  Select,
  Td,
  Th,
  Tr,
} from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { Icon } from "@/components/shell/icons";
import { toCsv, downloadCsv } from "@/lib/csv";
import { shortDate, stamp } from "@/lib/format";

type Row = {
  id: string;
  occurredAt: string;
  customerId: string;
  customerName: string;
  userName: string;
  channel: string;
  connection: string | null;
  outcome: string | null;
  note: string | null;
  produced: string | null;
};

type Commitment = { customerId: string; note: string; dueDate: string };

export function HistoryScreen({
  scopeLabel,
  isManager,
  team,
  rows,
  openCommitments,
  activity,
  nowMs,
}: {
  scopeLabel: string;
  isManager: boolean;
  team: string[];
  rows: Row[];
  openCommitments: Commitment[];
  nowMs: number;
  activity: {
    attempted: number;
    connected: number;
    missed: number;
    connectRate: number;
    messagesSent: number;
  };
}) {
  const { push } = useToast();

  const [query, setQuery] = React.useState("");
  const [channel, setChannel] = React.useState("All channels");
  const [who, setWho] = React.useState("Everyone");
  const [range, setRange] = React.useState("Last 7 days");

  const customers = React.useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of rows) if (!seen.has(r.customerId)) seen.set(r.customerId, r.customerName);
    return [...seen.entries()].map(([id, name]) => ({ id, name }));
  }, [rows]);

  const [handoverIdRaw, setHandoverId] = React.useState<string | null>(null);
  const handoverId =
    customers.find((c) => c.id === handoverIdRaw)?.id ?? customers[0]?.id ?? "";

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    // nowMs comes from the server render — no clock reads during render.
    const cutoff =
      range === "Today"
        ? nowMs - 86_400_000
        : range === "Last 7 days"
          ? nowMs - 7 * 86_400_000
          : range === "This month"
            ? nowMs - 31 * 86_400_000
            : 0;

    return rows.filter((r) => {
      if (channel !== "All channels" && r.channel !== channel) return false;
      if (who !== "Everyone" && r.userName !== who) return false;
      if (cutoff && new Date(r.occurredAt).getTime() < cutoff) return false;
      if (!q) return true;
      return (
        r.customerName.toLowerCase().includes(q) ||
        (r.note ?? "").toLowerCase().includes(q) ||
        (r.outcome ?? "").toLowerCase().includes(q)
      );
    });
  }, [rows, query, channel, who, range, nowMs]);

  const handoverRows = rows.filter((r) => r.customerId === handoverId);
  const handoverName = customers.find((c) => c.id === handoverId)?.name ?? "";
  const commitments = openCommitments.filter((c) => c.customerId === handoverId);
  const lastPromise = handoverRows.find((r) => r.note)?.note ?? "Nothing recorded yet.";

  const handoverText = [
    `*Handover - ${handoverName}*`,
    "",
    "Last three interactions:",
    ...handoverRows
      .slice(0, 3)
      .map((r) => `· ${stamp(r.occurredAt)} - ${r.channel}, ${r.outcome ?? "no outcome"}: ${r.note ?? "no note"}`),
    "",
    `Last thing promised: ${lastPromise}`,
    "",
    commitments.length
      ? `Open commitments:\n${commitments.map((c) => `· ${c.note} (due ${shortDate(c.dueDate)})`).join("\n")}`
      : "Open commitments: none",
  ].join("\n");

  return (
    <div className="px-6 pt-6 pb-10">
      <PageHeader
        title="Call history"
        subtitle={`${scopeLabel} · Calls and WhatsApp messages in one stream, newest first.`}
        actions={
          <Button
            variant="secondary"
            disabled={!isManager}
            title={isManager ? "Download as CSV" : "Export is a manager action"}
            onClick={() => {
              downloadCsv(
                "mahek-interactions",
                toCsv(
                  ["Timestamp", "Customer", "Telecaller", "Channel", "Status", "Outcome", "Notes", "Produced"],
                  filtered.map((r) => [
                    r.occurredAt,
                    r.customerName,
                    r.userName,
                    r.channel,
                    r.connection ?? "",
                    r.outcome ?? "",
                    r.note ?? "",
                    r.produced ?? "",
                  ]),
                ),
                [
                  channel === "All channels" ? null : channel,
                  range,
                  query || null,
                ],
              );
              push(`Exported ${filtered.length} rows`);
            }}
          >
            Export
          </Button>
        }
      />

      <MetricStrip
        metrics={[
          { label: "Calls today", value: String(activity.attempted) },
          { label: "Connected", value: String(activity.connected), sub: `${activity.connectRate}% rate` },
          { label: "Missed", value: String(activity.missed), tone: activity.missed > 5 ? "danger" : "ink" },
          { label: "Messages sent today", value: String(activity.messagesSent) },
          { label: "Interactions in view", value: String(filtered.length) },
        ]}
      />

      <Card className="mb-4">
        <div className="flex items-center justify-between gap-3 border-b border-divider px-5 py-3.5">
          <div>
            <div className="text-lg font-semibold text-ink">
              Handover summary - {handoverName}
            </div>
            <div className="mt-0.5 text-[13px] text-muted">
              Everything someone else needs to pick up this customer
            </div>
          </div>
          <div className="flex items-center gap-2.5">
            <Select
              value={handoverId}
              onChange={(e) => setHandoverId(e.target.value)}
              className="h-8"
            >
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
            <Button
              variant="primary"
              size="sm"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(handoverText);
                  push("Handover summary copied");
                } catch {
                  push("The browser blocked the clipboard.", "error");
                }
              }}
            >
              <Icon name="copy" size={14} strokeWidth={1.8} />
              Copy summary
            </Button>
          </div>
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_clamp(260px,30%,340px)] gap-5 px-5 py-4">
          <div>
            <SectionLabel>Last three interactions</SectionLabel>
            <div className="mt-1.5">
              {handoverRows.slice(0, 3).map((r) => (
                <div key={r.id} className="py-0.5 text-sm text-body">
                  {stamp(r.occurredAt)} - {r.channel}, {r.outcome ?? "no outcome"}:{" "}
                  {r.note ?? "no note"}
                </div>
              ))}
              {!handoverRows.length ? (
                <div className="py-0.5 text-sm text-muted">Nothing logged yet.</div>
              ) : null}
            </div>
            <div className="mt-3.5">
              <SectionLabel>Last thing promised</SectionLabel>
              <div className="mt-1.5 text-[15px] text-ink">{lastPromise}</div>
            </div>
          </div>
          <div className="border-l border-divider pl-5">
            <SectionLabel>Open commitments</SectionLabel>
            <div className="mt-1.5">
              {commitments.length ? (
                commitments.map((c, i) => (
                  <div key={i} className="py-0.5 text-sm text-body">
                    · {c.note} <span className="text-muted">(due {shortDate(c.dueDate)})</span>
                  </div>
                ))
              ) : (
                <div className="py-0.5 text-sm text-muted">Nothing outstanding.</div>
              )}
            </div>
          </div>
        </div>
      </Card>

      <Card className="flex items-center gap-2.5 rounded-b-none border-b-0 px-4 py-3">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search notes and customers"
          className="h-8 w-[280px]"
        />
        <Select
          value={channel}
          onChange={(e) => setChannel(e.target.value)}
          className="h-8"
        >
          {["All channels", "Call", "WhatsApp", "Visit"].map((c) => (
            <option key={c}>{c}</option>
          ))}
        </Select>
        <Select value={who} onChange={(e) => setWho(e.target.value)} className="h-8">
          <option>Everyone</option>
          {team.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </Select>
        <Select
          value={range}
          onChange={(e) => setRange(e.target.value)}
          className="h-8"
        >
          {["Today", "Last 7 days", "This month", "All time"].map((r) => (
            <option key={r}>{r}</option>
          ))}
        </Select>
        <span className="flex-1" />
        <span className="text-[13px] text-muted">{filtered.length} interactions</span>
      </Card>

      <Card className="max-h-[calc(100vh-280px)] overflow-auto rounded-t-none">
        {filtered.length ? (
          <table>
            <thead>
              <tr>
                <Th>Timestamp</Th>
                <Th>Customer</Th>
                <Th>Telecaller</Th>
                <Th>Channel</Th>
                <Th>Status</Th>
                <Th>Outcome</Th>
                <Th>Notes</Th>
                <Th>Produced</Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <Tr key={r.id} className="hover:bg-canvas">
                  <Td className="whitespace-nowrap">{stamp(r.occurredAt)}</Td>
                  <Td>
                    <Link
                      href={`/crm/customers/${r.customerId}`}
                      className="no-underline hover:underline"
                    >
                      {r.customerName}
                    </Link>
                  </Td>
                  <Td>{r.userName}</Td>
                  <Td>{r.channel}</Td>
                  <Td>
                    {r.connection ? (
                      <Badge
                        tone={
                          r.connection === "Connected"
                            ? "success"
                            : r.connection === "Busy"
                              ? "warn"
                              : "danger"
                        }
                      >
                        {r.connection}
                      </Badge>
                    ) : (
                      <span className="text-muted">-</span>
                    )}
                  </Td>
                  <Td>{r.outcome ?? "-"}</Td>
                  <Td className="max-w-[320px] truncate text-muted" title={r.note ?? ""}>
                    {r.note ?? "-"}
                  </Td>
                  <Td className={r.produced ? "font-medium text-success" : "text-muted"}>
                    {r.produced ?? "-"}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState
            title="No interactions match these filters"
            body="Clear the search or widen the channel and date filters."
          />
        )}
      </Card>
    </div>
  );
}
