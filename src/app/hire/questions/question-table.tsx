"use client";

import { useState } from "react";
import Link from "next/link";
import { cx } from "@/components/ui/primitives";
import type { QuestionBankRow } from "@/lib/hire/services/blueprints";
import { Empty, Icon, Pill, type Tone } from "../_ui/kit";

const MODE: Record<string, [string, Tone]> = { ai_rubric: ["AI rubric", "ai"], fixed_choice: ["Fixed choice", "neutral"], calculated: ["Calculated", "neutral"], manual: ["Manual", "neutral"] };

export function QuestionTable({ rows }: { rows: QuestionBankRow[] }) {
  const [q, setQ] = useState("");
  const [role, setRole] = useState("");
  const [mode, setMode] = useState("");
  const [onlyCritic, setOnlyCritic] = useState(false);
  const [size, setSize] = useState(25);
  const [page, setPage] = useState(0);
  const roles = [...new Set(rows.map((r) => r.blueprintTitle))];
  const t = q.trim().toLowerCase();
  const shown = rows.filter((r) => (!role || r.blueprintTitle === role) && (!mode || r.mode === mode) && (!onlyCritic || r.critic.length > 0) && (!t || `${r.text} ${r.competencies.join(" ")}`.toLowerCase().includes(t)));
  const pages = Math.max(1, Math.ceil(shown.length / size));
  const at = Math.min(page, pages - 1);
  const reset = () => setPage(0);
  return (
    <div className="rounded-[6px] border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-divider px-4 py-3">
        <span className="relative">
          <Icon n="search" s={16} className="pointer-events-none absolute top-[9px] left-2.5 text-muted" />
          <input value={q} onChange={(e) => { setQ(e.target.value); reset(); }} placeholder="Search questions" className="h-[34px] w-[280px] rounded-[4px] border border-line bg-canvas pr-3 pl-8 text-sm outline-none focus:border-brand focus:bg-surface" />
        </span>
        <select value={role} onChange={(e) => { setRole(e.target.value); reset(); }} className="h-[34px] rounded-[4px] border border-line bg-surface px-2.5 text-sm">
          <option value="">Every role</option>
          {roles.map((r) => <option key={r}>{r}</option>)}
        </select>
        <select value={mode} onChange={(e) => { setMode(e.target.value); reset(); }} className="h-[34px] rounded-[4px] border border-line bg-surface px-2.5 text-sm">
          <option value="">Every scoring mode</option>
          {Object.entries(MODE).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <label className="ml-1 flex cursor-pointer items-center gap-2 text-sm text-body">
          <input type="checkbox" checked={onlyCritic} onChange={(e) => { setOnlyCritic(e.target.checked); reset(); }} className="accent-[#6835FB]" />
          Only with critic findings
        </label>
      </div>
      {shown.length ? (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-left text-xs font-medium tracking-[0.04em] text-muted uppercase">
              {["Question", "Role", "Stage", "Competency", "Mode", "Max", "Critic"].map((h) => <th key={h} className="border-b border-divider px-4 py-2.5 font-medium">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {shown.slice(at * size, at * size + size).map((r) => {
              const [ml, mt] = MODE[r.mode] ?? [r.mode, "neutral"];
              return (
                <tr key={`${r.blueprintId}.${r.key}`} className="hire-row border-b border-divider align-top hover:bg-page">
                  <td className="max-w-[440px] px-4 py-2.5 text-heading">
                    <Link href={`/hire/blueprints/${r.blueprintId}?s=rubrics&q=${encodeURIComponent(r.key)}`} className="text-heading">{r.text || <span className="text-faint">(no text)</span>}</Link>
                    {!r.approved ? <span className="ml-2"><Pill tone="warn">Not approved</Pill></span> : null}
                  </td>
                  <td className="px-4 py-2.5 text-body">{r.blueprintTitle} <span className="text-muted tabular-nums">v{r.version}</span></td>
                  <td className="px-4 py-2.5 text-body">{r.stage}</td>
                  <td className={cx("px-4 py-2.5", r.competencies.length ? "text-body" : "text-danger")}>{r.competencies.join(", ") || "None"}</td>
                  <td className="px-4 py-2.5"><Pill tone={mt}>{r.ai && r.mode === "ai_rubric" ? "◈ " : ""}{ml}</Pill></td>
                  <td className="px-4 py-2.5 tabular-nums">{r.max}</td>
                  <td className="max-w-[260px] px-4 py-2.5 text-[13px] text-ai">{r.critic.length ? `◈ ${r.critic[0]}${r.critic.length > 1 ? ` (+${r.critic.length - 1})` : ""}` : <span className="text-faint">—</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <div className="p-6"><Empty title="No question matches">Clear a filter to see more.</Empty></div>
      )}
      <div className="flex items-center gap-3 border-t border-divider px-4 py-2.5 text-[13px] text-muted">
        <span className="tabular-nums">{shown.length ? `${at * size + 1}–${Math.min(shown.length, at * size + size)} of ${shown.length}` : "0"}</span>
        <span className="flex-1" />
        <select value={size} onChange={(e) => { setSize(Number(e.target.value)); reset(); }} className="h-[30px] rounded-[4px] border border-line bg-surface px-2 text-[13px]">
          {[25, 50, 100].map((n) => <option key={n} value={n}>{n} rows</option>)}
        </select>
        <button disabled={at === 0} onClick={() => setPage(at - 1)} className="h-[30px] cursor-pointer rounded-[4px] border border-line bg-surface px-2.5 disabled:cursor-not-allowed disabled:text-faint">Previous</button>
        <button disabled={at >= pages - 1} onClick={() => setPage(at + 1)} className="h-[30px] cursor-pointer rounded-[4px] border border-line bg-surface px-2.5 disabled:cursor-not-allowed disabled:text-faint">Next</button>
      </div>
    </div>
  );
}
