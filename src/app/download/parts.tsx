import type { DownloadApp } from "./apps";

/** The app's own mark: MBOS a map pin, the factory a box. */
export function AppTile({
  app,
  size,
}: {
  app: DownloadApp;
  size: "md" | "lg";
}) {
  const box =
    size === "lg" ? "h-14 w-14 rounded-[12px]" : "h-12 w-12 rounded-[10px]";
  const icon = size === "lg" ? "h-7 w-7" : "h-6 w-6";
  return (
    <span
      className={`flex flex-none items-center justify-center bg-brand-lime text-brand-deep ${box}`}
    >
      <svg
        aria-hidden
        viewBox="0 0 24 24"
        className={icon}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {app.id === "mbos" ? (
          <>
            <path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21Z" />
            <circle cx="12" cy="9.5" r="2.5" />
          </>
        ) : (
          <>
            <path d="M3 8 12 3l9 5v8l-9 5-9-5V8Z" />
            <path d="m3 8 9 5 9-5M12 13v8" />
          </>
        )}
      </svg>
    </span>
  );
}

export function Wordmark() {
  return (
    <span className="flex items-center gap-2.5">
      <span className="flex h-5.5 w-5.5 flex-none items-center justify-center rounded-[4px] bg-brand-lime">
        <span className="block h-2 w-2 rounded-[2px] bg-brand-deep" />
      </span>
      <span className="text-base font-semibold tracking-[-0.01em] text-white">
        MAHEK<span className="text-brand-lime">ONE</span>
      </span>
    </span>
  );
}
