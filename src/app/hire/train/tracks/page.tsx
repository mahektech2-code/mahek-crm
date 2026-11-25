import type { Metadata } from "next";
import Link from "next/link";
import { cx } from "@/components/ui/primitives";
import { requireHireScreen } from "@/lib/hire/access";
import { lockedWhy } from "@/lib/hire/roles";
import { listModules, listTracks } from "@/lib/training/service";
import { Empty, PageHead, Pill } from "../../_ui/kit";
import { NewTrack, TrackEditor } from "./track-editor";

export const metadata: Metadata = { title: "Tracks" };
export const dynamic = "force-dynamic";

/** The order a designation's modules unlock in. A blueprint names its track; the person is enrolled when their account is made. */
export default async function TracksPage({ searchParams }: { searchParams: Promise<{ track?: string }> }) {
  const ctx = await requireHireScreen("tracks");
  const sp = await searchParams;
  const [tracks, mods] = await Promise.all([listTracks(), listModules()]);
  const selected = tracks.find((t) => t.id === sp.track) ?? tracks[0] ?? null;
  const editing = selected ? (selected.draft ?? selected.published) : null;
  const modules = mods.map((m) => ({ key: m.key, title: m.title, category: m.category, published: Boolean(m.published), passMark: m.published?.definition.passMarkPercent ?? null }));
  const canAuthor = ctx.can("trainingAuthor");
  return (
    <>
      <PageHead title="Tracks" sub="The modules a designation must pass, in the order they unlock. A blueprint names its track; the person is enrolled on its published version when their account is created." />
      <div className="grid grid-cols-[300px_minmax(0,1fr)] items-start gap-5">
        <div className="flex flex-col gap-4">
          <div className="overflow-hidden rounded-[6px] border border-line bg-surface">
            <div className="border-b border-divider px-3.5 py-2.5 text-xs font-medium tracking-[0.04em] text-muted uppercase">Tracks · {tracks.length}</div>
            {!tracks.length ? <div className="px-3.5 py-4 text-[13px] text-muted">None yet.</div> : null}
            {tracks.map((t) => (
              <Link
                key={t.id}
                href={`/hire/train/tracks?track=${t.id}`}
                scroll={false}
                className={cx("flex items-center gap-2.5 border-t border-canvas px-3.5 py-3 no-underline first:border-t-0 hover:bg-canvas hover:no-underline", selected?.id === t.id ? "bg-brand-soft shadow-[inset_3px_0_0_var(--color-brand)]" : "")}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-heading">{t.title}</span>
                  <span className="block truncate text-xs text-muted">
                    {t.published ? `v${t.published.version} · ${t.published.definition.items.length} modules` : "not published"} · {t.enrolled} enrolled
                  </span>
                </span>
                {t.draft && !t.published ? <Pill tone="neutral">Draft</Pill> : t.draft ? <Pill tone="warn">Draft v{t.draft.version}</Pill> : <Pill tone="success">Published</Pill>}
              </Link>
            ))}
          </div>
          {canAuthor ? <NewTrack /> : null}
        </div>
        <div className="min-w-0">
          {selected && editing ? (
            <TrackEditor
              key={`${editing.id}:${editing.updatedAt.toISOString()}`}
              track={{ id: selected.id, key: selected.key, title: selected.title, enrolled: selected.enrolled, publishedVersion: selected.published?.version ?? null }}
              editing={{ version: editing.version, status: editing.status, definition: editing.definition }}
              modules={modules}
              canAuthor={canAuthor}
              lockedWhy={lockedWhy("trainingAuthor")}
            />
          ) : (
            <Empty title="No track picked">{tracks.length ? "Choose one on the left." : "Create the first track — then name it in a blueprint’s Training section."}</Empty>
          )}
        </div>
      </div>
    </>
  );
}
