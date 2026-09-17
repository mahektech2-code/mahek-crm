import Link from "next/link";
import { shortDate, stamp } from "@/lib/format";
import { today } from "@/lib/recompute";
import { fieldTeam, tasksList } from "@/lib/services/sales-service";
import { AssignTask } from "./assign-task";
import {
  Cell,
  Empty,
  FilterChips,
  MetricRow,
  Pill,
  Row,
  ScreenHeader,
  SortHead,
  Table,
} from "../parts";
import { CustomerName } from "../customer-name";
import { readSort, sortHref, sortRows, type SortColumns } from "../sort";
import {
  plural,
} from "../words";

export const metadata = { title: "Tasks — Sales Dashboard — MahekOne" };

/**
 * What each salesman has been asked to do.
 *
 * The design's own framing, and it is the right one: a task list read by a
 * manager is not a to-do list, it is a list of promises made on somebody
 * else's behalf. So the columns that matter are who it is on, what it is
 * against, and how late it is — and overdue is a filter rather than a colour,
 * because the overdue ones are the whole reason to open the screen.
 *
 * Tasks are raised on the handset and by MahekOne itself: a rejected order
 * raises one automatically, because the salesman stood in the shop and said
 * the order was placed. "Raised by" says which.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ show?: string; sort?: string; dir?: string }>;
}) {
  const params = await searchParams;
  const day = await today();
  const [all, salesmen] = await Promise.all([tasksList(day), fieldTeam()]);

  const show = ["all", "overdue", "open", "done"].includes(params.show ?? "")
    ? params.show!
    : "open";

  const overdue = all.filter((t) => t.status !== "done" && t.overdueDays > 0);
  const open = all.filter((t) => t.status !== "done" && t.status !== "cancelled");
  const done = all.filter((t) => t.status === "done");

  const rows =
    show === "all" ? all : show === "overdue" ? overdue : show === "done" ? done : open;

  const oldest = overdue.reduce((n, t) => Math.max(n, t.overdueDays), 0);

  /* Sorting is display-only. Every figure above the table — open, overdue, the
     oldest one, and how many are on nobody — is counted over the chip's whole
     set and never over the sorted copy, because re-ordering a list changes the
     order of what is in it and not what is in it. A count that moved when
     somebody clicked a column would be the screen disagreeing with itself.

     The chip goes into the href as the params to PRESERVE: a sort that dropped
     `show` would answer the click by silently widening "Overdue" back to
     "Open", which reads as the sort having rearranged the wrong list. */
  const sort = readSort(params, COLUMNS);
  const sorted = sortRows(rows, sort, COLUMNS);
  const head = (key: string, label: string, width?: number) => (
    <SortHead
      width={width}
      href={sortHref("/sales/tasks", sort, key, `show=${show}`)}
      active={sort.key === key}
      dir={sort.dir}
    >
      {label}
    </SortHead>
  );

  return (
    <div className="p-6">
      <ScreenHeader
        title="Tasks"
        subtitle="What you have asked each salesman to do. A task raised by the office and a task the app raised itself both land here — a rejected order raises one automatically, because the salesman stood in the shop and said it was placed."
        actions={<AssignTask salesmen={salesmen.filter((s) => s.active)} />}
      />

      <MetricRow
        metrics={[
          { label: "Open", value: String(open.length) },
          {
            label: "Overdue",
            value: String(overdue.length),
            sub: oldest ? `oldest ${plural(oldest, "day")} late` : undefined,
            tone: overdue.length ? "danger" : undefined,
          },
          { label: "Done", value: String(done.length) },
          {
            label: "On nobody",
            value: String(all.filter((t) => !t.customerName).length),
            sub: "not against a shop",
          },
        ]}
      />

      <FilterChips
        current={show}
                options={[
          { key: "open", href: `/sales/tasks?show=open`, label: "Open", count: open.length },
          { key: "overdue", href: `/sales/tasks?show=overdue`, label: "Overdue", count: overdue.length },
          { key: "done", href: `/sales/tasks?show=done`, label: "Done", count: done.length },
          { key: "all", href: `/sales/tasks?show=all`, label: "Everything", count: all.length },
        ]}
      />

      {rows.length === 0 ? (
        <Empty
          title={show === "overdue" ? "Nothing is overdue" : "Nothing outstanding"}
          body={
            show === "overdue"
              ? "Every task with a date on it is still inside it."
              : "No task is waiting on anybody in the field. They are raised on the handset, by the office, or by MahekOne itself when an order is refused."
          }
        />
      ) : (
        <Table
          minWidth={1120}
          head={
            <>
              {head("task", "Task")}
              {head("salesman", "Salesman", 180)}
              {head("customer", "Customer", 200)}
              {head("due", "Due", 160)}
              {head("priority", "Priority", 110)}
              {head("state", "State", 120)}
              {head("raised", "Raised by", 170)}
            </>
          }
        >
          {sorted.map((t, i) => (
            <Row key={t.id} striped={i % 2 === 1}>
              <Cell truncate={360} title={t.description ?? undefined}>
                <span className="font-medium text-ink">{t.title}</span>
                {t.completionNote ? (
                  <span className="block truncate text-[12px] text-muted">
                    “{t.completionNote}”
                  </span>
                ) : null}
              </Cell>
              <Cell truncate={180}>
                <Link
                  href={`/sales/people/${t.salesmanId}`}
                  className="no-underline"
                >
                  {t.salesmanName}
                </Link>
              </Cell>
              <Cell truncate={200}>
                <CustomerName
                  id={t.customerId}
                  name={t.customerName}
                  muted={<span className="text-muted">—</span>}
                />
              </Cell>
              <Cell>
                {t.dueDate ? shortDate(t.dueDate) : <span className="text-muted">No date</span>}
                {t.overdueDays > 0 && t.status !== "done" ? (
                  <span className="block text-[12px] text-danger">
                    {plural(t.overdueDays, "day")} late
                  </span>
                ) : null}
              </Cell>
              <Cell>
                <Pill tone={t.priority === "high" ? "danger" : t.priority === "low" ? "neutral" : "warn"}>
                  {t.priority}
                </Pill>
              </Cell>
              <Cell>
                <Pill
                  tone={
                    t.status === "done"
                      ? "success"
                      : t.overdueDays > 0
                        ? "danger"
                        : "neutral"
                  }
                >
                  {t.status === "done"
                    ? "Done"
                    : t.overdueDays > 0
                      ? "Overdue"
                      : t.status.replace(/_/g, " ")}
                </Pill>
              </Cell>
              <Cell truncate={170} title={stamp(t.createdAt)}>
                {t.raisedBy ?? <span className="text-muted">The app</span>}
              </Cell>
            </Row>
          ))}
        </Table>
      )}
    </div>
  );
}

