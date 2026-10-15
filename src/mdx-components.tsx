import type { MDXComponents } from "mdx/types";
import Link from "next/link";
import { Callout, Card, Cards, Faq, Kbd, Pill, Rule, Step, Steps } from "@/docs/components/blocks";
import { Code } from "@/docs/components/code";
import { Flow } from "@/docs/components/flow";
import { Setting, SettingMap, SettingsTable } from "@/docs/components/live";
import { CapabilityGrid, DbEnum, DbTable, ModuleRef } from "@/docs/components/reference";
import {
  Hotspot,
  Hotspots,
  WfBar,
  WfBlock,
  WfButton,
  WfCard,
  WfField,
  WfInput,
  WfPanel,
  WfPill,
  WfSpacer,
  WfTable,
  WfTabs,
  WfText,
  WfTitle,
  Wireframe,
} from "@/docs/components/wireframe";

/* ---------------------------------------------------------------------------
 * How MDX renders, for every docs page — required by @next/mdx in the App
 * Router. Two jobs: the plain markdown elements in MahekOne's type scale, and
 * the docs components made available to every page WITHOUT an import, so a
 * page reads as prose with the odd <Rule> in it rather than as a module.
 *
 * Only the Documentation app imports MDX, so nothing else in MahekOne is
 * touched by these styles.
 * ------------------------------------------------------------------------- */

const components: MDXComponents = {
  h2: (p) => (
    <h2 {...p} className="mt-12 mb-3 scroll-mt-20 border-b border-divider pb-2 text-[22px] leading-[30px] font-semibold text-heading first:mt-0" />
  ),
  h3: (p) => <h3 {...p} className="mt-8 mb-2 scroll-mt-20 text-[17px] leading-[24px] font-semibold text-heading" />,
  h4: (p) => <h4 {...p} className="mt-6 mb-1.5 text-[14px] font-semibold tracking-[0.02em] text-ink" />,
  p: (p) => <p {...p} className="my-3 text-[15px] leading-[25px] text-body" />,
  ul: (p) => <ul {...p} className="my-3 list-disc space-y-1.5 pl-5 text-[15px] leading-[24px] text-body marker:text-faint" />,
  ol: (p) => <ol {...p} className="my-3 list-decimal space-y-1.5 pl-5 text-[15px] leading-[24px] text-body marker:text-muted" />,
  li: (p) => <li {...p} className="pl-1 [&>p]:my-1" />,
  strong: (p) => <strong {...p} className="font-semibold text-ink" />,
  a: ({ href = "", ...p }) =>
    href.startsWith("/") || href.startsWith("#") ? (
      <Link href={href} {...p} className="font-medium text-brand-hover underline decoration-brand-softer underline-offset-2 hover:decoration-brand" />
    ) : (
      <a href={href} target="_blank" rel="noreferrer" {...p} className="font-medium text-brand-hover underline underline-offset-2" />
    ),
  blockquote: (p) => <blockquote {...p} className="my-4 border-l-[3px] border-line-strong pl-4 text-[15px] text-muted italic" />,
  hr: () => <hr className="my-10 border-divider" />,
  table: (p) => (
    <div className="my-5 overflow-x-auto rounded-[6px] border border-line">
      <table {...p} className="w-full border-collapse text-left text-[13.5px]" />
    </div>
  ),
  thead: (p) => <thead {...p} className="border-b border-line bg-canvas" />,
  th: (p) => <th {...p} className="px-3 py-2 text-[11px] font-semibold tracking-[0.04em] whitespace-nowrap text-muted uppercase" />,
  td: (p) => <td {...p} className="border-b border-divider px-3 py-2 align-top leading-[20px] text-body" />,
  code: (p) => (
    <code {...p} className="rounded-[3px] bg-canvas px-1 py-px font-mono text-[0.86em] text-ink [pre_&]:bg-transparent [pre_&]:p-0" />
  ),
  pre: (p) => (
    <pre {...p} className="docs-fence my-5 overflow-x-auto rounded-[6px] border border-line !bg-surface px-4 py-3 text-[12.5px] leading-[20px]" />
  ),

  Callout,
  Card,
  Cards,
  Faq,
  Kbd,
  Pill,
  Rule,
  Step,
  Steps,
  Code,
  Flow,
  Setting,
  SettingsTable,
  SettingMap,
  CapabilityGrid,
  DbEnum,
  DbTable,
  ModuleRef,
  Wireframe,
  Hotspot,
  Hotspots,
  WfBar,
  WfBlock,
  WfButton,
  WfCard,
  WfField,
  WfInput,
  WfPanel,
  WfPill,
  WfSpacer,
  WfTable,
  WfTabs,
  WfText,
  WfTitle,
};

export function useMDXComponents(): MDXComponents {
  return components;
}
