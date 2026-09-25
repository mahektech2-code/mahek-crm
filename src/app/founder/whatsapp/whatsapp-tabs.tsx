import Link from "next/link";
import { cx } from "@/components/ui/primitives";

/** Setup (the switch, templates, connection), Automation (the rules), Messages (the tracker). */
export function WhatsappTabs({ current }: { current: "setup" | "automation" | "messages" }) {
  const tabs = [
    { key: "setup", href: "/founder/whatsapp", label: "Setup" },
    { key: "automation", href: "/founder/whatsapp/automation", label: "Automation" },
    { key: "messages", href: "/founder/whatsapp/messages", label: "Messages" },
  ] as const;
  return (
    <div className="mb-4 flex items-center border-b border-line">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          className={cx(
            "-mb-px border-b-2 px-4 py-2.5 text-sm whitespace-nowrap no-underline hover:no-underline",
            current === t.key ? "border-brand font-medium text-ink" : "border-transparent text-muted hover:text-body",
          )}
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}
