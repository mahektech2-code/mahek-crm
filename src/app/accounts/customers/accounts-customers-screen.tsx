"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button, Select } from "@/components/ui/primitives";
import { SelectionBar } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { Icon } from "@/components/shell/icons";
import { AccountManagerDialog } from "@/components/crm/account-manager-dialog";
import { updateAccountManagers } from "@/lib/actions/account-manager";
import { ScreenHeader, Table, HeadCell, Cell, Pager } from "../parts";
import { money } from "@/lib/format";

/* ---------------------------------------------------------------------------
 * The customer book, on the accounts side.
 *
 * WHY IT EXISTS AT ALL: changing an account manager is accounts' and admin's,
 * and an accounts user holds `apps: ["accounts"]` — `src/app/crm/layout.tsx`
 * redirects them out of the CRM before they see a customer. Shipping that
 * action only on the CRM's list would have been a permission that nobody
 * holding it could reach.
 *
 * WHAT IT SHARES AND WHAT IT DOES NOT. The data is `listCustomersPage()`, the
 * same query the CRM list runs, because two queries answering "who are our
 * customers" is how two screens end up disagreeing about one of them. The
 * dialog is the same component too. What is NOT shared is the presentation:
 * the CRM list offers reminders and WhatsApp and links every row into
 * `/crm/customers/[id]`, and every one of those is a door this app's users are
 * redirected away from. A shared component would have to grow a flag per
 * action to hide them, which is two screens wearing one name.
 * ------------------------------------------------------------------------- */

type Row = {
  id: string;
  name: string;
  city: string | null;
  status: string;
  outstanding: number;
  ownerName: string | null;
  salesAmName: string | null;
  backOfficeAmName: string | null;
};

export function AccountsCustomersScreen({
  rows,
  team,
  canReassign,
  amReasons,
  amSearchThreshold,
  filters,
  pageInfo,
}: {
  rows: Row[];
  team: Array<{ id: string; name: string }>;
  canReassign: boolean;
  amReasons: string[];
  amSearchThreshold: number;
  filters: { query: string; owner: string; perPage: number };
  pageInfo: { page: number; total: number };
}) {
  const router = useRouter();
  const search = useSearchParams();
  const { run } = useToast();

  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [changingAm, setChangingAm] = React.useState(false);
  const [draft, setDraft] = React.useState(filters.query);
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const navigate = React.useCallback(
    (patch: Record<string, string | number | undefined>) => {
      const next = new URLSearchParams(search.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined || v === "") next.delete(k);
        else next.set(k, String(v));
      }
      if (!("page" in patch)) next.delete("page");
      router.push(`/accounts/customers?${next.toString()}`);
    },
    [router, search],
  );

  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.id));

  return (
    <div>
      <ScreenHeader
        title="Customers"
        subtitle="Who each account answers to. Selecting accounts here is how the sales or back office manager is changed, and every change is kept with its reason."
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[240px] flex-1">
          <Icon
            name="search"
            size={16}
            className="pointer-events-none absolute top-2 left-2.5 text-muted"
          />
          <input
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              clearTimeout(timer.current);
              timer.current = setTimeout(() => navigate({ q: e.target.value }), 300);
            }}
            placeholder="Search name, contact, phone, city"
            className="h-8 w-full rounded-[4px] border border-line pr-7 pl-7.5 text-sm outline-none focus:border-brand"
          />
        </div>
        <Select
          value={filters.owner || "All account managers"}
          onChange={(e) =>
            navigate({
              owner: e.target.value === "All account managers" ? undefined : e.target.value,
            })
          }
          className="h-8"
        >
          <option>All account managers</option>
          {team.map((t) => (
            <option key={t.id}>{t.name}</option>
          ))}
        </Select>
      </div>

      <Table
        minWidth={900}
        head={
          <>
            <HeadCell width={36}>
              <input
                type="checkbox"
                aria-label="Select every account on this page"
                checked={allOnPage}
                onChange={(e) =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    for (const r of rows) {
                      if (e.target.checked) next.add(r.id);
                      else next.delete(r.id);
                    }
                    return next;
                  })
                }
                className="h-4 w-4 cursor-pointer"
              />
            </HeadCell>
            <HeadCell>Customer</HeadCell>
            <HeadCell>City</HeadCell>
            <HeadCell>Account manager — Sales</HeadCell>
            <HeadCell>Account manager — Back office</HeadCell>
            <HeadCell align="right">Outstanding</HeadCell>
          </>
        }
      >
        {rows.map((r) => (
          <tr key={r.id} className="border-t border-divider">
            <Cell>
              <input
                type="checkbox"
                aria-label={`Select ${r.name}`}
                checked={selected.has(r.id)}
                onChange={(e) =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(r.id);
                    else next.delete(r.id);
                    return next;
                  })
                }
                className="h-4 w-4 cursor-pointer"
              />
            </Cell>
            <Cell>
              <span className="font-medium text-ink">{r.name}</span>
            </Cell>
            <Cell>{r.city || "—"}</Cell>
            {/* "Nobody is assigned" is a fact worth showing plainly rather
                than an empty cell somebody reads as a loading failure. */}
            <Cell>{r.salesAmName ?? <span className="text-muted">Unassigned</span>}</Cell>
            <Cell>{r.backOfficeAmName ?? <span className="text-muted">Unassigned</span>}</Cell>
            <Cell align="right">{money(r.outstanding)}</Cell>
          </tr>
        ))}
      </Table>

      {!rows.length ? (
        <p className="px-1 py-6 text-[13px] text-muted">
          {filters.query || filters.owner
            ? "No account matches that filter."
            : "There are no customers yet."}
        </p>
      ) : null}

      <Pager
        total={pageInfo.total}
        page={pageInfo.page}
        perPage={filters.perPage}
        onPage={(p) => navigate({ page: p })}
        onPerPage={(n) => navigate({ per: n, page: 1 })}
      />

      <SelectionBar count={selected.size} onClear={() => setSelected(new Set())}>
        <Button
          variant="dark"
          size="sm"
          disabled={!canReassign}
          title={
            canReassign
              ? undefined
              : "Changing an account manager is an accounts or admin action"
          }
          onClick={() => setChangingAm(true)}
        >
          Update account manager
        </Button>
      </SelectionBar>

      <AccountManagerDialog
        // Keyed so it remounts with fresh state instead of resetting in an
        // effect, which is the React Compiler rule every dialog here follows.
        key={`am-${[...selected].join(",")}`}
        open={changingAm}
        count={selected.size}
        people={team}
        reasons={amReasons}
        searchThreshold={amSearchThreshold}
        onClose={() => setChangingAm(false)}
        onSubmit={async (change) => {
          const result = await run(
            updateAccountManagers({ customerIds: [...selected], ...change }),
          );
          if (result.ok) {
            setChangingAm(false);
            setSelected(new Set());
            router.refresh();
          }
        }}
      />
    </div>
  );
}
