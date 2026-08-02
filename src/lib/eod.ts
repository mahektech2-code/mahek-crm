import { longDate, money } from "./format";
import type { DayActivity } from "./queries";

/**
 * The EOD text is pasted straight into the team WhatsApp group, so asterisks
 * are deliberate — that is what makes a line bold there.
 */
export function eodMessage(
  name: string,
  day: string,
  a: DayActivity,
  openReminders: number,
): string {
  return [
    `*EOD — ${name}*`,
    longDate(day),
    "",
    `Queue worked: ${a.queueWorked}/${a.queueTotal}`,
    `Calls attempted: ${a.attempted}`,
    `Connected: ${a.connected} (${a.connectRate}%)`,
    `Missed / not reachable: ${a.missed}`,
    "",
    `*Orders: ${a.orders} — ${money(a.orderValue)}*`,
    `Collected today: ${money(a.collected)}`,
    "",
    `Reminders set: ${a.remindersSet}`,
    `Reminders closed: ${a.remindersClosed}`,
    `Still open: ${openReminders}`,
    `Complaints logged: ${a.complaintsLogged}`,
    `WhatsApp messages sent: ${a.messagesSent}`,
  ].join("\n");
}

export function eodLines(a: DayActivity, openReminders: number) {
  return [
    { k: "Queue worked", v: `${a.queueWorked} of ${a.queueTotal}` },
    { k: "Calls attempted", v: String(a.attempted) },
    { k: "Connected", v: `${a.connected} (${a.connectRate}%)` },
    { k: "Missed / not reachable", v: String(a.missed) },
    { k: "Orders taken", v: String(a.orders) },
    { k: "Order value", v: money(a.orderValue) },
    { k: "Payments collected", v: money(a.collected) },
    { k: "Reminders set", v: String(a.remindersSet) },
    { k: "Reminders closed", v: String(a.remindersClosed) },
    { k: "Reminders still open", v: String(openReminders) },
    { k: "Complaints logged", v: String(a.complaintsLogged) },
    { k: "WhatsApp messages sent", v: String(a.messagesSent) },
  ];
}
