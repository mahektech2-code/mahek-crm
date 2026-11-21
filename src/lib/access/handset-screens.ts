import type { ModuleShape } from "./permission-rules";

/* ---------------------------------------------------------------------------
 * THE SALESMAN APP'S SCREENS, AS THE HANDSET'S OWN MENU DRAWS THEM.
 *
 * The web registry (`lib/modules.ts`) knows the Salesman App as one module,
 * `field.home`, because it opens no browser tab. But the screen model gives a
 * permission to a screen, and one screen would hand every field manager's
 * decision to anybody with Edit on the app. So the handset's own menu —
 * `mbos-app/app/more.tsx`, its Work, My days & pay and Resources sections, in
 * its order and its words — is the Salesman App's sidebar here. Settings
 * (profile, sending to the office, phone setup) is not listed: a handset that
 * could not sync or sign out would not work at all.
 *
 * Keys are `field.<route>` — the handset's route name — so the handset can
 * check a screen by the name it already navigates by.
 * ------------------------------------------------------------------------- */

export const HANDSET_SHAPE: ModuleShape[] = [
  {
    module: "Work",
    screens: [
      "field.nearby",
      "field.tasks",
      "field.leads",
      "field.lead-actions",
      "field.orders",
      "field.collections",
      "field.accounts",
      "field.samples",
      "field.reports",
    ],
  },
  {
    module: "My days & pay",
    screens: [
      "field.attendance",
      "field.leave",
      "field.holidays",
      "field.salary",
      "field.travel",
      "field.expenses",
      "field.policy",
      "field.performance",
    ],
  },
  { module: "Resources", screens: ["field.catalogue", "field.docs", "field.maps"] },
];

/** The words the handset's menu uses for each screen. */
export const HANDSET_LABELS: Record<string, string> = {
  "field.nearby": "Near me",
  "field.tasks": "Tasks",
  "field.leads": "Leads",
  "field.lead-actions": "Pending actions",
  "field.orders": "Orders",
  "field.collections": "Payments",
  "field.accounts": "Customer accounts",
  "field.samples": "Samples",
  "field.reports": "Reports",
  "field.attendance": "Attendance",
  "field.leave": "Leave",
  "field.holidays": "Holidays",
  "field.salary": "Salary",
  "field.travel": "Today’s travel",
  "field.expenses": "Expenses",
  "field.policy": "What you are allowed",
  "field.performance": "Performance",
  "field.catalogue": "Product catalogue",
  "field.docs": "Documents",
  "field.maps": "Offline maps",
};
