import type { Metadata } from "next";
import Link from "next/link";
import { Card, EmptyState, PageHeader, Td, Th, buttonClass } from "@/components/ui/primitives";
import { stamp } from "@/lib/format";
import { LANGUAGE_NAMES, type Language } from "@/lib/studio/domain/language";
import { listPosters } from "@/lib/studio/service";
import { Tabs, plural } from "../_ui/parts";

export const metadata: Metadata = { title: "My posters" };
export const dynamic = "force-dynamic";

export default async function PostersPage({ searchParams }: { searchParams: Promise<{ whose?: string; page?: string }> }) {
  const sp = await searchParams;
  const whose = sp.whose === "team" ? "team" : "mine";
  const result = await listPosters({ whose, page: Number(sp.page) || 1 });
  const href = (over: Record<string, string | number>) => {
    const p = new URLSearchParams({ whose, ...Object.fromEntries(Object.entries(over).map(([k, v]) => [k, String(v)])) });
    return `/studio/posters?${p.toString()}`;
  };
  return (
    <div className="mx-auto max-w-[1180px] px-6 py-6">
      <PageHeader title={whose === "team" ? "Team's posters" : "My posters"} subtitle="Every poster, newest first. Open one to download it or send it again." />
      {result.teamView ? (
        <Tabs
          items={[
            { href: "/studio/posters?whose=mine", label: "Mine", active: whose === "mine" },
            { href: "/studio/posters?whose=team", label: "My team's", active: whose === "team" },
          ]}
        />
      ) : null}
      <Card>
        {result.rows.length ? (
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <Th>For</Th>
                <Th>Design</Th>
                <Th>Made</Th>
                {whose === "team" ? <Th>By</Th> : null}
                <Th>Sent</Th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((p) => (
                <tr key={p.id} className="border-t border-divider">
                  <Td>
                    <Link href={`/studio/posters/${p.id}`} className="font-medium">
                      {p.company}
                    </Link>
                    {p.contact ? <div className="text-[12.5px] text-muted">{p.contact}</div> : null}
                  </Td>
                  <Td>
                    {p.templateName}
                    <div className="text-[12.5px] text-muted">{LANGUAGE_NAMES[p.language as Language] ?? p.language}</div>
                  </Td>
                  <Td>{stamp(p.createdAt)}</Td>
                  {whose === "team" ? <Td>{p.createdByName}</Td> : null}
                  <Td>{p.shareCount ? `${plural(p.shareCount, "time")} · ${stamp(p.lastSharedAt)}` : <span className="text-faint">Not yet</span>}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState title="No posters yet" action={<Link href="/studio/make" className={buttonClass({ variant: "primary" })}>Make a poster</Link>} />
        )}
      </Card>
      {result.pageCount > 1 ? (
        <div className="mt-3 flex items-center justify-between text-sm text-muted">
          <span>
            Page {result.page} of {result.pageCount} · {result.total} in all
          </span>
          <span className="flex gap-2">
            {result.page > 1 ? <Link href={href({ page: result.page - 1 })} className={buttonClass({ size: "sm" })}>Previous</Link> : null}
            {result.page < result.pageCount ? <Link href={href({ page: result.page + 1 })} className={buttonClass({ size: "sm" })}>Next</Link> : null}
          </span>
        </div>
      ) : null}
    </div>
  );
}
