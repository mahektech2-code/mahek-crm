import Link from "next/link";
import { Badge, cx } from "@/components/ui/primitives";
import type { DesignCard } from "@/lib/studio/service";

/* ---------------------------------------------------------------------------
 * The Studio's small pieces, drawn the same on every screen: a design as a
 * card with its preview, an occasion chip, and the tabs over the three lists.
 * Server-renderable — nothing here holds state.
 * ------------------------------------------------------------------------- */

export function OccasionChip({ label, color }: { label: string; color: string | null }) {
  return (
    <span className="inline-flex h-5 items-center gap-1.5 rounded-[5px] bg-divider px-1.5 text-[11.5px] font-semibold whitespace-nowrap text-body">
      <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: color ?? "var(--color-line-strong)" }} />
      {label}
    </span>
  );
}

export function DesignTile({ design, href, note, dim = false }: { design: DesignCard; href?: string; note?: string | null; dim?: boolean }) {
  const body = (
    <>
      <div className="relative overflow-hidden rounded-t-card border-b border-divider bg-canvas" style={{ aspectRatio: "1 / 1" }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- a stored preview, served from our own route */}
        <img src={design.preview} alt={`Preview of ${design.name}`} loading="lazy" className={cx("h-full w-full object-contain", dim ? "opacity-50" : null)} />
      </div>
      <div className="flex flex-col gap-1.5 px-3 py-2.5">
        <div className="flex items-start justify-between gap-2">
          <span className="text-sm leading-5 font-semibold text-ink">{design.name}</span>
          {design.custom ? <Badge tone="brand">Uploaded</Badge> : null}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <OccasionChip label={design.occasionLabel} color={design.occasionColor} />
          <span className="text-[12px] text-muted">{design.languages.map((l) => l.label).join(" · ")}</span>
        </div>
        {note ? <span className="text-[12.5px] text-warn-ink">{note}</span> : null}
      </div>
    </>
  );
  return href ? (
    <Link href={href} className="block rounded-card border border-line bg-surface no-underline transition-shadow hover:no-underline hover:shadow-md">
      {body}
    </Link>
  ) : (
    <div className="rounded-card border border-line bg-surface">{body}</div>
  );
}

export function DesignGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">{children}</div>;
}

export function Tabs({ items }: { items: { href: string; label: string; count?: number; active: boolean }[] }) {
  return (
    <div className="mb-3 flex flex-wrap gap-1 border-b border-line" role="tablist">
      {items.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          role="tab"
          aria-selected={t.active}
          className={cx(
            "-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm no-underline hover:no-underline",
            t.active ? "border-brand font-semibold text-ink" : "border-transparent text-muted hover:text-ink",
          )}
        >
          {t.label}
          {t.count !== undefined ? <span className="text-[12px] text-faint">{t.count}</span> : null}
        </Link>
      ))}
    </div>
  );
}

export function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}
