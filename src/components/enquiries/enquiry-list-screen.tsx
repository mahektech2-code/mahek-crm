"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  EmptyState,
  PageHeader,
  Select,
  Th,
  Td,
  Tr,
  Input,
} from "@/components/ui/primitives";
import {
  ENQUIRY_STAGES,
  ENQUIRY_PRIORITIES,
  ENQUIRY_SOURCES,
  STAGE_LABEL,
  PRIORITY_LABEL,
  STAGE_TONE,
  PRIORITY_TONE,
  type EnquiryStage,
  type EnquiryPriority,
} from "@/lib/enquiry-labels";
import type { EnquiryListItem, AssignableUser } from "@/lib/services/enquiry-service";
import { phoneDisplay } from "@/lib/format";

type Filters = {
  q: string;
  stage?: EnquiryStage;
  priority?: EnquiryPriority;
  source?: string;
  assigned: string;
  linked?: "linked" | "unlinked";
  sort: "received_desc" | "received_asc";
};

export function EnquiryListScreen({
  items,
  total,
  page,
  pageSize,
  team,
  filters,
}: {
  items: EnquiryListItem[];
  total: number;
  page: number;
  pageSize: number;
  team: AssignableUser[];
  filters: Filters;
}) {
  const router = useRouter();
  const [q, setQ] = React.useState(filters.q);

  function push(next: Partial<Filters & { page: number }>) {
    const merged = { ...filters, page: 1, ...next };
    const params = new URLSearchParams();
    if (merged.q) params.set("q", merged.q);
    if (merged.stage) params.set("stage", merged.stage);
    if (merged.priority) params.set("priority", merged.priority);
    if (merged.source) params.set("source", merged.source);
    if (merged.assigned) params.set("assigned", merged.assigned);
    if (merged.linked) params.set("linked", merged.linked);
    if (merged.sort && merged.sort !== "received_desc") params.set("sort", merged.sort);
    if ("page" in merged && merged.page && merged.page !== 1) params.set("page", String(merged.page));
    router.push(`/enquiries/list${params.toString() ? "?" + params.toString() : ""}`);
  }

  // Debounced: the search box pushes a new URL as somebody stops typing,
  // not on every keystroke.
  React.useEffect(() => {
    if (q === filters.q) return;
    const t = setTimeout(() => push({ q }), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const hasFilters = !!(filters.stage || filters.priority || filters.source || filters.assigned || filters.linked || filters.q);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="max-w-[1320px] px-6 pt-6 pb-10">
      <PageHeader
        title="Enquiries"
        subtitle={`${total} enquir${total === 1 ? "y" : "ies"} in the Website Enquiries workspace.`}
      />

      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search name, phone, company…"
          className="w-[240px]"
        />
        <Select value={filters.stage ?? ""} onChange={(e) => push({ stage: (e.target.value || undefined) as EnquiryStage })}>
          <option value="">All stages</option>
          {ENQUIRY_STAGES.map((s) => (
            <option key={s} value={s}>{STAGE_LABEL[s]}</option>
          ))}
        </Select>
        <Select value={filters.priority ?? ""} onChange={(e) => push({ priority: (e.target.value || undefined) as EnquiryPriority })}>
          <option value="">All priorities</option>
          {ENQUIRY_PRIORITIES.map((p) => (
            <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>
          ))}
        </Select>
        <Select value={filters.source ?? ""} onChange={(e) => push({ source: e.target.value || undefined })}>
          <option value="">All sources</option>
          {ENQUIRY_SOURCES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </Select>
        <Select value={filters.assigned} onChange={(e) => push({ assigned: e.target.value })}>
          <option value="">Anyone</option>
          <option value="unassigned">Unassigned</option>
          {team.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </Select>
        <Select value={filters.linked ?? ""} onChange={(e) => push({ linked: (e.target.value || undefined) as "linked" | "unlinked" })}>
          <option value="">Customer: any</option>
          <option value="linked">Linked</option>
          <option value="unlinked">Not linked</option>
        </Select>
        {hasFilters ? (
          <button
            onClick={() => {
              setQ("");
              router.push("/enquiries/list");
            }}
            className="cursor-pointer text-[13px] font-medium text-brand hover:text-brand-hover"
          >
            Clear all
          </button>
        ) : null}
      </div>

      <div className="overflow-hidden rounded-[6px] border border-line bg-surface">
        <div className="overflow-auto">
          <table>
            <thead>
              <tr>
                <Th>Enquiry</Th>
                <Th>Source</Th>
                <Th>Stage</Th>
                <Th>Priority</Th>
                <Th>Assigned to</Th>
                <Th
                  className="cursor-pointer"
                  onClick={() => push({ sort: filters.sort === "received_desc" ? "received_asc" : "received_desc" })}
                >
                  Received {filters.sort === "received_asc" ? "↑" : "↓"}
                </Th>
                <Th>Customer</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((e) => (
                <Tr key={e.id} className="cursor-pointer hover:bg-canvas" onClick={() => router.push(`/enquiries/list/${e.id}`)}>
                  <Td className="whitespace-normal">
                    <div className="font-medium text-ink">{e.name ?? "Unknown"}</div>
                    <div className="text-xs text-muted">
                      {e.phone ? phoneDisplay(e.phone) : "No phone"}
                      {e.company ? ` · ${e.company}` : ""}
                    </div>
                  </Td>
                  <Td>
                    <div>{e.source}</div>
                    {e.sourceForm ? <div className="text-xs text-muted">{e.sourceForm}</div> : null}
                  </Td>
                  <Td><Badge tone={STAGE_TONE[e.stage]}>{STAGE_LABEL[e.stage]}</Badge></Td>
                  <Td><Badge tone={PRIORITY_TONE[e.priority]}>{PRIORITY_LABEL[e.priority]}</Badge></Td>
                  <Td>{e.assignedToName ?? <span className="text-muted">Unassigned</span>}</Td>
                  <Td>{new Date(e.receivedAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}</Td>
                  <Td>
                    {e.customerId ? (
                      <Badge tone="success">Linked</Badge>
                    ) : (
                      <span className="text-muted">Not linked</span>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </table>
          {items.length === 0 ? (
            <EmptyState
              title="No enquiries match these filters"
              body="Try clearing a filter or searching a different name, phone or company."
            />
          ) : null}
        </div>
      </div>

      {totalPages > 1 ? (
        <div className="mt-3 flex items-center justify-between">
          <span className="text-[13px] text-muted">Page {page} of {totalPages}</span>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => push({ page: page - 1 })}>
              Previous
            </Button>
            <Button variant="secondary" size="sm" disabled={page >= totalPages} onClick={() => push({ page: page + 1 })}>
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
