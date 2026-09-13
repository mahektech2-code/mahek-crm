/* ---------------------------------------------------------------------------
 * WHAT A SCREEN LOOKS LIKE BEFORE ITS DATA ARRIVES.
 *
 * These are what `loading.tsx` renders, and their whole job is to let a
 * navigation COMMIT. Without a loading boundary Next has nothing to show for a
 * dynamic route, so the browser holds the previous page — same pixels, same
 * URL, no cursor change — until the entire payload lands. With one, the URL
 * changes, the sidebar highlight moves and this paints, all inside a frame.
 *
 * THEY ARE SHAPES, NOT SPINNERS. A spinner says "something is happening"; a
 * skeleton in the shape of the screen you asked for says "you are on the
 * customers list and the rows are coming", which is the thing a telecaller
 * mid-call actually needs to know. It also stops the layout jumping when the
 * real content replaces it, because the furniture is already in the right
 * places.
 *
 * NO DATA, NO NUMBERS, NO INVENTED ROWS. A skeleton that showed plausible
 * figures would be a screen telling somebody something untrue for a second and
 * a half. Everything here is a grey block.
 *
 * Deliberately a server component with no client JavaScript: it must be able
 * to paint before anything hydrates.
 * ------------------------------------------------------------------------- */

/** One shimmering grey block. `w` and `h` are Tailwind classes. */
function Bar({ className = "" }: { className?: string }) {
  return (
    <span
      className={`block animate-pulse rounded-[3px] bg-divider ${className}`}
    />
  );
}

/** The title row every screen in both apps opens with. */
function HeaderBlock() {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex flex-col gap-2">
        <Bar className="h-6 w-52" />
        <Bar className="h-3.5 w-72 max-w-full" />
      </div>
      <Bar className="h-8 w-32" />
    </div>
  );
}

/**
 * A list screen: the calling queue, customers, bills, reminders, complaints.
 * Eight rows, because that is roughly a screenful and a skeleton longer than
 * the viewport is just paint nobody sees.
 */
export function ListSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-5 p-6" aria-hidden="true">
      <HeaderBlock />
      <div className="flex flex-wrap gap-2">
        <Bar className="h-8 w-28" />
        <Bar className="h-8 w-24" />
        <Bar className="h-8 w-32" />
      </div>
      <div className="overflow-hidden rounded-[6px] border border-line bg-surface">
        <div className="border-b border-divider px-4 py-3">
          <Bar className="h-3.5 w-40" />
        </div>
        {Array.from({ length: rows }, (_, i) => (
          <div
            key={i}
            className="flex items-center gap-4 border-b border-divider px-4 py-3.5 last:border-b-0"
          >
            <Bar className="h-8 w-8 flex-none rounded-full" />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Bar className="h-3.5 w-[42%] min-w-24" />
              <Bar className="h-3 w-[26%] min-w-16" />
            </div>
            <Bar className="hidden h-3.5 w-20 flex-none sm:block" />
            <Bar className="h-3.5 w-16 flex-none" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * A dashboard: a strip of figures over panels. Used by the CRM dashboard and
 * the Manager Console's Today.
 */
export function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-5 p-6" aria-hidden="true">
      <HeaderBlock />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div
            key={i}
            className="flex flex-col gap-2.5 rounded-[6px] border border-line bg-surface p-4"
          >
            <Bar className="h-3 w-20" />
            <Bar className="h-7 w-24" />
            <Bar className="h-3 w-28" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-3 rounded-[6px] border border-line bg-surface p-4 lg:col-span-2">
          <Bar className="h-4 w-44" />
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="flex items-center gap-3">
              <Bar className="h-8 w-8 flex-none rounded-full" />
              <Bar className="h-3.5 flex-1" />
              <Bar className="h-3.5 w-14 flex-none" />
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-3 rounded-[6px] border border-line bg-surface p-4">
          <Bar className="h-4 w-32" />
          {Array.from({ length: 5 }, (_, i) => (
            <Bar key={i} className="h-3.5 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}

/** A record: the customer page, a lead, a person. Panels down a column. */
export function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-5 p-6" aria-hidden="true">
      <HeaderBlock />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          {Array.from({ length: 2 }, (_, i) => (
            <div
              key={i}
              className="flex flex-col gap-3 rounded-[6px] border border-line bg-surface p-4"
            >
              <Bar className="h-4 w-36" />
              {Array.from({ length: 4 }, (_, j) => (
                <Bar key={j} className="h-3.5 w-full" />
              ))}
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-3 rounded-[6px] border border-line bg-surface p-4">
          <Bar className="h-4 w-28" />
          {Array.from({ length: 7 }, (_, i) => (
            <Bar key={i} className="h-3.5 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}
