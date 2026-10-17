import type { ReactNode } from "react";
import { BtnLink, Empty, PageHead } from "../_ui/kit";
import { ListPane, type PaneRow } from "./list-pane";

/** Every onboarding screen: a title, the list of who is at this point, and one candidate's panel. */
export function OnboardFrame({
  title,
  sub,
  listLabel,
  rows,
  selected,
  basePath,
  emptyList,
  children,
}: {
  title: string;
  sub: string;
  listLabel: string;
  rows: PaneRow[];
  selected: string | null;
  basePath: string;
  emptyList: string;
  children: ReactNode;
}) {
  return (
    <>
      <PageHead title={title} sub={sub} />
      <div className="grid grid-cols-[280px_minmax(0,1fr)] items-start gap-5">
        <ListPane label={listLabel} rows={rows} selected={selected} basePath={basePath} empty={emptyList} />
        <div className="min-w-0">
          {children ?? (
            <Empty title={rows.length ? "Pick a candidate" : "Nobody is here yet"}>{rows.length ? "Choose somebody on the left." : emptyList}</Empty>
          )}
        </div>
      </div>
    </>
  );
}

export function CandidateHead({ id, name, meta }: { id: string; name: string; meta: string }) {
  return (
    <div className="mb-4 flex items-center gap-3">
      <span className="min-w-0 flex-1">
        <span className="block text-[22px] leading-7 font-semibold text-heading">{name}</span>
        <span className="block text-[13px] text-muted">{meta}</span>
      </span>
      <BtnLink href={`/hire/c/${id}`} size="sm">
        Open record
      </BtnLink>
    </div>
  );
}
