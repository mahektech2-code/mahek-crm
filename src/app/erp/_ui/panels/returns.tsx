"use client";

import { registerPanel, type PanelProps } from "../panels";
import { Stepper } from "./parts";
import { cx } from "@/components/ui/primitives";
import { insetClass } from "../look";

/* ---------------------------------------------------------------------------
 * A material return's flow, in its record — vendor side:
 *   Purchase return → Approval → Debit note → Return outward → Confirmed
 * and customer side:
 *   Customer return → Return inward → Quarantine → Credit note → QC → Closed
 * The step and any stop (rejected, cancelled) are the server's answer.
 * ------------------------------------------------------------------------- */

type Flow = { steps: string[]; step: number; stopped: string | null };

function ReturnFlow({ data }: PanelProps) {
  const d = data as Flow;
  return (
    <section className={cx("grid gap-2", insetClass)}>
      <Stepper steps={d.steps} step={d.stopped ? -1 : d.step} label="Where this return is" />
      {d.stopped ? <div className="text-meta text-muted">{d.stopped} — kept on the record, nothing deleted.</div> : null}
    </section>
  );
}

registerPanel("returnFlow", ReturnFlow);
