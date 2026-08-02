import { cx } from "@/components/ui/primitives";

/**
 * MAHEK**ONE** — the suite mark. Inside an app the wordmark becomes the app's
 * own ("MAHEK CRM"), so people always know which tool they are looking at.
 */
export function Wordmark({
  size = "md",
  label,
}: {
  size?: "sm" | "md" | "lg";
  label?: string;
}) {
  const box = size === "lg" ? "h-5.5 w-5.5" : "h-4 w-4";
  const dot = size === "lg" ? "h-2 w-2" : "h-1.5 w-1.5";
  const text =
    size === "lg" ? "text-lg" : size === "md" ? "text-[15px]" : "text-sm";

  return (
    <span className="flex items-center gap-2.5">
      <span
        className={cx(
          "flex flex-none items-center justify-center rounded-[4px] bg-brand",
          box,
        )}
      >
        <span className={cx("block rounded-[2px] bg-brand-lime", dot)} />
      </span>
      <span
        className={cx(
          "font-semibold tracking-[-0.01em] whitespace-nowrap text-ink",
          text,
        )}
      >
        {label ?? (
          <>
            MAHEK<span className="text-brand">ONE</span>
          </>
        )}
      </span>
    </span>
  );
}
