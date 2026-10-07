"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { cx, Select } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { assignBulk, tryMoveCandidate, type MoveBlocked } from "@/lib/hire/actions/pipeline";
import type { BoardRow } from "@/lib/hire/services/pipeline";
import { AiMark, Btn, Empty, fd, hs, Icon, Pill, ScoreChip, StatusPill } from "../_ui/kit";
import { AddCandidate } from "./add-candidate";
import { MoveModal } from "./move-modal";
import { TYPE_ORDER, type BoardBlueprint, type PipelineData } from "./types";

/* ---------------------------------------------------------------------------
 * The pipeline, drawn two ways from one filtered list: a kanban by stage and
 * a dense table. With "All roles" the kanban groups stages by TYPE across
 * blueprints, read-only — a card moves only on its own role's stages, because
 * "Interviews" across three roles is not one place anybody can be moved to.
 * ------------------------------------------------------------------------- */

type Filters = { bp: string; loc: string; rec: string; status: string; sla: boolean; range: string; q: string };
const NO_FILTERS: Filters = { bp: "", loc: "", rec: "", status: "", sla: false, range: "", q: "" };

const STATUS_LABEL: Record<string, string> = { in_progress: "In progress", on_hold: "On hold", hired: "Hired", rejected: "Rejected", withdrawn: "Withdrawn", offer_declined: "Offer declined", archived: "Archived" };
const LIVE = new Set(["in_progress", "on_hold", "hired"]);
const CARD_LIMIT = 40;

type SortKey = "name" | "role" | "loc" | "stage" | "score" | "hrs" | "rec" | "applied" | "status";

