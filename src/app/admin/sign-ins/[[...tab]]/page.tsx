import Link from "next/link";
import { ADMIN, ADMIN_TABS, tabIndexOf } from "@/lib/admin-routes";
import { APP_TIMEZONE } from "@/lib/business-date";
import { today } from "@/lib/queries";
import {
  liveSessions,
  onboardingRows,
} from "@/lib/services/admin-platform-service";
import {
  pausedAccounts,
  signInLog,
  type SignInEvent,
} from "@/lib/services/admin-security-view-service";
import { requirePlatformAdmin } from "../../_shell/context";
import { Card, Mono, Pill, type Tone } from "../../_shell/kit";
import { OnboardingTab, SessionsTab } from "../../platform-real";
import {
  SecurityFrame,
  SecurityPolicy,
  type SecurityTab,
} from "../security-frame";

/**
 * Security & sign-ins: the sign-in log beside the policy that governs it, who
 * is signed in now, the accounts paused by wrong passwords, and the accounts
 * nobody has ever used. Codes and the policy on its own have their own routes;
 * the frame draws the same figures and tabs over all of them.
 */
export default async function SignInsPage({
  params,
  searchParams,
}: {
  params: Promise<{ tab?: string[] }>;
  searchParams: Promise<{ view?: string; q?: string; day?: string }>;
}) {
  const ctx = await requirePlatformAdmin();
  const [{ tab }, sp] = await Promise.all([params, searchParams]);
  const slug = tab?.[0]
    ? ADMIN_TABS.signIns[tabIndexOf(ADMIN_TABS.signIns, tab[0])].slug
    : null;
  const active: SecurityTab =
    slug === "never"
      ? "never"
      : sp.view === "now" || slug === "now"
        ? "now"
        : sp.view === "paused"
          ? "paused"
          : "log";

  if (active === "now") {
    return (
      <SecurityFrame active="now">
        <SessionsTab data={{ sessions: await liveSessions() }} />
      </SecurityFrame>
    );
  }
  if (active === "never") {
    return (
      <SecurityFrame active="never">
        <OnboardingTab data={{ onboarding: await onboardingRows() }} />
      </SecurityFrame>
    );
  }
  if (active === "paused") {
    const paused = await pausedAccounts();
    return (
      <SecurityFrame active="paused">
        <Card>
          <Table head={["Person", "Wrong passwords", "Last try", "From"]}>
            {paused.length === 0 ? (
              <Empty cols={4}>No account is paused right now.</Empty>
            ) : (
              paused.map((p) => (
                <tr key={p.account}>
                  <Td className="font-semibold text-ink">
                    {p.userId ? (
                      <Link
                        href={ADMIN.person(p.userId)}
                        className="text-ink no-underline hover:underline"
                      >
                        {p.name}
                      </Link>
                    ) : (
                      p.name
                    )}
                  </Td>
                  <Td>
                    <Pill tone="danger">{p.failures}</Pill>
                  </Td>
                  <Td className="tabular-nums">{clock(p.lastAt)}</Td>
                  <Td>
                    {p.addresses.length ? (
                      <Mono>{p.addresses.join(" · ")}</Mono>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </Td>
                </tr>
              ))
            )}
          </Table>
          <div className="border-t border-divider px-[18px] py-3 text-muted">
            A pause ends on its own when the counting window passes, or the
            moment they sign in with a WhatsApp code or reset their password.
          </div>
        </Card>
      </SecurityFrame>
    );
  }

  const [log, day] = await Promise.all([signInLog({ q: sp.q, day: sp.day }), today()]);
  return (
    <SecurityFrame active="log">
      <div
        className="grid items-start gap-[18px]"
        style={{ gridTemplateColumns: "minmax(0,1fr) 340px" }}
      >
        <Card>
          <form className="flex items-center gap-2.5 px-[18px] py-3.5">
            {sp.day ? <input type="hidden" name="day" value={sp.day} /> : null}
            <input
              name="q"
              defaultValue={sp.q ?? ""}
              placeholder="Person or address"
              aria-label="Find in the sign-in log"
              className="h-[38px] w-[240px] rounded-control border border-line-strong bg-surface px-3 text-[13px] text-ink"
            />
            <input
              type="date"
              name="day"
              defaultValue={sp.day ?? day}
              aria-label="Day"
              className="h-[38px] rounded-control border border-line-strong bg-surface px-3 text-[13px] font-semibold text-ink"
            />
            <button
              type="submit"
              className="h-[38px] rounded-control border border-line-strong bg-surface px-3.5 text-[13px] font-semibold text-ink"
            >
              Filters
            </button>
            <span className="flex-1" />
            <span className="text-muted">{!sp.day || sp.day === day ? "Today" : sp.day}</span>
          </form>
          <Table head={["When", "Person", "Result", "How", "From"]}>
            {log.length === 0 ? (
              <Empty cols={5}>
                Nobody signed in or was turned away that day.
              </Empty>
            ) : (
              log.map((e) => (
                <tr key={e.id}>
                  <Td className="tabular-nums">{clock(e.at)}</Td>
                  <Td className="font-semibold text-ink">
                    {e.userId ? (
                      <Link
                        href={ADMIN.person(e.userId)}
                        className="text-ink no-underline hover:underline"
                      >
                        {e.name}
                      </Link>
                    ) : (
                      e.name
                    )}
                  </Td>
                  <Td>
                    <Pill tone={TONE[e.kind]}>{e.result}</Pill>
                  </Td>
                  <Td className="text-body">{e.how}</Td>
                  <Td>
                    {e.from ? (
                      <Mono className="text-[13px] text-ink">{e.from}</Mono>
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </Td>
                </tr>
              ))
            )}
          </Table>
        </Card>
        <SecurityPolicy canWrite={ctx.canWriteConfig} />
      </div>
    </SecurityFrame>
  );
}

const TONE: Record<SignInEvent["kind"], Tone> = {
  signed_in: "ok",
  code_signin: "ok",
  wrong_password: "warn",
  paused: "danger",
  code_refused: "muted",
  impersonation: "brand",
};

function Table({
  head,
  children,
}: {
  head: string[];
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            {head.map((h) => (
              <th
                key={h}
                className="bg-ink px-3.5 py-[9px] text-left text-xs font-semibold whitespace-nowrap text-white normal-case"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Td({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <td
      className={`h-[45px] border-b border-divider px-3.5 whitespace-nowrap ${className ?? "text-body"}`}
    >
      {children}
    </td>
  );
}

function Empty({
  cols,
  children,
}: {
  cols: number;
  children: React.ReactNode;
}) {
  return (
    <tr>
      <td colSpan={cols} className="h-24 text-center text-muted">
        {children}
      </td>
    </tr>
  );
}

const CLOCK = new Intl.DateTimeFormat("en-IN", {
  timeZone: APP_TIMEZONE,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const clock = (d: Date) => CLOCK.format(d);
