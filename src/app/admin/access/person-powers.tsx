import * as React from "react";
import Link from "next/link";
import { Badge, Card, CardHeader, cx } from "@/components/ui/primitives";
import type { AppId } from "@/lib/apps";
import { ERP_POWER_LABEL } from "@/lib/erp/powers";
import { HRMS_POWER_LABEL } from "@/lib/hrms/powers";
import { TASK_POWER_LABEL } from "@/lib/tasks/permissions";
import { ROLE_LABEL as HIRE_ROLE_LABEL, ROLE_SENTENCE as HIRE_ROLE_SENTENCE, defaultRoleFor, type HireRole } from "@/lib/hire/roles";
import { placeSentence, placeWords, type FactoryPlace } from "@/lib/factory/departments";
import type { AppGrant } from "@/lib/services/access-service";

/* ---------------------------------------------------------------------------
 * What a person holds INSIDE an app, beyond the level and the screens.
 *
 * The Apps tab said "ERP · Associate · all 40 screens" and stopped, which
 * left out most of what decides what somebody can do there: the ERP
 * designation and its powers, HRMS's powers, Tasks' permissions, the job in
 * Hire and the place on the factory floor. All of it is set on the Access
 * screen; this reads it back in words.
 *
 * Every power is written out with what it lets them do — not behind a hover —
 * because the question somebody brings to this page is "why can she approve
 * that", and the answer is the sentence, not the label.
 *
 * An ADMINISTRATOR of the ERP, HRMS or Tasks holds every power with no rows
 * at all (see the header of each powers file), so for them the page says so
 * rather than listing an empty set that reads as "none".
 * ------------------------------------------------------------------------- */

export type PersonPowers = {
  erpPowers: string[];
  hrmsPowers: string[];
  taskPowers: string[];
  hireRole: string | null;
  factoryPlace: FactoryPlace | null;
  erpDesignation: { name: string; matches: boolean } | null;
};

export type PersonEmployee = { code: string; name: string; position: string | null; isHead: boolean };

type Catalogue = Record<string, { label: string; source: string }>;