export function PipelineView({ data, initialView }: { data: PipelineData; initialView: "kanban" | "table" }) {
  const router = useRouter();
  const toast = useToast();
  const [view, setView] = useState<"kanban" | "table">(initialView);
  const [f, setF] = useState<Filters>(NO_FILTERS);
  const [fOpen, setFOpen] = useState(false);
  const [sort, setSort] = useState<[SortKey, 1 | -1]>(["hrs", -1]);
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(25);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<{ appId: string; target: string; info: MoveBlocked } | null>(null);
  const [adding, setAdding] = useState(false);
  const [assign, setAssign] = useState<"recruiterId" | "interviewerId" | null>(null);
  const [pending, start] = useTransition();

  const set = (patch: Partial<Filters>) => {
    setF((x) => ({ ...x, ...patch }));
    setPage(0);
    setSel(new Set());
  };

  const bpById = useMemo(() => new Map(data.blueprints.map((b) => [b.id, b])), [data.blueprints]);
  const role = f.bp ? bpById.get(f.bp) ?? null : null;

  /* Scoped rows narrowed by everything except status (status narrows per view). */
  const base = useMemo(() => {
    const q = f.q.trim().toLowerCase();
    const qd = q.replace(/\D/g, "");
    return data.rows.filter(
      (r) =>
        (!f.bp || r.blueprintId === f.bp) &&
        (!f.loc || r.location === f.loc) &&
        (!f.rec || r.recruiterName === f.rec) &&
        (!f.sla || r.slaBreach) &&
        (!f.range || new Date(r.appliedAt).getTime() >= data.nowMs - Number(f.range) * 86_400_000) &&
        (!q || r.name.toLowerCase().includes(q) || r.code.toLowerCase() === q || (qd.length >= 4 && r.phone.replace(/\D/g, "").includes(qd))),
    );
  }, [data.rows, data.nowMs, f]);
  const rows = useMemo(() => base.filter((r) => !f.status || r.status === f.status), [base, f.status]);

  const locations = useMemo(() => [...new Set(data.rows.map((r) => r.location).filter(Boolean) as string[])].sort(), [data.rows]);
  const recruiters = useMemo(() => [...new Set(data.rows.map((r) => r.recruiterName).filter(Boolean) as string[])].sort(), [data.rows]);
  const roleCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of data.rows) m.set(r.blueprintId, (m.get(r.blueprintId) ?? 0) + 1);
    return m;
  }, [data.rows]);
  const roleOpts = data.blueprints.filter((b) => roleCounts.get(b.id) || b.status === "draft" || b.status === "published");

  /* ------------------------------------------------------------ kanban */
  type Col = { key: string; name: string; sub: string; cards: BoardRow[]; dropKey: string | null; total: number };
  const cols: Col[] = useMemo(() => {
    const live = rows.filter((r) => LIVE.has(r.status));
    if (role) {
      const idx = (r: BoardRow) => (r.status === "hired" ? role.stages.length : role.stages.findIndex((s) => s.key === r.stageKey));
      const reached = (i: number) => base.filter((r) => idx(r) >= i).length;
      const list: Col[] = role.stages.map((s, i) => {
        const cards = live.filter((r) => r.status !== "hired" && r.stageKey === s.key).sort((a, b) => b.hoursInStage - a.hoursInStage);
        const conv = i < role.stages.length - 1 && reached(i) ? Math.round((reached(i + 1) / reached(i)) * 100) : null;
        return { key: s.key, name: s.name, sub: conv == null ? `Target ${hs(s.slaHours)}` : `${conv}% move on · target ${hs(s.slaHours)}`, cards, dropKey: s.key, total: cards.length };
      });
      const hired = live.filter((r) => r.status === "hired");
      list.push({ key: "hired", name: "Hired", sub: "MahekOne account provisioned", cards: hired, dropKey: "hired", total: hired.length });
      return list;
    }
    const tIdx = (r: BoardRow) => TYPE_ORDER.findIndex((t) => t.type === r.stageType);
    const reached = (i: number) => base.filter((r) => tIdx(r) >= i).length;
    const present = new Set(data.rows.map((r) => r.stageType));
    return TYPE_ORDER.map((t, i) => ({ t, i }))
      .filter(({ t }) => present.has(t.type) || t.type === "terminal")
      .map(({ t, i }) => {
        const cards = live.filter((r) => r.stageType === t.type).sort((a, b) => b.hoursInStage - a.hoursInStage);
        const nextPresent = TYPE_ORDER.findIndex((x, j) => j > i && present.has(x.type));
        const conv = t.type !== "terminal" && nextPresent > 0 && reached(i) ? Math.round((reached(nextPresent) / reached(i)) * 100) : null;
        return { key: t.type, name: t.name, sub: t.type === "terminal" ? "MahekOne account provisioned" : conv == null ? "Across roles" : `${conv}% move on`, cards, dropKey: null, total: cards.length };
      });
  }, [rows, base, role, data.rows]);

  const move = (appId: string, target: string) => {
    const r = data.rows.find((x) => x.id === appId);
    if (!r || r.stageKey === target) return;
    start(async () => {
      const res = await tryMoveCandidate(appId, target);
      if (!res.ok) {
        toast.push(res.error, "error");
        return;
      }
      if (res.data.moved) {
        toast.push(res.message ?? "Moved.");
        router.refresh();
      } else setBlocked({ appId, target, info: res.data.blocked });
    });
  };

  /* ------------------------------------------------------------- table */
  const sorted = useMemo(() => {
    const val = (r: BoardRow): string | number => {
      switch (sort[0]) {
        case "name": return r.name.toLowerCase();
        case "role": return r.blueprintTitle;
        case "loc": return r.location ?? "";
        case "stage": return r.stageIndex;
        case "score": return r.latestScore ?? -1;
        case "hrs": return r.hoursInStage;
        case "rec": return r.recruiterName ?? "";
        case "applied": return r.appliedAt;
        case "status": return r.status;
      }
    };
    return [...rows].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      return (x < y ? -1 : x > y ? 1 : 0) * sort[1];
    });
  }, [rows, sort]);
  const pages = Math.max(1, Math.ceil(sorted.length / size));
  const pg = Math.min(page, pages - 1);
  const pageRows = sorted.slice(pg * size, pg * size + size);
  const allSel = pageRows.length > 0 && pageRows.every((r) => sel.has(r.id));

  const exportCsv = () => {
    const list = sel.size ? sorted.filter((r) => sel.has(r.id)) : sorted;
    const head = ["Code", "Name", "Phone", "Role", "Version", "Location", "Stage", data.can.seesScores ? "Latest score" : null, "Hours in stage", "Recruiter", "Applied", "Status"].filter(Boolean) as string[];
    const esc = (v: unknown) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [head.join(",")].concat(
      list.map((r) =>
        [r.code, r.name, r.phone, r.blueprintTitle, r.version, r.location, r.stageName, ...(data.can.seesScores ? [r.latestScore] : []), r.hoursInStage, r.recruiterName, r.appliedAt.slice(0, 10), STATUS_LABEL[r.status] ?? r.status].map(esc).join(","),
      ),
    );
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `hire-candidates-${new Date(data.nowMs).toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const chips: { l: string; x: () => void }[] = [];
  if (f.loc) chips.push({ l: f.loc, x: () => set({ loc: "" }) });
  if (f.rec) chips.push({ l: `Recruiter: ${f.rec}`, x: () => set({ rec: "" }) });
  if (f.status) chips.push({ l: STATUS_LABEL[f.status] ?? f.status, x: () => set({ status: "" }) });
  if (f.range) chips.push({ l: `Applied in the last ${f.range} days`, x: () => set({ range: "" }) });
  if (f.sla) chips.push({ l: "Past stage target", x: () => set({ sla: false }) });
  if (f.q) chips.push({ l: `“${f.q}”`, x: () => set({ q: "" }) });
  const filtered = chips.length > 0;

  const breaches = rows.filter((r) => r.slaBreach).length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex h-[34px] items-center gap-2 rounded-[4px] border border-line-strong bg-surface pl-2.5 text-sm">
          <span className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">Role</span>
          <select value={f.bp} onChange={(e) => set({ bp: e.target.value })} className="h-full max-w-[280px] cursor-pointer border-0 bg-transparent pr-2 text-sm text-heading outline-none">
            <option value="">All roles ({data.rows.length})</option>
            {roleOpts.map((b) => (
              <option key={b.id} value={b.id}>
                {b.title} · v{b.version}
                {b.status !== "published" ? ` (${b.status})` : ""} — {roleCounts.get(b.id) ?? 0}
              </option>
            ))}
          </select>
        </label>
        <span className="relative w-[240px]">
          <Icon n="search" s={16} className="pointer-events-none absolute top-[9px] left-2.5 text-muted" />
          <input value={f.q} onChange={(e) => set({ q: e.target.value })} placeholder="Filter by name or phone" className="h-[34px] w-full rounded-[4px] border border-line-strong bg-surface pr-2.5 pl-8 text-sm outline-none focus:border-brand" />
        </span>
        <Btn size="sm" kind={fOpen || filtered ? "ghost" : "secondary"} onClick={() => setFOpen((o) => !o)}>
          Filters{filtered ? ` · ${chips.length}` : ""}
        </Btn>
        {filtered ? (
          <button onClick={() => set(NO_FILTERS.bp === f.bp ? NO_FILTERS : { ...NO_FILTERS, bp: f.bp })} className="h-[34px] cursor-pointer border-0 bg-transparent px-2 text-[13px] font-medium text-brand-hover">
            Clear all
          </button>
        ) : null}
        <span className="flex-1" />
        <span className="text-[13px] text-muted tabular-nums">
          {rows.length} candidate{rows.length === 1 ? "" : "s"} · {breaches} past stage target
        </span>
        <span className="inline-flex gap-0.5 rounded-[6px] border border-line bg-surface p-[3px]">
          {(["kanban", "table"] as const).map((v) => (
            <button key={v} onClick={() => setView(v)} className={cx("h-7 cursor-pointer rounded-[4px] border-0 px-3 text-[13px] font-medium", view === v ? "bg-brand text-white" : "bg-transparent text-body")}>
              {v === "kanban" ? "Board" : "Table"}
            </button>
          ))}
        </span>
        {data.can.addCandidate ? (
          <Btn kind="primary" size="sm" onClick={() => setAdding(true)}>
            <Icon n="plus" s={14} /> Add candidate
          </Btn>
        ) : null}
      </div>

      {fOpen ? (
        <div className="grid grid-cols-5 gap-3 rounded-[6px] border border-line bg-surface px-4 py-3.5">
          <FilterSelect label="Location" value={f.loc} onChange={(v) => set({ loc: v })} opts={[["", "All locations"], ...locations.map((l) => [l, l] as [string, string])]} />
          <FilterSelect label="Recruiter" value={f.rec} onChange={(v) => set({ rec: v })} opts={[["", "All recruiters"], ...recruiters.map((l) => [l, l] as [string, string])]} />
          <FilterSelect label="Status" value={f.status} onChange={(v) => set({ status: v })} opts={[["", "Any status"], ...Object.entries(STATUS_LABEL)]} />
          <FilterSelect label="Applied" value={f.range} onChange={(v) => set({ range: v })} opts={[["", "Any time"], ["7", "Last 7 days"], ["30", "Last 30 days"], ["90", "Last 90 days"]]} />
          <FilterSelect label="Stage target" value={f.sla ? "1" : ""} onChange={(v) => set({ sla: v === "1" })} opts={[["", "Any"], ["1", "Past stage target"]]} />
        </div>
      ) : null}

      {chips.length ? (
        <div className="flex flex-wrap gap-1.5">
          {chips.map((c) => (
            <span key={c.l} className="inline-flex h-[26px] items-center gap-1 rounded-[13px] bg-brand-soft pr-1 pl-2.5 text-xs font-medium text-brand-hover">
              {c.l}
              <button onClick={c.x} aria-label={`Remove ${c.l}`} className="h-5 w-5 cursor-pointer border-0 bg-transparent text-brand-hover">
                ✕
              </button>
            </span>
          ))}
        </div>
      ) : null}

      {!rows.length ? (
        data.rows.length ? (
          <Empty title="No candidates match these filters" action={<Btn onClick={() => set(NO_FILTERS)}>Clear filters</Btn>}>
            Nothing in your list matches the filters you set.
          </Empty>
        ) : (
          <Empty title="No candidates yet" action={data.can.addCandidate ? <Btn kind="primary" onClick={() => setAdding(true)}>Add candidate</Btn> : undefined}>
            {data.me.role === "interviewer"
              ? "Candidates appear here when a recruiter assigns you to interview them. You see only the people you are interviewing."
              : "Candidates appear here as they apply through the portal or are added by a recruiter."}
          </Empty>
        )
      ) : view === "kanban" ? (
        <>
          {!role ? (
            <div className="text-[13px] text-muted">Across all roles the columns group stages by type. Pick a role to see its own stages and move candidates through them.</div>
          ) : null}
          <div className="flex items-start gap-3 overflow-x-auto pb-3">
            {cols.map((col) => {
              const isOver = over === col.key && dragId && col.dropKey;
              return (
                <div
                  key={col.key}
                  onDragOver={(e) => {
                    if (!col.dropKey || !dragId) return;
                    e.preventDefault();
                    if (over !== col.key) setOver(col.key);
                  }}
                  onDragLeave={() => setOver((o) => (o === col.key ? null : o))}
                  onDrop={(e) => {
                    e.preventDefault();
                    const id = dragId;
                    setOver(null);
                    setDragId(null);
                    if (id && col.dropKey) move(id, col.dropKey);
                  }}
                  className={cx("w-[252px] flex-none rounded-[6px] border transition-colors duration-150", isOver ? "border-brand-softer bg-[#F7F4FF]" : "border-divider bg-canvas")}
                >
                  <div className="border-b border-divider px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-xs font-semibold tracking-[0.04em] text-heading uppercase">{col.name}</span>
                      <span className="text-[13px] font-semibold text-heading tabular-nums">{col.total}</span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted">{col.sub}</div>
                  </div>
                  <div className="flex max-h-[calc(100vh-290px)] flex-col gap-2 overflow-y-auto p-2">
                    {col.cards.slice(0, CARD_LIMIT).map((r) => (
                      <Card key={r.id} r={r} draggable={Boolean(role) && r.status === "in_progress" && !pending} onDragStart={() => setDragId(r.id)} onDragEnd={() => setDragId(null)} showRole={!role} />
                    ))}
                    {!col.cards.length ? <div className="px-2 py-4 text-center text-xs text-faint">No one here</div> : null}
                    {col.cards.length > CARD_LIMIT ? (
                      <button onClick={() => setView("table")} className="h-[30px] cursor-pointer rounded-[4px] border border-dashed border-line-strong bg-surface text-xs text-body">
                        +{col.cards.length - CARD_LIMIT} more — open in the table
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <div className="overflow-hidden rounded-[6px] border border-line bg-surface">
          {sel.size ? (
            <div className="flex items-center gap-2.5 border-b border-brand-softer bg-brand-soft px-3.5 py-2 text-[13px] text-brand-deep">
              <span className="font-semibold">{sel.size} selected</span>
              {data.can.addCandidate ? (
                <>
                  <Btn size="sm" onClick={() => setAssign("recruiterId")}>Assign recruiter</Btn>
                  <Btn size="sm" onClick={() => setAssign("interviewerId")}>Assign interviewer</Btn>
                </>
              ) : null}
              <Btn size="sm" onClick={exportCsv}>Export CSV</Btn>
              <span className="flex-1" />
              <button onClick={() => setSel(new Set())} className="cursor-pointer border-0 bg-transparent text-[13px] text-brand-hover">
                Clear
              </button>
            </div>
          ) : null}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1080px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-line bg-page text-left">
                  <th className="w-10 px-3.5">
                    <input
                      type="checkbox"
                      aria-label="Select this page"
                      checked={allSel}
                      onChange={() => setSel((s) => { const n = new Set(s); pageRows.forEach((r) => (allSel ? n.delete(r.id) : n.add(r.id))); return n; })}
                      className="h-4 w-4 accent-[#6835FB]"
                    />
                  </th>
                  {(
                    [
                      ["name", "Candidate"],
                      ["role", "Role"],
                      ["loc", "Location"],
                      ["stage", "Stage"],
                      ...(data.can.seesScores ? ([["score", "Score"]] as const) : []),
                      ["hrs", "In stage"],
                      ["rec", "Recruiter"],
                      ["applied", "Applied"],
                      ["status", "Status"],
                    ] as [SortKey, string][]
                  ).map(([k, l]) => (
                    <th key={k} className={cx("h-10 px-2.5 text-xs font-medium tracking-[0.04em] text-muted uppercase", k === "score" || k === "hrs" ? "text-right" : "")}>
                      <button onClick={() => setSort(([sk, d]) => [k, sk === k ? (d === 1 ? -1 : 1) : 1])} className="cursor-pointer border-0 bg-transparent p-0 font-medium tracking-[0.04em] text-muted uppercase">
                        {l}
                        {sort[0] === k ? (sort[1] === 1 ? " ↑" : " ↓") : ""}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r) => (
                  <tr key={r.id} className={cx("hire-row cursor-pointer border-b border-divider hover:bg-canvas", r.slaBreach ? "shadow-[inset_3px_0_0_var(--color-warn)]" : "")} onClick={() => router.push(`/hire/c/${r.id}`)}>
                    <td className="px-3.5" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`Select ${r.name}`}
                        checked={sel.has(r.id)}
                        onChange={() => setSel((s) => { const n = new Set(s); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; })}
                        className="h-4 w-4 accent-[#6835FB]"
                      />
                    </td>
                    <td className="max-w-[220px] px-2.5">
                      <span className="block truncate font-medium text-heading">{r.name}</span>
                      <span className="block text-xs text-muted tabular-nums">{r.code} · {r.phone.replace(/^\+91(\d{5})(\d{5})$/, "+91 $1 $2")}</span>
                    </td>
                    <td className="max-w-[200px] truncate px-2.5">{r.blueprintTitle} <span className="text-muted">v{r.version}</span></td>
                    <td className="px-2.5">{r.location ?? "—"}</td>
                    <td className="max-w-[180px] truncate px-2.5">{r.stageName}</td>
                    {data.can.seesScores ? (
                      <td className="px-2.5 text-right">
                        <ScoreChip value={r.latestScore} ai={r.latestAi} title={r.latestStageName ?? undefined} />
                      </td>
                    ) : null}
                    <td className={cx("px-2.5 text-right tabular-nums", r.slaBreach ? "font-medium text-warn-ink" : "text-muted")} title={r.slaBreach ? `Past the ${hs(r.slaHours)} target for this stage` : undefined}>
                      {hs(r.hoursInStage)}
                    </td>
                    <td className="px-2.5">{r.recruiterName ?? <span className="text-muted">Unassigned</span>}</td>
                    <td className="px-2.5 tabular-nums">{fd(r.appliedAt)}</td>
                    <td className="px-2.5">
                      <StatusPill status={r.status} proposal={r.proposalOpen} duplicate={r.duplicateOpen} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center gap-2.5 border-t border-divider px-3.5 py-2.5 text-[13px] text-muted">
            <span className="tabular-nums">
              {sorted.length ? `${pg * size + 1}–${Math.min(sorted.length, pg * size + size)} of ${sorted.length}` : "0"}
            </span>
            <span className="flex-1" />
            {!sel.size ? <Btn size="sm" kind="ghost" onClick={exportCsv}>Export CSV</Btn> : null}
            <span>Rows</span>
            <Select value={String(size)} onChange={(e) => { setSize(Number(e.target.value)); setPage(0); }} className="h-7">
              <option value="25">25</option>
              <option value="50">50</option>
              <option value="100">100</option>
            </Select>
            <Btn size="sm" disabled={pg === 0} onClick={() => setPage(pg - 1)}>‹ Previous</Btn>
            <Btn size="sm" disabled={pg >= pages - 1} onClick={() => setPage(pg + 1)}>Next ›</Btn>
          </div>
        </div>
      )}

      {blocked ? (
        <MoveModal
          key={`${blocked.appId}:${blocked.target}`}
          appId={blocked.appId}
          target={blocked.target}
          info={blocked.info}
          overrideWho={data.overrideWho}
          onClose={() => setBlocked(null)}
        />
      ) : null}
      {adding ? <AddCandidate blueprints={data.blueprints.filter((b) => b.status === "published")} staff={data.staff} me={data.me} onClose={() => setAdding(false)} /> : null}
      {assign ? (
        <AssignDialog
          kind={assign}
          staff={data.staff}
          count={sel.size}
          onClose={() => setAssign(null)}
          onPick={(uid) =>
            start(async () => {
              const r = await toast.run(assignBulk([...sel], { [assign]: uid }));
              if (r.ok) {
                setAssign(null);
                setSel(new Set());
                router.refresh();
              }
            })
          }
        />
      ) : null}
    </div>
  );
}

function FilterSelect({ label, value, onChange, opts }: { label: string; value: string; onChange: (v: string) => void; opts: [string, string][] }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">{label}</span>
      <Select value={value} onChange={(e) => onChange(e.target.value)} className="w-full">
        {opts.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </Select>
    </label>
  );
}

function Card({ r, draggable, onDragStart, onDragEnd, showRole }: { r: BoardRow; draggable: boolean; onDragStart: () => void; onDragEnd: () => void; showRole: boolean }) {
  const badge = r.proposalOpen ? (
    <Pill tone="warn">Rejection proposed</Pill>
  ) : r.duplicateOpen ? (
    <Pill tone="warn">Possible duplicate</Pill>
  ) : r.status === "on_hold" ? (
    <Pill tone="warn" title={r.holdReason ?? undefined}>On hold</Pill>
  ) : r.overridden ? (
    <Pill tone="info" title="Entered a stage through a recorded gate override">Override</Pill>
  ) : r.toReview ? (
    <Pill tone="ai" title="AI scores waiting for a person to confirm them">◈ To review</Pill>
  ) : null;
  return (
    <Link
      href={`/hire/c/${r.id}`}
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", r.id);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      className={cx(
        "block rounded-[6px] border border-line bg-surface px-3 py-2.5 no-underline hover:border-line-strong hover:no-underline",
        draggable ? "cursor-grab" : "cursor-pointer",
        r.slaBreach ? "shadow-[inset_3px_0_0_var(--color-warn)]" : "",
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-heading">{r.name}</span>
        {badge}
      </div>
      <div className="mt-0.5 text-xs leading-4 text-muted">
        {showRole ? `${r.blueprintTitle} · ${r.stageName}` : r.blueprintTitle} · {r.location ?? "—"}
      </div>
      <div className="mt-2 flex items-center gap-2">
        {r.latestScore != null ? (
          <span className="inline-flex items-center gap-1 text-[13px] font-semibold text-heading tabular-nums" title={`${r.latestStageName}${r.latestAi ? " · AI-scored, human-confirmed" : ""}`}>
            {r.latestAi ? <AiMark /> : null}
            {r.latestScore}
          </span>
        ) : null}
        <span className="flex-1" />
        <span
          className={cx("inline-flex items-center gap-1 text-xs tabular-nums", r.slaBreach ? "font-medium text-warn-ink" : "text-muted")}
          title={r.slaBreach ? `Past the ${hs(r.slaHours)} target for this stage` : "Time in this stage"}
        >
          {r.slaBreach ? <Icon n="warn" s={12} /> : null}
          {hs(r.hoursInStage)}
        </span>
      </div>
    </Link>
  );
}

function AssignDialog({ kind, staff, count, onClose, onPick }: { kind: "recruiterId" | "interviewerId"; staff: { id: string; name: string; role: string | null }[]; count: number; onClose: () => void; onPick: (uid: string) => void }) {
  const [uid, setUid] = useState("");
  const pool = staff.filter((s) => (kind === "recruiterId" ? ["recruiter", "hr_head", "admin", "hiring_manager"].includes(s.role ?? "") : true));
  return (
    <Modal
      open
      onClose={onClose}
      title={`Assign ${kind === "recruiterId" ? "a recruiter" : "an interviewer"} to ${count} candidate${count === 1 ? "" : "s"}`}
      footer={
        <>
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn kind="primary" disabled={!uid} onClick={() => onPick(uid)}>
            Assign
          </Btn>
        </>
      }
    >
      <Select value={uid} onChange={(e) => setUid(e.target.value)} className="w-full">
        <option value="">Choose a person…</option>
        {pool.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </Select>
    </Modal>
  );
}

export type { BoardBlueprint };
