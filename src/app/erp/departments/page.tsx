import Link from "next/link";
import { redirect } from "next/navigation";
import { erpContext } from "@/lib/erp/access";
import { departmentBoard, type BoardStep } from "@/lib/erp/department-board";
import { SEAT_LABEL } from "@/lib/erp/departments";
import { Badge, Card, cx, Dot } from "@/components/ui/primitives";
import { Icon } from "@/components/shell/icons";
import { CardGrid } from "@/components/ui/card-grid";
import { crmTone } from "../_ui/badge";
import { Page } from "../_ui/page-head";

/**
 * DEPARTMENTS — purchase and production, step by step, department by
 * department. Mixing & Blending asks for chemicals, tests them as they arrive
 * and makes SFG; Refilling asks for cans and fills; Packing asks for empty
 * boxes and stationery and packs; the Production Head sees all three.
 *
 * Each step is a numbered card: what the step is, the button that starts it
 * already filled in, what is waiting on it, and a way into the list it is
 * done on. The work itself happens on the ordinary screens, so every rule
 * those screens keep still applies.
 */
export default async function ErpDepartments() {
  const ctx = await erpContext();
  if (!ctx.screens.has("departments")) redirect("/erp");
  const board = await departmentBoard(ctx);
  const who = ctx.department
    ? ctx.department === "head"
      ? "You are the Production Head: every step of all three departments is yours."
      : `You work in ${SEAT_LABEL[ctx.department]}: these are your department's steps, in order.`
    : "Every production department's steps, in order. Somebody given a department's designation sees only their own.";

  return (
    <Page title="Departments" sub={`${who} Each step opens the screen it is done on, already filled in.`}>
      {board.length > 1 ? (
        <nav className="mb-4 flex flex-wrap gap-2" aria-label="Departments">
          {board.map((d) => (
            <a key={d.key} href={`#${d.key}`} className="rounded-full border border-line bg-surface px-3 py-1 text-[13px] text-body no-underline hover:border-brand hover:no-underline">
              {d.label}
            </a>
          ))}
        </nav>
      ) : null}
      <div className="flex flex-col gap-6">
        {board.map((d) => (
          <section key={d.key} id={d.key} className="scroll-mt-4">
            <h2 className="mb-2 flex items-center gap-2 text-base font-semibold text-ink">
              {d.label}
              <span className="text-[13px] font-normal text-muted">
                {d.steps.length} steps · {d.steps.map((s) => s.label).join(" → ")}
              </span>
            </h2>
            <CardGrid min={340} className="items-start">
              {d.steps.map((s) => (
                <StepCard key={s.key} step={s} />
              ))}
            </CardGrid>
          </section>
        ))}
      </div>
    </Page>
  );
}

function StepCard({ step }: { step: BoardStep }) {
  return (
    <Card className={cx("overflow-hidden", !step.open && "opacity-70")}>
      <div className="flex items-start gap-3 border-b border-divider px-5 py-3.5">
        <span className="flex size-7 flex-none items-center justify-center rounded-full bg-brand-soft text-[13px] font-semibold text-brand">{step.n}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-ink">{step.label}</span>
          <span className="mt-0.5 block text-[13px] leading-[18px] text-muted">{step.sentence}</span>
        </span>
      </div>
      {step.figures.length ? (
        <div className="grid grid-cols-2 border-b border-divider">
          {step.figures.map((f) => {
            const inner = (
              <>
                <span className="block text-[12px] text-muted">{f.l}</span>
                <span className={cx("block text-lg font-semibold tabular-nums", f.tone === "danger" ? "text-danger" : "text-ink")}>{f.v}</span>
              </>
            );
            return f.href ? (
              <Link key={f.l} href={f.href} className="border-r border-b border-divider px-5 py-2.5 no-underline even:border-r-0 hover:bg-canvas hover:no-underline">
                {inner}
              </Link>
            ) : (
              <span key={f.l} className="border-r border-b border-divider px-5 py-2.5 even:border-r-0">
                {inner}
              </span>
            );
          })}
        </div>
      ) : null}
      {step.rows.length ? (
        <div>
          {step.rows.map((r) => (
            <Link
              key={r.href}
              href={r.href}
              className="flex items-center gap-3 border-b border-divider px-5 py-2.5 no-underline last:border-0 hover:bg-canvas hover:no-underline"
            >
              <Dot tone={crmTone(r.tone)} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-ink">{r.title}</span>
                <span className="block truncate text-xs text-muted">{r.detail}</span>
              </span>
              <Badge tone={crmTone(r.tone)}>{r.tag}</Badge>
              <Icon name="chevron" size={14} className="flex-none text-line-strong" />
            </Link>
          ))}
        </div>
      ) : step.empty ? (
        <div className="px-5 py-3 text-[13px] text-muted">{step.empty}</div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 bg-canvas px-5 py-2.5">
        {step.start ? (
          <Link href={step.start.href} className="rounded-[4px] bg-brand px-3 py-1.5 text-[13px] font-medium text-white no-underline hover:no-underline hover:opacity-90">
            {step.start.label}
          </Link>
        ) : null}
        {step.open ? (
          <Link href={step.list.href} className="text-[13px]">
            Open {step.list.label}
          </Link>
        ) : (
          <span className="text-[13px] text-muted">{step.list.label} is not on your account</span>
        )}
      </div>
    </Card>
  );
}
