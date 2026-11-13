import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Card, CardHeader, EmptyState, Input, PageHeader, Select, buttonClass } from "@/components/ui/primitives";
import { canOpenModule } from "@/lib/access";
import { requireUser } from "@/lib/auth";
import { getConfig } from "@/lib/config/store";
import { stamp } from "@/lib/format";
import { filterLibrary, libraryFacets } from "@/lib/studio/library";
import { libraryItems, myDesignDrafts } from "@/lib/studio/service";
import { DesignGrid } from "../_ui/parts";
import { LibraryTile } from "../_ui/library";
import { UploadForm } from "../_ui/upload-form";

export const metadata: Metadata = { title: "Designs" };
export const dynamic = "force-dynamic";

type SP = { q?: string; occasion?: string; language?: string; uploader?: string };

/**
 * THE SHARED TEMPLATE LIBRARY. Every published design — shipped or uploaded — in
 * one grid anybody who holds the Studio can search and filter and make posters
 * from. Archived uploads are listed apart, and only to the person who uploaded
 * them and to whoever approves designs, who may restore them.
 */
export default async function DesignsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const [{ live, archived }, drafts, approver, config] = await Promise.all([libraryItems(), myDesignDrafts(user.id), canOpenModule(user.id, "studio.approve"), getConfig()]);
  const filter = { q: (sp.q ?? "").slice(0, 80), occasion: sp.occasion || null, language: sp.language || null, uploader: sp.uploader || null };
  const facets = libraryFacets(live);
  const shown = filterLibrary(live, filter);
  const mine = (a: { createdById: string }) => a.createdById === user.id;
  const archivedShown = filterLibrary(archived.filter((a) => approver || mine(a)), filter);
  const filtered = Boolean(filter.q || filter.occasion || filter.language || filter.uploader);
  const immediate = Boolean(config["studio.publishImmediately"]);
  return (
    <div className="mx-auto max-w-[1180px] px-6 py-6">
      <PageHeader
        title="Template library"
        subtitle={
          immediate
            ? "Every published design, to make posters from. Upload your own artwork and publish it for everybody once every check passes."
            : "Every published design, to make posters from. An upload is private to you until somebody who approves designs publishes it."
        }
      />
      <h2 className="mb-2 text-base font-semibold text-ink">Upload template</h2>
      <UploadForm />
      {drafts.length ? (
        <Card className="mt-4">
          <CardHeader title="Your uploads" />
          <ul className="divide-y divide-divider">
            {drafts.map((d) => (
              <li key={d.id} className="flex items-center gap-3 px-5 py-2.5">
                <Link href={`/studio/designs/${d.id}`} className="min-w-0 flex-1 truncate text-sm font-medium">
                  {d.name}
                </Link>
                {d.status === "approved" ? <Badge tone="success">Published {stamp(d.approvedAt)}</Badge> : <Badge tone="warn">{d.revisesId ? "New version · not published yet" : immediate ? "Draft · not published yet" : "Draft · waiting for approval"}</Badge>}
                <span className="text-[12.5px] text-muted">edited {stamp(d.updatedAt)}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <h2 className="mt-6 mb-2 text-base font-semibold text-ink">Library</h2>
      <form action="/studio/designs" className="mb-3 flex flex-wrap items-center gap-2" data-testid="library-filters">
        <Input name="q" defaultValue={filter.q} placeholder="Search by name, occasion or uploader" className="w-[280px]" />
        <Select name="occasion" defaultValue={filter.occasion ?? ""} aria-label="Occasion">
          <option value="">Every occasion</option>
          {facets.occasions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
        <Select name="language" defaultValue={filter.language ?? ""} aria-label="Language">
          <option value="">Every language</option>
          {facets.languages.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
        <Select name="uploader" defaultValue={filter.uploader ?? ""} aria-label="Uploaded by">
          <option value="">Anybody</option>
          {facets.uploaders.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
        <button type="submit" className={buttonClass({ variant: "secondary" })}>
          Filter
        </button>
        {filtered ? (
          <Link href="/studio/designs" className="text-sm">
            Clear
          </Link>
        ) : null}
      </form>
      {shown.length ? (
        <DesignGrid>
          {shown.map((d) => (
            <LibraryTile key={d.id} item={d} canManage={d.uploaderId !== null && (approver || d.uploaderId === user.id)} />
          ))}
        </DesignGrid>
      ) : (
        <EmptyState title={filtered ? "No template matches" : "No published designs yet"} body={filtered ? "Try fewer filters." : undefined} />
      )}

      {archivedShown.length ? (
        <>
          <h2 className="mt-6 mb-1 text-base font-semibold text-ink">Archived</h2>
          <p className="mb-3 text-[13px] text-muted">Not offered for new posters. Posters already made from these are unchanged.</p>
          <DesignGrid>
            {archivedShown.map((d) => (
              <LibraryTile key={`${d.id}@${d.version}`} item={d} canManage dim />
            ))}
          </DesignGrid>
        </>
      ) : null}
    </div>
  );
}
