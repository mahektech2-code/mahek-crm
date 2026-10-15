"use client";

import { SectionLabel } from "@/components/ui/primitives";
import { registerPanel, type PanelProps } from "../panels";

/* ---------------------------------------------------------------------------
 * A can's photos and its group's, and a group's photos and its cans', in the
 * record drawer. A can is recognised by looking at it, so the drawer shows the
 * pictures rather than a count of them.
 * ------------------------------------------------------------------------- */

function Strip({ photos, alt, max, empty }: { photos: string[]; alt: string; max?: number; empty: string }) {
  if (!photos.length) return <span className="text-xs text-muted">{empty}</span>;
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2">
      {photos.map((src, i) => (
        <a key={src} href={src} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-control border border-divider bg-canvas">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt={`${alt} ${i + 1}`} className="block aspect-square w-full object-cover" loading="lazy" />
        </a>
      ))}
      {max && photos.length < max ? (
        <span className="flex aspect-square items-center justify-center rounded-control border border-dashed border-line px-2 text-center text-xs text-muted">
          {max - photos.length} more can be added
        </span>
      ) : null}
    </div>
  );
}

type CanData = { photos: string[]; max: number; group: { name: string; photos: string[] } | null };

function CanPhotos({ data, row }: PanelProps) {
  const d = data as CanData;
  return (
    <section className="grid gap-3 rounded-card border border-line p-3.5">
      <div className="grid gap-2">
        <SectionLabel>Photos of this can</SectionLabel>
        <Strip photos={d.photos} alt={row.title ?? "Can"} max={d.max} empty="No photo yet — Photos adds up to three." />
      </div>
      <div className="grid gap-2">
        <SectionLabel>{d.group ? `Group · ${d.group.name}` : "Group"}</SectionLabel>
        {d.group ? (
          <Strip photos={d.group.photos} alt={d.group.name} empty="The group has no photo yet." />
        ) : (
          <span className="text-xs text-muted">Not in a group. Pick one on Edit, or use Can groups → Group cans by name.</span>
        )}
      </div>
    </section>
  );
}

type GroupData = { photos: string[]; max: number; members: { name: string; active: boolean; photos: string[] }[] };

function CanGroup({ data, row }: PanelProps) {
  const d = data as GroupData;
  return (
    <section className="grid gap-3 rounded-card border border-line p-3.5">
      <div className="grid gap-2">
        <SectionLabel>Group photos</SectionLabel>
        <Strip photos={d.photos} alt={row.title ?? "Group"} max={d.max} empty="No group photo yet — Edit group adds up to three." />
      </div>
      <div className="grid gap-2">
        <SectionLabel>{`Cans in this group · ${d.members.length}`}</SectionLabel>
        {d.members.length ? (
          <ul className="grid gap-2.5">
            {d.members.map((m) => (
              <li key={m.name} className="grid gap-1.5">
                <span className="text-sm font-semibold text-ink">
                  {m.name}
                  {m.active ? null : <span className="ml-1.5 text-xs font-normal text-muted">retired</span>}
                </span>
                <Strip photos={m.photos} alt={m.name} empty="No photo of this can." />
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-xs text-muted">No cans yet — Edit group ticks them.</span>
        )}
      </div>
    </section>
  );
}

registerPanel("canPhotos", CanPhotos);
registerPanel("canGroup", CanGroup);
