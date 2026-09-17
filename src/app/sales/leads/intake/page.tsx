import { requireUser } from "@/lib/auth";
import { getConfig } from "@/lib/config/store";
import { today } from "@/lib/recompute";
import { canLead } from "@/lib/services/lead-console-service";
import {
  leadSourceOptions,
  nextActionOwners,
} from "@/lib/services/lead-intake-service";
import { LeadTabs } from "../lead-tabs";
import { IntakeForm } from "./intake-form";

export const metadata = { title: "Capture a lead — Sales Dashboard — MahekOne" };

/**
 * Screen 5 — the office's own lead-raising form.
 *
 * Every other way a lead reaches MahekOne has somebody standing in a shop or a
 * spreadsheet behind it. This is the telephone call: a shop rings, or a website
 * form arrives in somebody's inbox, and until this existed the only places to
 * put it were a notebook and a colleague's memory.
 *
 * **The module is guarded by the folder's layout**, which is the pattern
 * everywhere under `/sales/leads` except the book itself — nine separately
 * grantable modules live under one path, so a guard on the parent would refuse
 * somebody holding Intake on the strength of a module they were deliberately
 * not given.
 *
 * Three things are read, and each of them is a real answer rather than a list
 * typed into a screen: the sources already in use (so screen 6 does not inherit
 * a fourth spelling of "Website"), who a next action may be owed by, and
 * whether `leads.requireNextAction` is in force. The day comes from the server
 * because the React Compiler rules forbid reading the clock during a render,
 * and a default date computed in a browser is the browser's idea of today.
 */
export default async function Page() {
  const user = await requireUser();

  const [sources, owners, config, day, canWork] = await Promise.all([
    leadSourceOptions(),
    nextActionOwners(),
    getConfig(),
    today(),
    canLead(user, "lead.work"),
  ]);

  return (
    <div className="p-6">
      <LeadTabs />
      <IntakeForm
        sources={sources}
        owners={owners}
        today={day}
        requireNextAction={config["leads.requireNextAction"]}
        canWork={canWork}
      />
    </div>
  );
}
