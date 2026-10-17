/**
 * WHAT AN OUTBOX ROW IS, IN WORDS — one list for both screens that draw one.
 *
 * The Sync screen and the Not accepted screen each kept their own map, and
 * between them they named fourteen of the twenty-four things this phone sends.
 * The rest printed the wire's own spelling — `plan_stops`, `expense_day_submit`,
 * `lead_validation` — on the two screens a salesman opens precisely because
 * something is wrong. Pure, so a test can hold it to the entity types the app
 * actually writes.
 */

export const ENTITY_LABEL: Record<string, string> = {
  visit: 'Visit',
  order: 'Order',
  order_change_request: 'Order change request',
  payment: 'Payment',
  attendance: 'Punch in or out',
  task: 'Task',
  sample: 'Sample request',
  complaint: 'Complaint',
  expense: 'Expense claim',
  expense_day: 'Day of travel',
  expense_day_submit: 'Day sent for payment',
  travel_leg: 'Journey',
  leave: 'Leave request',
  tour: 'Tour request',
  lead: 'Lead',
  lead_validation: 'Lead check call',
  lead_communication: 'Message to a lead',
  internal_note: 'Note for the office',
  approval: 'Request for approval',
  competitor: 'Other brand note',
  customer: 'New shop',
  plan_day: 'Day plan',
  plan_stops: 'Shops for the day',
  territory_request: 'Area request',
};

export function entityLabel(entityType: string): string {
  return ENTITY_LABEL[entityType] ?? 'Entry';
}

/** The payload as an object, never a throw — a render must not die on one row. */
export function readPayload<T extends object = Record<string, unknown>>(raw: string): Partial<T> {
  try {
    const p: unknown = JSON.parse(raw);
    return p && typeof p === 'object' ? (p as Partial<T>) : {};
  } catch {
    return {};
  }
}

/** The one line that tells two rows of the same kind apart. */
export function describePayload(raw: string, entityId: string): string {
  const p = readPayload<{ customerName?: string; title?: string; reason?: string; name?: string }>(raw);
  return p.customerName ?? p.title ?? p.name ?? p.reason ?? entityId.slice(-6).toUpperCase();
}