const COLUMNS: SortColumns<{
  title: string;
  salesmanName: string;
  customerName: string | null;
  dueDate: string | null;
  priority: string;
  status: string;
  raisedBy: string | null;
}> = {
  task: (t) => t.title,
  salesman: (t) => t.salesmanName,
  /* A task raised against nobody sorts last rather than first, which is where
     it belongs: the metric above already counts them, and a descending sort on
     the shop is somebody looking for a shop. */
  customer: (t) => t.customerName,
  /* Compared as the ISO day it is stored as, and NOT turned into an instant.
     A zero-padded `YYYY-MM-DD` orders identically either way, and reading one
     through `new Date` would invent a midnight in whatever zone the server
     happens to be in to answer a question that never needed one. A task with
     no date sorts last under both directions — it is not the soonest thing due
     and it is not the latest, it is a task nobody put a day on. */
  due: (t) => t.dueDate,
  priority: (t) => t.priority,
  /* The stored status rather than the word in the cell. What is drawn there
     folds `overdueDays` into the state, so sorting on it would interleave two
     different facts under one heading — how late a task is has its own column,
     and the Overdue chip is the honest way to ask that question. */
  state: (t) => t.status,
  /* Null is MahekOne itself, drawn as "The app". It sorts last rather than
     under T, because the rows a manager is looking for here are the ones a
     person put on somebody. */
  raised: (t) => t.raisedBy,
};
