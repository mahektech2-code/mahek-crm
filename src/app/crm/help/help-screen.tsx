"use client";

import * as React from "react";
import Link from "next/link";
import { Card, Input, PageHeader, Select, cx } from "@/components/ui/primitives";
import { longDate } from "@/lib/format";

type Article = {
  id: string;
  title: string;
  category: string;
  role: string;
  isScript: boolean;
  scriptBody: string | null;
  body: string;
  updatedOn: string;
};

export function HelpScreen({
  role,
  articles,
}: {
  role: string;
  articles: Article[];
}) {
  const [query, setQuery] = React.useState("");
  const [roleFilter, setRoleFilter] = React.useState(
    role === "telecaller" ? "Telecaller" : "All roles",
  );
  const [category, setCategory] = React.useState("All");
  const [activeId, setActiveId] = React.useState<string | null>(null);

  const categories = ["All", ...Array.from(new Set(articles.map((a) => a.category)))];

  const matching = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return articles.filter((a) => {
      if (roleFilter !== "All roles" && a.role !== roleFilter) return false;
      if (!q && category !== "All" && a.category !== category) return false;
      if (!q) return true;
      return (
        a.title.toLowerCase().includes(q) ||
        a.body.toLowerCase().includes(q) ||
        (a.scriptBody ?? "").toLowerCase().includes(q)
      );
    });
  }, [articles, query, roleFilter, category]);

  // Falls back to the first result rather than stranding an out-of-view article.
  const active =
    matching.find((a) => a.id === activeId) ?? matching[0] ?? null;
  const searching = query.trim().length > 0;

  return (
    <div className="px-6 pt-6 pb-10">
      <PageHeader
        title="Help center"
        subtitle="SOPs and call scripts, filtered to your role."
        actions={
          <Link
            href="/crm/components"
            className="inline-flex h-9 items-center rounded-[4px] border border-line-strong bg-surface px-3.5 text-sm font-medium text-body no-underline hover:bg-canvas hover:no-underline"
          >
            Component library
          </Link>
        }
      />

      <Card className="mb-4 flex items-center gap-3 px-5 py-4">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={'Search scripts and SOPs — try "payment" or "short supply"'}
          className="h-10 min-w-0 flex-1 text-[15px]"
        />
        <Select
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value)}
          className="h-10"
        >
          {["All roles", "Telecaller", "Manager"].map((r) => (
            <option key={r}>{r}</option>
          ))}
        </Select>
      </Card>

      <div className="grid grid-cols-[clamp(180px,15%,240px)_clamp(240px,22%,320px)_minmax(0,1fr)] items-start gap-4">
        <Card className="overflow-hidden py-1.5">
          {categories.map((c) => {
            const count =
              c === "All"
                ? articles.filter(
                    (a) => roleFilter === "All roles" || a.role === roleFilter,
                  ).length
                : articles.filter(
                    (a) =>
                      a.category === c &&
                      (roleFilter === "All roles" || a.role === roleFilter),
                  ).length;
            return (
              <button
                key={c}
                onClick={() => {
                  setCategory(c);
                  setQuery("");
                }}
                className={cx(
                  "flex w-full cursor-pointer items-center justify-between px-3.5 py-2 text-left text-sm",
                  category === c && !searching
                    ? "bg-brand-soft font-medium text-[#5223E0]"
                    : "text-body hover:bg-canvas",
                )}
              >
                <span>{c}</span>
                <span className="text-muted">{count}</span>
              </button>
            );
          })}
        </Card>

        <Card className="overflow-hidden">
          {searching ? (
            <div className="border-b border-divider px-3.5 py-2 text-[13px] text-muted">
              {matching.length} result{matching.length === 1 ? "" : "s"} for “{query}”
            </div>
          ) : null}
          {matching.length ? (
            matching.map((a) => (
              <button
                key={a.id}
                onClick={() => setActiveId(a.id)}
                className={cx(
                  "block w-full cursor-pointer border-b border-divider px-3.5 py-2.5 text-left last:border-0",
                  a.id === active?.id ? "bg-brand-soft" : "hover:bg-canvas",
                )}
              >
                <span className="block text-sm font-medium text-ink">{a.title}</span>
                <span className="mt-0.5 block text-[13px] text-muted">
                  {a.role} · {a.category}
                </span>
              </button>
            ))
          ) : (
            <div className="px-3.5 py-8 text-center text-[15px] text-muted">
              No article matches that. Try a shorter word, or clear the role filter.
            </div>
          )}
        </Card>

        <Card className="p-6">
          {active ? (
            <div className="max-w-[680px]">
              <h2 className="text-[22px] leading-7 font-semibold text-ink">
                {active.title}
              </h2>
              <div className="mt-1 mb-5 text-[13px] text-muted">
                {active.role} · {active.category} · updated {longDate(active.updatedOn)}
              </div>

              {active.isScript && active.scriptBody ? (
                <div className="mb-5 rounded-[4px] border border-brand-softer border-l-[3px] border-l-brand bg-brand-soft p-5">
                  <div className="mb-2.5 text-[11px] font-medium tracking-[0.04em] text-[#5223E0] uppercase">
                    Read this aloud
                  </div>
                  <div className="text-[18px] leading-8 whitespace-pre-wrap text-ink">
                    {active.scriptBody}
                  </div>
                </div>
              ) : null}

              <div className="text-[15px] leading-[26px] whitespace-pre-wrap text-body">
                {active.body}
              </div>
            </div>
          ) : (
            <div className="py-10 text-center text-[15px] text-muted">
              Pick an article from the list.
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
