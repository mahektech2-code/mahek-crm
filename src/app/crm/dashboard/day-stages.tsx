"use client";

import Link from "next/link";
import { Card, cx } from "@/components/ui/primitives";

/**
 * The shape of a telecaller's day, left to right. A stage is done when there is
 * nothing left in it — so the marks are derived, never set by hand.
 */
export function DayStages({
  worked,
  total,
  dueReminders,
  followUps,
  complaints,
}: {
  worked: number;
  total: number;
  dueReminders: number;
  followUps: number;
  complaints: number;
}) {
  const stages = [
    {
      href: "/crm/call-log",
      label: "Work the queue",
      done: total > 0 && worked >= total,
      active: total > 0 && worked < total,
      count: total - worked,
    },
    {
      href: "/crm/reminders",
      label: "Close reminders",
      done: dueReminders === 0,
      active: dueReminders > 0,
      count: dueReminders,
    },
    {
      href: "/crm/payments",
      label: "Chase payments",
      done: followUps === 0,
      active: followUps > 0,
      count: followUps,
    },
    {
      href: "/crm/complaints",
      label: "Clear complaints",
      done: complaints === 0,
      active: complaints > 0,
      count: complaints,
    },
    {
      href: "/crm/eod",
      label: "Submit EOD",
      done: false,
      active: dueReminders === 0 && total > 0 && worked >= total,
      count: 0,
    },
  ];

  return (
    <Card className="mb-4 flex items-center px-5 py-3.5">
      {stages.map((s, i) => (
        <Link
          key={s.href}
          href={s.href}
          className="flex flex-1 items-center gap-2.5 no-underline hover:no-underline"
        >
          <span
            className={cx(
              "flex h-5 w-5 flex-none items-center justify-center rounded-full text-[11px] font-medium",
              s.done
                ? "bg-success text-white"
                : s.active
                  ? "bg-brand text-white"
                  : "bg-divider text-muted",
            )}
          >
            {s.done ? "✓" : i + 1}
          </span>
          <span
            className={cx(
              "text-sm whitespace-nowrap",
              s.active ? "font-medium text-ink" : "text-muted",
            )}
          >
            {s.label}
            {s.count > 0 ? (
              <span className="ml-1.5 text-muted">{s.count}</span>
            ) : null}
          </span>
          {i < stages.length - 1 ? (
            <span
              className={cx(
                "mx-2 h-px flex-1",
                s.done ? "bg-success/40" : "bg-divider",
              )}
            />
          ) : null}
        </Link>
      ))}
    </Card>
  );
}
