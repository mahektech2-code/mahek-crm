import { Button, cx, Input, PageHeader } from "@/components/ui/primitives";

/* A page that is not a list: the CRM's page padding and header. There is no
   crumb above the title — the CRM draws none, and the sidebar already says
   where you are. */
export function Page({ title, sub, actions, children }: { title: string; sub?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="px-6 pt-6 pb-10">
      <PageHeader title={title} subtitle={sub} actions={actions} />
      {children}
    </div>
  );
}

/**
 * The "type or scan a code, press Go" box at the top of Trace and the Dispatch
 * desk: a plain GET form, so a barcode scanner's Enter works with no script.
 * One component, so the two pages cannot drift into two heights and two blues.
 */
export function QuickFind({
  action,
  name,
  defaultValue,
  placeholder,
  button,
  mono = false,
  inputMode,
  className,
  children,
}: {
  action: string;
  name: string;
  defaultValue?: string;
  placeholder: string;
  button: string;
  mono?: boolean;
  inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <form action={action} method="get" className={cx("mb-5 flex gap-2", className)}>
      <Input name={name} defaultValue={defaultValue} autoFocus inputMode={inputMode} placeholder={placeholder} aria-label={placeholder} className={cx("h-9 min-w-0 flex-1", mono && "font-mono")} />
      <Button type="submit" variant="primary">
        {button}
      </Button>
      {children}
    </form>
  );
}

/** The small text links in a page header's corner — "← Queue · Labels · Trace". */
export function PageLinks({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center gap-3 text-meta">{children}</div>;
}
