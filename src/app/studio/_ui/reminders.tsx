"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Badge, Button } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { dismissReminder, markRemindersRead } from "@/lib/actions/studio";

export type ReminderView = { key: string; kind: "festival" | "birthday" | "anniversary"; title: string; date: string; dateLabel: string; daysUntil: number; unread: boolean; hasDesign: boolean; href: string | null };

const KIND: Record<ReminderView["kind"], string> = { festival: "Festival", birthday: "Birthday", anniversary: "Anniversary" };
const when = (d: number) => (d === 0 ? "Today" : d === 1 ? "Tomorrow" : `In ${d} days`);

/** What is coming up. Seeing the list marks it read; dismissing takes one off until next year. */
export function RemindersList({ items }: { items: ReminderView[] }) {
  const router = useRouter();
  const toast = useToast();
  const unread = items.filter((r) => r.unread).map((r) => ({ key: r.key, date: r.date }));
  useEffect(() => {
    if (unread.length) void markRemindersRead(unread);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per list as rendered
  }, []);
  if (!items.length) return <p className="px-5 py-4 text-sm text-muted">Nothing coming up in the next week.</p>;
  return (
    <ul className="divide-y divide-divider">
      {items.map((r) => (
        <li key={r.key} className="flex items-center gap-3 px-5 py-3">
          <div className="w-[88px] flex-none">
            <div className="text-sm font-semibold text-ink">{when(r.daysUntil)}</div>
            <div className="text-[12px] text-muted">{r.dateLabel}</div>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium text-ink">{r.title}</span>
              {r.unread ? <Badge tone="brand">New</Badge> : null}
            </div>
            <div className="text-[12.5px] text-muted">{KIND[r.kind]}{r.hasDesign ? "" : " · no design for it yet"}</div>
          </div>
          {r.href ? (
            <Link href={r.href} className="text-sm font-medium">
              Make posters
            </Link>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              const res = await toast.run(dismissReminder(r.key, r.date));
              if (res.ok) router.refresh();
            }}
          >
            Dismiss
          </Button>
        </li>
      ))}
    </ul>
  );
}
