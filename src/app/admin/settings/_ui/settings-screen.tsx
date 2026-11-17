"use client";

import * as React from "react";
import Link from "next/link";
import { cx } from "@/components/ui/primitives";
import type { Config } from "@/lib/config/registry";
import type { Collection } from "@/lib/config/entity-collections";
import type { SchemaTab } from "@/lib/config/schema-contract";
import { SettingsEditor } from "../../settings-editor";
import type { Values } from "../../settings-model";

/* ---------------------------------------------------------------------------
 * SETTINGS, THE CANVAS'S WAY: one screen for every app's settings. The title
 * row carries find, Changed only and Export; the apps are a list on the left,
 * each with how many of its settings differ from their defaults; the app's
 * tabs sit over one card of fields; the save bar follows the card.
 *
 * The editor owns the drafts, the checks and the save, so this only says where
 * its parts go (`layout`).
 * ------------------------------------------------------------------------- */

export type SettingsApp = { id: string; label: string; href: string; changed: number };

export function SettingsScreen({
  apps,
  active,
  tabs,
  activeTab,
  owner,
  tab,
  values,
  config,
  warnings,
  canWrite,
  isPlatformAdmin,
  collections,
}: {
  apps: SettingsApp[];
  active: string;
  tabs: Array<{ slug: string; label: string; href: string }>;
  activeTab: string;
  owner: string;
  tab: SchemaTab;
  values: Values;
  config: Config;
  warnings: string[];
  canWrite: boolean;
  isPlatformAdmin: boolean;
  collections: Record<string, Collection>;
}) {
  return (
    <div className="flex w-full max-w-[1240px] flex-col gap-[18px] px-7 pt-6 pb-10 text-sm leading-[1.5]">
      <SettingsEditor
        key={`${active}/${activeTab}`}
        owner={owner}
        tab={tab}
        values={values}
        config={config}
        warnings={warnings}
        canWrite={canWrite}
        isPlatformAdmin={isPlatformAdmin}
        collections={collections}
        layout={({ controls, body }) => (
          <>
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="m-0 text-2xl leading-[30px] font-bold tracking-[-0.02em] text-ink">Settings</h1>
              <span className="flex-1" />
              {controls}
            </div>
            <div className="grid grid-cols-[220px_minmax(0,1fr)] items-start gap-[18px]">
              <nav aria-label="Apps" className="overflow-hidden rounded-card border border-line bg-surface">
                <div className="flex flex-col gap-0.5 p-2.5">
                  {apps.map((a) => {
                    const on = a.id === active;
                    return (
                      <Link
                        key={a.id}
                        href={a.href}
                        aria-current={on ? "page" : undefined}
                        className={cx(
                          "flex h-9 items-center gap-2 rounded-control px-3 no-underline hover:no-underline",
                          on ? "bg-brand-soft font-semibold text-brand-deep" : "font-medium text-body hover:bg-[#f7f9fc]",
                        )}
                      >
                        <span className="min-w-0 truncate">{a.label}</span>
                        {a.changed ? (
                          <span title={`${a.changed} changed from the default`} className="ml-auto text-[11px] font-bold text-brand-deep">
                            {a.changed}
                          </span>
                        ) : null}
                      </Link>
                    );
                  })}
                </div>
              </nav>
              <div className="flex min-w-0 flex-col gap-4">
                {tabs.length > 1 ? (
                  <nav aria-label="Tabs" className="flex flex-wrap gap-x-[26px] border-b border-line">
                    {tabs.map((t) => (
                      <Link
                        key={t.slug}
                        href={t.href}
                        aria-current={t.slug === activeTab ? "page" : undefined}
                        className={cx(
                          "-mb-px border-b-2 py-2.5 font-semibold whitespace-nowrap no-underline hover:no-underline",
                          t.slug === activeTab ? "border-brand text-ink" : "border-transparent text-muted hover:text-body",
                        )}
                      >
                        {t.label}
                      </Link>
                    ))}
                  </nav>
                ) : null}
                <div className="min-w-0">{body}</div>
              </div>
            </div>
          </>
        )}
      />
    </div>
  );
}
