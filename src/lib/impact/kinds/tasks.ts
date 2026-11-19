import "server-only";
import { requireUser } from "@/lib/auth";
import { taskDetail } from "@/lib/tasks/service";
import type { ImpactItem } from "../types";
import type { ImpactSource } from "../registry";

/* ---------------------------------------------------------------------------
 * A TASK DELETED is gone with its whole Activity tab — every note, every
 * hand-over asked for — and the person holding it is told it was taken back.
 * It used to go on one click of a text link at the foot of the record.
 *
 * Who may see the report is who may see the task; the act still asks
 * `can.delete` (the giver, and not once somebody else closed it).
 * ------------------------------------------------------------------------- */

const typeable = (name: string, verb: string) => (name.trim() && name.length <= 40 ? name : verb);

export const taskDeleteImpact: ImpactSource = {
  async authorize(id) {
    const user = await requireUser();
    if (!(await taskDetail(user, id))) throw new Error("You can't see this task.");
  },

  async report(id) {
    const user = await requireUser();
    const d = await taskDetail(user, id);
    if (!d) return null;
    const t = d.task;
    const notes = d.events.filter((e) => e.body && e.kind === "note").length;
    const items: ImpactItem[] = [
      { app: "Tasks", label: "task", effect: "deleted", count: 1, examples: [t.title] },
      { app: "Tasks", label: notes === 1 ? "note on it" : "notes on it", effect: "deleted", count: notes },
      { app: "Tasks", label: "entries in its Activity tab", effect: "deleted", count: d.events.length },
      {
        app: "Tasks",
        label: d.proofs.length === 1 ? "proof attached to it" : "proofs attached to it",
        effect: "unlinked",
        count: d.proofs.length,
        note: "The files stay in storage but nothing will show them any more.",
      },
      {
        app: "Tasks",
        label: "hand-over waiting for an answer",
        effect: "deleted",
        count: t.transfer ? 1 : 0,
      },
    ];
    if (t.assigneeId !== user.id && t.status !== "done") {
      items.push({
        app: "Tasks",
        label: "notification",
        effect: "changed",
        count: 1,
        note: `${t.assigneeName} is told you took the task back.`,
      });
    }
    if (d.origin.repeats) {
      items.push({
        app: "Tasks",
        label: "routine it came from",
        effect: "kept",
        count: 1,
        note: `It keeps running (${d.origin.repeats}) and will raise the next one as usual.`,
      });
    }
    const blockers = d.can.delete ? [] : ["Only the person who gave a task can delete it, and not once somebody else has closed it."];
    return { title: t.title, verb: "Delete", confirmWord: typeable(t.title, "DELETE"), items, blockers };
  },
};
