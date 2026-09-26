/** Shown while a screen's server reads run — the counts are real queries and take a moment on a large book. */
export default function Loading() {
  return (
    <div className="p-6" aria-busy="true" aria-live="polite">
      <div className="h-5 w-40 animate-pulse rounded bg-line" />
      <div className="mt-3 h-8 w-72 animate-pulse rounded bg-line" />
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 10 }, (_, i) => (
          <div key={i} className="h-20 animate-pulse rounded-[6px] bg-line/60" />
        ))}
      </div>
      <p className="mt-6 text-sm text-muted">Loading…</p>
    </div>
  );
}
