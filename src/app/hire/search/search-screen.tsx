"use client";

import { useState } from "react";
import { runTalentSearch } from "@/lib/hire/actions/talent";
import type { SearchHit, SearchResult } from "@/lib/hire/services/talent";
import { Btn, Callout, Empty, fd, Icon, Pill, Quote } from "../_ui/kit";
import { TalentActions } from "../pool/talent-actions";

const OUTCOMES = [
  { v: "", l: "Any outcome" },
  { v: "open", l: "In the pipeline" },
  { v: "hired", l: "Hired" },
  { v: "rejected", l: "Not hired" },
  { v: "withdrawn", l: "Withdrew" },
  { v: "offer_declined", l: "Declined the offer" },
];
const RECENCY = [
  { v: "all", l: "Any time" },
  { v: "90", l: "Applied in the last 90 days" },
  { v: "365", l: "In the last year" },
  { v: "730", l: "In the last two years" },
];
const STATUS_WORD: Record<string, string> = { rejected: "Not hired", withdrawn: "Withdrew", offer_declined: "Declined offer", hired: "Hired", in_progress: "In pipeline", on_hold: "On hold" };

export function SearchScreen({
  roles,
  locations,
  openRoles,
  canAct,
  why,
}: {
  roles: { key: string; title: string }[];
  locations: string[];
  openRoles: { key: string; title: string }[];
  canAct: boolean;
  why: string;
}) {
  const [q, setQ] = useState("");
  const [role, setRole] = useState("");
  const [location, setLocation] = useState("");
  const [outcome, setOutcome] = useState("");
  const [recency, setRecency] = useState("all");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<SearchResult | null>(null);
  const [error, setError] = useState("");
  const [asked, setAsked] = useState("");
  const [shown, setShown] = useState(25);

  const run = async () => {
    if (!q.trim()) return;
    setBusy(true);
    setError("");
    const r = await runTalentSearch(q, { role: role || undefined, location: location || undefined, outcome: outcome || undefined, recency });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setRes(r.data);
    setAsked(q.trim());
    setShown(25);
  };

  const sel = "h-8 rounded-[4px] border border-line-strong bg-surface px-2 text-[13px]";
  return (
    <div className="flex max-w-[1080px] flex-col gap-4">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <span className="relative flex-1">
          <Icon n="search" s={16} className="absolute top-3 left-3 text-muted" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Describe who you are looking for, in plain words — “field sales, two-wheeler, has handled distributors in Nagpur”"
            className="h-10 w-full rounded-[4px] border border-line-strong pr-3 pl-9 text-[15px] outline-none focus:border-brand"
          />
        </span>
        <Btn kind="primary" type="submit" disabled={busy || !q.trim()} className="h-10">
          {busy ? "Searching…" : "Search the pool"}
        </Btn>
      </form>
      <div className="flex flex-wrap items-center gap-2">
        <select value={role} onChange={(e) => setRole(e.target.value)} className={sel} aria-label="Role">
          <option value="">Any role</option>
          {roles.map((r) => (
            <option key={r.key} value={r.key}>
              {r.title}
            </option>
          ))}
        </select>
        <select value={location} onChange={(e) => setLocation(e.target.value)} className={sel} aria-label="Location">
          <option value="">Any location</option>
          {locations.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
        <select value={outcome} onChange={(e) => setOutcome(e.target.value)} className={sel} aria-label="Outcome">
          {OUTCOMES.map((o) => (
            <option key={o.v} value={o.v}>
              {o.l}
            </option>
          ))}
        </select>
        <select value={recency} onChange={(e) => setRecency(e.target.value)} className={sel} aria-label="Recency">
          {RECENCY.map((o) => (
            <option key={o.v} value={o.v}>
              {o.l}
            </option>
          ))}
        </select>
        <span className="text-xs text-muted">Do-not-contact and retention rules are applied before anything is ranked.</span>
      </div>
      {error ? <Callout tone="danger">{error}</Callout> : null}
      {res?.mode === "keyword" && res.reason ? (
        <Callout tone="warn">
          Matched on words, not meaning — {res.reason.replace(/\.$/, "")}. Results are ordered by how many of your words appear in what each candidate said; rephrase with the words they would have used.
        </Callout>
      ) : null}
      {!res ? (
        <Empty title="Search every past candidate">Ask for the person you need. The pool is searched by what candidates actually said in their interviews and what their CV shows — never by who they are.</Empty>
      ) : res.hits.length === 0 ? (
        <Empty title={`Nothing matches “${asked}”`}>{res.searched} candidates were searched with these filters. Loosen a filter or describe the person differently.</Empty>
      ) : (
        <>
          <div className="text-[13px] text-muted">
            {res.hits.length} of {res.searched} candidates match “{asked}”{res.mode === "semantic" ? ", ranked by how closely what they said matches what you asked" : ""}.
          </div>
          {res.hits.slice(0, shown).map((h) => (
            <Hit key={h.candidateId} h={h} semantic={res.mode === "semantic"} openRoles={openRoles} canAct={canAct} why={why} />
          ))}
          {res.hits.length > shown ? (
            <div>
              <Btn onClick={() => setShown(shown + 25)}>Show 25 more</Btn>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function Hit({ h, semantic, openRoles, canAct, why }: { h: SearchHit; semantic: boolean; openRoles: { key: string; title: string }[]; canAct: boolean; why: string }) {
  const closed = h.status === "rejected" || h.status === "withdrawn" || h.status === "offer_declined";
  return (
    <div className="flex gap-4 rounded-[6px] border border-line bg-surface px-5 py-4">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[15px] font-semibold text-heading">{h.name}</span>
          <Pill tone={h.status === "hired" ? "success" : h.status === "in_progress" || h.status === "on_hold" ? "neutral" : "muted"}>{STATUS_WORD[h.status] ?? h.status}</Pill>
          {h.poolStatus === "silver_medallist" ? <Pill tone="brand">Silver medallist</Pill> : null}
        </div>
        <div className="mt-0.5 text-xs text-muted">
          {h.code} · {h.bpTitle} · {h.location ?? "No location"} · reached {h.stageName} · applied {fd(h.appliedAt)}
          {h.overall != null ? ` · stage average ${h.overall}` : ""}
        </div>
        {h.evidence ? <Quote className="mt-2.5" caption={h.evidence.source}>{h.evidence.text}</Quote> : null}
        <div className="mt-3">
          {closed ? (
            <TalentActions candidateId={h.candidateId} name={h.name} roles={openRoles} silver={h.poolStatus === "silver_medallist"} canAct={canAct} why={why} primary={false} recordHref={`/hire/c/${h.applicationId}`} />
          ) : (
            <a href={`/hire/c/${h.applicationId}`} className="text-[13px]">
              Open their record
            </a>
          )}
        </div>
      </div>
      <div className="flex-none text-right text-xs font-semibold">
        {semantic ? (
          <span className="text-ai" title="How closely their record matches your words, by AI embedding">
            ◈ {Math.round(h.relevance * 100)}% match
          </span>
        ) : (
          <span className="text-muted" title="Share of your words found in their record">
            {Math.round(h.relevance * 100)}% of your words
          </span>
        )}
      </div>
    </div>
  );
}
