"use client";

import * as React from "react";
import { useToast } from "@/components/ui/toast";
import { downloadCsv, toCsv } from "@/lib/csv";
import { stamp } from "@/lib/format";
import type { AuditRow } from "@/lib/services/accounts-audit-service";
import {
  Cell,
  Empty,
  HeadCell,
  Pager,
  Pill,
  Row,
  ScreenHeader,
  Table,
  plural,
} from "../parts";

/* ---------------------------------------------------------------------------
 * The audit log.
 *
 * Every approve, decline, confirm, reject, record and credit note already
 * wrote a row here; nothing ever showed them. A decision nobody can look up
 * later is a decision nobody can be asked about.
 *
 * There is no edit and no delete, deliberately — not hidden, absent.
 * ------------------------------------------------------------------------- */

const KIND_TONE: Record<AuditRow["kind"], "success" | "danger" | "warn" | "brand"> = {
  approve: "success",
  confirm: "success",
  issue: "success",
  decline: "danger",
  reject: "danger",
  refuse: "danger",
  record: "warn",
  reverse: "danger",
  hold: "warn",
};

export function AuditScreen({ rows }: { rows: AuditRow[] }) {
  const { push } = useToast();
  const [page, setPage] = React.useState(1);
  const [perPage, setPerPage] = React.useState(25);

  const shown = rows.slice((page - 1) * perPage, page * perPage);

  return (
    <div className="px-6 pt-6 pb-12">
      <div className="max-w-[1400px]">
        <ScreenHeader
          title="Audit log"
          subtitle="Every approve, decline, confirm, reject and record, with who did it and what it changed. Nothing here can be edited or deleted, by anyone."
          actions={
            <button
              onClick={() => {
                downloadCsv(
                  "mahek-accounts-audit",
                  toCsv(
                    ["When", "Who", "What", "On", "Kind"],
                    rows.map((r) => [
                      r.at.toISOString(),
                      r.actorName ?? "",
                      r.what,
                      r.on,
                      r.kind,
                    ]),
                  ),
                );
                push(`Exported ${plural(rows.length, "row")}`);
              }}
              className="h-9 cursor-pointer rounded-[4px] border border-line-strong bg-surface px-3.5 text-sm font-medium text-body hover:bg-canvas"
            >
              Export
            </button>
          }
        />

        {rows.length === 0 ? (
          <Empty
            title="Nothing decided yet"
            body="Approving an order, confirming a payment or issuing a credit note writes a row here the moment it happens."
          />
        ) : (
          <div className="overflow-hidden rounded-[6px] border border-line bg-surface">
            <Table
              minWidth={900}
              head={
                <>
                  <HeadCell>When</HeadCell>
                  <HeadCell>Who</HeadCell>
                  <HeadCell>What</HeadCell>
                  <HeadCell>On</HeadCell>
                  <HeadCell>Kind</HeadCell>
                </>
              }
            >
              {shown.map((r, i) => (
                <Row key={r.id} striped={i % 2 === 1}>
                  <Cell>{stamp(r.at)}</Cell>
                  <Cell>{r.actorName ?? "—"}</Cell>
                  <td className="px-4 py-2.5 align-middle text-sm text-pretty text-ink">
                    {r.what}
                  </td>
                  <Cell>{r.on}</Cell>
                  <Cell>
                    <Pill tone={KIND_TONE[r.kind]}>{r.kind}</Pill>
                  </Cell>
                </Row>
              ))}
            </Table>

            <Pager
              total={rows.length}
              page={page}
              perPage={perPage}
              note="Read-only — audit rows are never edited or deleted"
              onPage={setPage}
              onPerPage={(n) => {
                setPerPage(n);
                setPage(1);
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
