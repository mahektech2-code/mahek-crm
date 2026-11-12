import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Card, EmptyState, Input, PageHeader, Td, Th, buttonClass } from "@/components/ui/primitives";
import { resolveScope } from "@/lib/access-control";
import { LIST_LABEL, RECIPIENT_LISTS, isRecipientList, listRecipients, recipientCounts } from "@/lib/studio/recipients";
import { Tabs } from "../_ui/parts";

export const metadata: Metadata = { title: "Make a poster" };
export const dynamic = "force-dynamic";

const HINT: Record<string, string> = {
  lead: "New leads in your book — a welcome or a festival greeting starts the conversation.",
  customer: "Customers in your book — a festival greeting or a product they buy.",
  lost: "Leads marked lost — a festival greeting is a reason to get back in touch without asking for anything.",
};

export default async function MakePage({ searchParams }: { searchParams: Promise<{ list?: string; q?: string; page?: string }> }) {
  const sp = await searchParams;
  const list = isRecipientList(sp.list) ? sp.list : "lead";
  const q = (sp.q ?? "").slice(0, 80);
  const { scope } = await resolveScope();
  const [result, counts] = await Promise.all([listRecipients({ userIds: scope.userIds, list, q, page: Number(sp.page) || 1 }), recipientCounts(scope.userIds)]);
  const href = (over: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    const merged = { list, q: q || undefined, page: undefined, ...over } as Record<string, string | number | undefined>;
    for (const [k, v] of Object.entries(merged)) if (v !== undefined && v !== "") p.set(k, String(v));
    return `/studio/make?${p.toString()}`;
  };
  return (
    <div className="mx-auto max-w-[1180px] px-6 py-6">
      <PageHeader title="Make a poster" subtitle="Pick who it is for. Only your own book is listed — your team's too, if you manage one." />
      <Tabs items={RECIPIENT_LISTS.map((l) => ({ href: href({ list: l, q: undefined }), label: LIST_LABEL[l], count: counts[l], active: l === list }))} />
      <p className="mb-3 text-[13px] text-muted">{HINT[list]}</p>
      <form className="mb-3 flex gap-2" action="/studio/make">
        <input type="hidden" name="list" value={list} />
        <Input name="q" defaultValue={q} placeholder="Search by name, company or city" className="w-[360px]" />
        <button className={buttonClass({ variant: "secondary" })} type="submit">Search</button>
      </form>
      <Card>
        {result.rows.length ? (
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <Th>Company</Th>
                <Th>Contact</Th>
                <Th>Place</Th>
                {list !== "customer" ? <Th>Stage</Th> : null}
                <Th className="text-right"> </Th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((r) => (
                <tr key={r.id} className="border-t border-divider">
                  <Td>
                    <span className="font-medium text-ink">{r.company}</span>
                    {r.doNotContact ? (
                      <Badge tone="danger" className="ml-2" title="Marked Do Not Contact: you may make a poster, but do not send it.">
                        Do not contact
                      </Badge>
                    ) : null}
                  </Td>
                  <Td>{r.contact ?? <span className="text-faint">—</span>}</Td>
                  <Td>{[r.city, r.state].filter(Boolean).join(", ") || <span className="text-faint">—</span>}</Td>
                  {list !== "customer" ? <Td>{r.stage ?? <span className="text-faint">—</span>}</Td> : null}
                  <Td className="text-right">
                    <Link href={`/studio/make/${encodeURIComponent(r.id)}`} className={buttonClass({ variant: "secondary", size: "sm" })}>
                      Choose a design
                    </Link>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState title={q ? "Nobody matches that search" : `No ${LIST_LABEL[list].toLowerCase()} in your book`} body={q ? "Try fewer words, or a part of the name." : undefined} />
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
