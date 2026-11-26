/**
 * WHO MAY CHANGE A FIELD TASK FROM A HANDSET, AND WHEN — pure, so the rule is
 * tested rather than trusted (`task-update-rules.test.ts`).
 *
 * `handleTaskUpdate` looked a task up by id and wrote whatever arrived, so any
 * signed-in handset could close any task whose id it held, and a task the
 * office had CANCELLED could be closed as done from a phone that had not heard
 * yet — the cancellation silently undone by a tick.
 *
 * The person it is for may work it; so may whoever gave it. Nobody else. A
 * cancelled task is finished business; a done one is too, except that being
 * told "done" again is the same news and is accepted without writing (a resend
 * whose first answer was lost on 2G must not come back as a refusal).
 */

export type TaskUpdateVerdict =
  | { kind: "apply" }
  | { kind: "already" }
  | { kind: "refuse"; code: "not_permitted" | "validation"; message: string };

export function taskUpdateVerdict(args: {
  senderId: string;
  assigneeId: string | null;
  assignerId: string | null;
  status: string;
  title: string;
  /** The status the handset sent, where it sent one. */
  incomingStatus?: string | null;
}): TaskUpdateVerdict {
  const mine = args.senderId === args.assigneeId || (args.assignerId != null && args.senderId === args.assignerId);
  if (!mine) {
    return {
      kind: "refuse",
      code: "not_permitted",
      message: `"${args.title}" is not your task any more, so it cannot be changed from this phone. Ask your manager.`,
    };
  }
  if (args.status === "cancelled") {
    return {
      kind: "refuse",
      code: "validation",
      message: `"${args.title}" was cancelled by the office, so it cannot be closed or changed. You can remove it from this phone.`,
    };
  }
  if (args.status === "done") {
    if (args.incomingStatus === "done") return { kind: "already" };
    return {
      kind: "refuse",
      code: "validation",
      message: `"${args.title}" is already closed, so it cannot be changed from this phone.`,
    };
  }
  return { kind: "apply" };
}