function PowerList({ held, catalogue }: { held: string[]; catalogue: Catalogue }) {
  return (
    <ul className="mt-1.5 grid gap-1.5">
      {held.map((p) => {
        const known = catalogue[p];
        return (
          <li key={p}>
            <span className="block text-[13px] font-medium text-ink">{known?.label ?? p}</span>
            <span className="block text-[13px] text-muted">
              {known?.source ?? "A power that is no longer defined. It does nothing; remove it on the Access screen."}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-2.5">
      <div className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">{title}</div>
      <div className="mt-0.5 text-[13px] text-body">{children}</div>
    </div>
  );
}

/** Powers in the registry's order, so two people's lists read alike. */
const ordered = (held: string[], catalogue: Catalogue) => {
  const keys = Object.keys(catalogue);
  return [...held].sort((a, b) => (keys.indexOf(a) + 1 || 999) - (keys.indexOf(b) + 1 || 999));
};

/**
 * The extra lines under one app on the Apps tab, or null where there is
 * nothing to add. `grant` is null where they do not hold the app — rows can
 * outlive a grant, and a power left behind is listed as doing nothing.
 */
export function appExtras({
  app,
  grant,
  powers,
  employee,
  platformAdmin,
}: {
  app: AppId;
  grant: AppGrant | null;
  powers: PersonPowers | null;
  employee: PersonEmployee | null;
  platformAdmin: boolean;
}): React.ReactNode {
  if (!powers) return null;
  const administrator = grant?.role === "admin";
  const inert = grant ? null : <span className="text-warn-ink">Held by row, but they do not hold the app, so it does nothing.</span>;

  if (app === "erp") {
    /* An ERP administrator is the admin level on the ERP grant, or a platform
       administrator (`lib/erp/powers.ts`). */
    const all = !!grant && (administrator || platformAdmin);
    if (!grant && !powers.erpPowers.length && !powers.erpDesignation) return null;
    return (
      <>
        <Block title="Designation">
          {powers.erpDesignation ? (
            <>
              <span className="text-ink">{powers.erpDesignation.name}</span>{" "}
              {powers.erpDesignation.matches ? (
                <Badge tone="success">matches it</Badge>
              ) : (
                <Badge tone="warn" title="An edit to the designation will not move them">customised</Badge>
              )}
              <span className="block text-muted">
                {powers.erpDesignation.matches
                  ? "Their ERP level, screens and powers are exactly the designation's, so an edit to it moves them too."
                  : "Their ERP access has been changed away from the designation, so an edit to it leaves them where they are."}
              </span>
            </>
          ) : (
            "None — their ERP access was set by hand."
          )}
        </Block>
        <Block title="ERP powers">
          {all ? (
            `Every power, with no rows: ${administrator ? "they are an ERP administrator" : "they are a platform administrator"}, and an ERP administrator holds them all.`
          ) : powers.erpPowers.length ? (
            <>
              {inert}
              <PowerList held={ordered(powers.erpPowers, ERP_POWER_LABEL)} catalogue={ERP_POWER_LABEL} />
            </>
          ) : (
            "None. They see and do what their level and screens allow, and nothing a power reveals."
          )}
        </Block>
      </>
    );
  }

  if (app === "hrms") {
    /* An HRMS administrator: the admin level on the HRMS grant, or a platform
       administrator (`lib/hrms/powers.ts`). A head's two powers come with the
       Position in the employee sheet, not with a row (`lib/hrms/access.ts`). */
    const all = !!grant && (administrator || platformAdmin);
    const head = !!grant && !all && !!employee?.isHead;
    if (!grant && !powers.hrmsPowers.length) return null;
    return (
      <Block title="HRMS powers">
        {all ? (
          `Every power, with no rows: ${administrator ? "they are an HRMS administrator" : "they are a platform administrator"}, and an HRMS administrator holds them all.`
        ) : (
          <>
            {inert}
            {powers.hrmsPowers.length ? (
              <PowerList held={ordered(powers.hrmsPowers, HRMS_POWER_LABEL)} catalogue={HRMS_POWER_LABEL} />
            ) : head ? null : (
              "None granted."
            )}
            {head ? (
              <div className="mt-2 rounded-control border border-line bg-canvas px-3 py-2">
                <span className="block text-ink">
                  Also {HRMS_POWER_LABEL.markStaff.label.toLowerCase()} and {HRMS_POWER_LABEL.checkoutStaff.label.toLowerCase()}, by position
                </span>
                <span className="block text-muted">
                  Their Position in the employee sheet is “{employee!.position}”, and a department head holds these two for the staff of their own office with no row on the Access screen. It does not widen what they see to the whole company. Changing it is a change to the employee sheet, not here.
                </span>
              </div>
            ) : null}
          </>
        )}
      </Block>
    );
  }

  if (app === "tasks") {
    /* A Tasks administrator: the admin level on the Tasks grant, or a platform
       administrator (`lib/tasks/permissions.ts`). */
    const all = !!grant && (administrator || platformAdmin);
    if (!grant && !powers.taskPowers.length) return null;
    return (
      <Block title="Tasks permissions">
        {all ? (
          `Every permission, with no rows: ${administrator ? "they are a Tasks administrator" : "they are a platform administrator"}.`
        ) : powers.taskPowers.length ? (
          <>
            {inert}
            <PowerList held={ordered(powers.taskPowers, TASK_POWER_LABEL)} catalogue={TASK_POWER_LABEL} />
          </>
        ) : (
          "None — the org chart decides: they see, give and manage tasks for the people below them, and their own."
        )}
      </Block>
    );
  }

  if (app === "hire") {
    if (!grant) return null;
    const set = powers.hireRole as HireRole | null;
    const role = set ?? defaultRoleFor(grant.role);
    return (
      <Block title="Job in Hire">
        <span className="text-ink">{HIRE_ROLE_LABEL[role] ?? role}</span>
        {set ? null : <span className="text-muted"> — none chosen, so their level decides</span>}
        <span className="block text-muted">{HIRE_ROLE_SENTENCE[role]}</span>
      </Block>
    );
  }

  if (app === "factory") {
    if (!grant) return null;
    const place = powers.factoryPlace;
    return (
      <Block title="Place on the floor">
        {place && place.depts.length ? (
          <>
            <span className="text-ink">{placeWords(place)}</span>
            <span className="block text-muted">{placeSentence(place, grant.role)}</span>
          </>
        ) : (
          <span className="text-warn-ink">No department set, so they open the app and have no work in it.</span>
        )}
      </Block>
    );
  }

  return null;
}

/* ------------------------------------------------------------ set elsewhere */

export type ElsewhereLink = {
  label: string;
  href: string;
  /** What that place says about this person now. */
  now: string;
  /** Why it matters to their access. */
  why: string;
  /** Said in the warning colour, where what is set there widens their reach without anybody having decided it. */
  warn?: string;
};

/**
 * Where the other inputs to somebody's access are kept. The Access screen is
 * the one place an app or a power is granted; these are the places that move
 * what somebody can do without a grant, and a person page that did not name
 * them sent an administrator hunting.
 */
export function SetElsewhere({ links }: { links: ElsewhereLink[] }) {
  return (
    <Card className="mt-5 overflow-hidden shadow-[0_1px_2px_rgba(22,22,22,0.06)]">
      <CardHeader title="Set elsewhere" hint="Inputs to what they can do that are not on the Access screen." />
      {links.map((l, i) => (
        <div key={l.label} className={cx("px-5 py-3", i ? "border-t border-canvas" : "")}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-sm font-medium text-ink">{l.label}</span>
            <Link href={l.href} className="text-[13px] font-medium">
              Open →
            </Link>
          </div>
          <div className="mt-0.5 text-[13px] text-body">{l.now}</div>
          {l.warn ? <div className="mt-0.5 text-[13px] font-medium text-warn-ink">{l.warn}</div> : null}
          <div className="mt-0.5 text-[13px] text-muted">{l.why}</div>
        </div>
      ))}
    </Card>
  );
}
