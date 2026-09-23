"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Card, Input, PageHeader, Select, Td, Th, Tr } from "@/components/ui/primitives";
import { useLeadPipeline } from "./provider";
import { isDueToday, isOverdue, personalBookCounts } from "@/lib/sales-lead-pipeline/engine";
import { DIRECT_LADDER, STAGE_LABEL, personName } from "@/lib/sales-lead-pipeline/reference";
import { LeadStatusBadges } from "./badges";

const money = (paise?: number) => (paise ? "₹" + Math.round(paise / 100).toLocaleString("en-IN") : "—");

export function ListScreen() {
  const { leads, today } = useLeadPipeline();
  const router = useRouter();
  const params = useSearchParams();
  const stageParam = params.get("stage") ?? "";
  const dueParam = params.get("due") ?? ""; // "today" | "overdue"
  const [q, setQ] = React.useState("");

  const book = personalBookCounts(leads);

  const setStage = (stage: string) => {
    const url = stage ? `/sales-lead-pipeline/list?stage=${stage}` : "/sales-lead-pipeline/list";
    router.push(url);
  };

  const filtered = leads.filter((l) => {
    if (stageParam && l.stage !== stageParam) return false;
    if (dueParam === "today" && !isDueToday(l, today)) return false;
    if (dueParam === "overdue" && !isOverdue(l, today)) return false;
    if (q && !`${l.name} ${l.city ?? ""} ${l.contact ?? ""}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="p-6">
      <PageHeader title="All Leads" subtitle="Every opportunity in one book — direct, distributor and third-party alike." />

      <Card className="mb-4 flex flex-wrap items-start gap-x-8 gap-y-3.5 px-5 py-3.5">
        {[
          { label: "My leads", value: book.mine, sub: "active" },
          { label: "Today's actions", value: undefined, sub: "due today" },
          { label: "New suspects", value: book.suspects },
          { label: "Prospects", value: book.prospects },
          { label: "In sample", value: book.inSample },
          { label: "Negotiations", value: book.negotiations },
          { label: "Expected orders", value: book.expectedOrders },
          { label: "Lost (30d)", value: book.lost },
        ].map((m) => (
          <div key={m.label}>
            <div className="text-[11px] font-medium tracking-[0.04em] whitespace-nowrap text-muted uppercase">{m.label}</div>
            <div className="mt-0.5 text-[22px] leading-7 font-semibold text-ink">{m.value ?? "—"}</div>
            {m.sub ? <div className="text-xs text-muted">{m.sub}</div> : null}
          </div>
        ))}
      </Card>

      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <Input placeholder="Search customer…" value={q} onChange={(e) => setQ(e.target.value)} className="w-64" />
        <Select value={stageParam} onChange={(e) => setStage(e.target.value)}>
          <option value="">All stages</option>
          {DIRECT_LADDER.map((s) => (
            <option key={s} value={s}>
              {STAGE_LABEL[s]}
            </option>
          ))}
          <option value="lost">Lost</option>
        </Select>
        {dueParam ? (
          <span className="text-[13px] text-muted">
            {dueParam === "today" ? "Due today" : "Overdue"}
          </span>
        ) : null}
        {stageParam || dueParam ? (
          <button
            type="button"
            onClick={() => router.push("/sales-lead-pipeline/list")}
            className="text-[13px] font-medium text-brand hover:text-brand-hover"
          >
            × Clear filter
          </button>
        ) : null}
      </div>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table>
            <thead>
              <Tr>
                <Th>Customer</Th>
                <Th>Sales type</Th>
                <Th>Stage</Th>
                <Th>Owner</Th>
                <Th>Product</Th>
                <Th align="right">Monthly req.</Th>
                <Th align="right">Expected sales</Th>
                <Th>Next action</Th>
                <Th>Due</Th>
              </Tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-6 py-10 text-center text-sm text-muted">
                    No leads match this filter.
                  </td>
                </tr>
              ) : (
                filtered.map((l) => (
                  <Tr key={l.id} className="cursor-pointer hover:bg-canvas">
                    <Td>
                      <Link href={`/sales-lead-pipeline/${l.id}`} className="block">
                        <span className="font-medium text-ink">{l.name}</span>
                        <span className="block text-[12px] text-muted">
                          {l.city ?? "—"} · {l.contact ?? "—"}
                        </span>
                      </Link>
                    </Td>
                    <Td>{l.salesType === "direct" ? "Direct" : l.salesType === "third_party" ? "Third-party" : "Distributor"}</Td>
                    <Td>
                      <LeadStatusBadges lead={l} />
                    </Td>
                    <Td>{personName(l.owner)}</Td>
                    <Td>{l.product ?? "—"}</Td>
                    <Td align="right">{l.monthlyLitres ? `${l.monthlyLitres.toLocaleString("en-IN")} L` : "—"}</Td>
                    <Td align="right">{money(l.potentialPaise)}</Td>
                    <Td className="whitespace-normal">{l.nextAction ?? "—"}</Td>
                    <Td>{l.nextActionDate ?? "—"}</Td>
                  </Tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
