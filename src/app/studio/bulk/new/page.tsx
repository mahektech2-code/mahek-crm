import type { Metadata } from "next";
import Link from "next/link";
import { Input, PageHeader, buttonClass } from "@/components/ui/primitives";
import { resolveScope } from "@/lib/access-control";
import { BULK_MAX } from "@/lib/studio/limits";
import { LIST_LABEL, RECIPIENT_LISTS, audienceOf, isRecipientList, listRecipients, recipientCounts } from "@/lib/studio/recipients";
import { getStudioRegistry } from "@/lib/studio/registry-service";
import { designCard, wordingChoices } from "@/lib/studio/service";
import { BulkForm, type BulkDesignOption } from "../../_ui/bulk-form";
import { Tabs } from "../../_ui/parts";

export const metadata: Metadata = { title: "New bulk run" };
export const dynamic = "force-dynamic";

export default async function NewBulk({ searchParams }: { searchParams: Promise<{ list?: string; q?: string; occasion?: string; design?: string }> }) {
  const sp = await searchParams;
  const list = isRecipientList(sp.list) ? sp.list : "customer";
  const audience = audienceOf(list);
  const q = (sp.q ?? "").slice(0, 80);
  const { scope } = await resolveScope();
  const registry = await getStudioRegistry();
  const templates = registry.list({ audience }).filter((t) => !sp.occasion || t.manifest.occasion === sp.occasion);
  const designs: BulkDesignOption[] = await Promise.all(
    templates.map(async (t) => {
      const card = designCard(registry, t, audience);
      const wordings = Object.fromEntries(
        await Promise.all(card.languages.map(async (l) => [l.code, await wordingChoices({ templateId: t.manifest.id, language: l.code, audience, company: "their company", contact: null, product: null })] as const)),
      );
      return { id: card.id, name: card.name, occasionLabel: card.occasionLabel, preview: card.preview, languages: card.languages, wordings, requiresProduct: card.requiresProduct };
    }),
  );
  const [recipients, counts] = await Promise.all([listRecipients({ userIds: scope.userIds, list, q, page: 1, pageSize: 200 }), recipientCounts(scope.userIds)]);
  const keep = (over: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ list, q: q || undefined, occasion: sp.occasion, ...over })) if (v) p.set(k, v);
    return `/studio/bulk/new?${p.toString()}`;
  };
  return (
    <div className="mx-auto max-w-[1180px] px-6 py-6">
      <div className="mb-1 text-[13px] text-muted">
        <Link href="/studio/bulk">Bulk posters</Link> / New
      </div>
      <PageHeader title="Bulk posters" subtitle={`One design for up to ${BULK_MAX} people at once, downloaded as a ZIP.`} />
      <Tabs items={RECIPIENT_LISTS.map((l) => ({ href: keep({ list: l, q: undefined }), label: LIST_LABEL[l], count: counts[l], active: l === list }))} />
      {sp.occasion ? (
        <p className="mb-3 text-[13px] text-muted">
          Showing the designs for one occasion. <Link href={keep({ occasion: undefined })}>Show every design</Link>
        </p>
      ) : null}
      <form className="mb-3 flex gap-2" action="/studio/bulk/new">
        <input type="hidden" name="list" value={list} />
        {sp.occasion ? <input type="hidden" name="occasion" value={sp.occasion} /> : null}
        <Input name="q" defaultValue={q} placeholder="Narrow the list: name, company or city" className="w-[360px]" />
        <button className={buttonClass({ variant: "secondary" })} type="submit">Search</button>
      </form>
      {recipients.total > recipients.rows.length ? (
        <p className="mb-3 text-[13px] text-muted">Showing the newest {recipients.rows.length} of {recipients.total}. Search to find somebody further down.</p>
      ) : null}
      <BulkForm
        key={`${list}|${sp.occasion ?? ""}`}
        list={list}
        designs={designs}
        initialDesign={sp.design ?? null}
        max={BULK_MAX}
        recipients={recipients.rows.map((r) => ({ id: r.id, company: r.company, contact: r.contact, place: [r.city, r.state].filter(Boolean).join(", "), doNotContact: r.doNotContact }))}
      />
    </div>
  );
}
