import { cx } from "@/components/ui/primitives";
import type { AppDefinition } from "@/lib/apps";

/** The two-letter square that identifies an app in lists and on cards. */
export function AppChip({
  app,
  className,
}: {
  app: Pick<AppDefinition, "initials" | "tone">;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "flex h-7 w-7 flex-none items-center justify-center rounded-[4px] text-[11px] font-semibold tracking-[0.02em]",
        app.tone === "primary" ? "bg-brand text-white" : "bg-divider text-body",
        className,
      )}
      aria-hidden
    >
      {app.initials}
    </span>
  );
}
