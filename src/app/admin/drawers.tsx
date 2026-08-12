"use client";

import * as React from "react";
import { Button, Input, Select, cx } from "@/components/ui/primitives";
import { Drawer, DrawerHeader } from "@/components/ui/overlays";
import { VoiceTextarea } from "@/components/ui/dictate";
import type { EntityKind, EntityRow } from "./data";
import { RichTextEditor } from "./rich-text";
import { saveTemplate } from "@/lib/actions/crm";
import { useRouter } from "next/navigation";
import {
  createUser,
  setUserActive,
  setUserRole,
  updateUserIdentity,
} from "@/lib/actions/people";
import { validateAppEndpoint, validateAppRoute, validateAppSlug } from "@/lib/apps";
import { slugify } from "@/lib/slug";
import { useAdmin, type Drawer as DrawerState } from "./store";

/* ---------------------------------------------------------------------------
 * Every editor in the console is the same drawer: a list of declared fields, an
 * optional live preview, and an optional set of blockers that must be cleared
 * before Save does anything.
 *
 * Mounting it with a key means a drawer opened for one record never shows what
 * somebody typed about a different one.
 * ------------------------------------------------------------------------- */

type FieldSpec = {
  rich?: boolean;
  /** Shown but not editable, with `help` saying why. */
  readOnly?: boolean;
  key: string;
  label: string;
  value: string;
  placeholder?: string;
  help?: string;
  error?: string;
  area?: boolean;
  select?: string[];
  half?: boolean;
};

const PLACEHOLDERS = ["customer", "contact", "amount", "bill", "days", "date", "qty", "telecaller"];

const SAMPLE: Record<string, string> = {
  customer: "Shree Paints & Hardware",
  contact: "Mahesh Shah",
  amount: "₹1,84,500",
  bill: "MM-4418",
  days: "18",
  date: "14 Aug",
  qty: "8 drums",
  telecaller: "Priya Sharma",
  lastorder: "28 Jul",
  cycle: "21 days",
};

export function AdminDrawer() {
  const { drawer, closeDrawer } = useAdmin();
  if (!drawer) return null;
  // The Access screen renders its own modal from this same state. Falling
  // through to DrawerBody would open an empty editor beside it.
  if (drawer.kind === "enableAccess") return null;
  // Remount per record rather than resetting state in an effect.
  return <DrawerBody key={drawerKey(drawer)} drawer={drawer} onClose={closeDrawer} />;
}

function drawerKey(d: DrawerState): string {
  return `${d.kind}:${"id" in d ? (d.id ?? "new") : "new"}`;
}

function DrawerBody({ drawer, onClose }: { drawer: DrawerState; onClose: () => void }) {
  const router = useRouter();
  const { entities, users, registry, notify, archiveEntity } = useAdmin();
  const [draft, setDraft] = React.useState<Record<string, string>>({});

  const kind = drawer.kind;
  const id = "id" in drawer ? drawer.id : null;
  const entityKind = isEntityKind(kind) ? (kind as EntityKind) : null;
  const record0: EntityRow | null = entityKind && id ? entities[entityKind].find((r) => r.id === id) ?? null : null;
  const user = "id" in drawer && drawer.id ? users.find((u) => u.id === drawer.id) ?? null : null;

  const v = (key: string, fallback = "") => draft[key] ?? fallback;
  const set = (key: string) => (e: { target: { value: string } }) =>
    setDraft((d) => ({ ...d, [key]: e.target.value }));

  let title = "";
  let sub = "";
  let saveLabel = "Save";
  let fields: FieldSpec[] = [];
  let preview: { name: string; body: string } | null = null;
  // A warning that does not block. Where something genuinely cannot proceed
  // the save button is what says so, not a card with a button that opens a
  // flow nobody built.
  let blockers: Array<{ line: string; cta?: string; run?: () => void }> = [];

  if (kind === "templates") {
    title = record0 ? "Edit template" : "New template";
    sub = "Merge placeholders are checked here, not at send time.";
    saveLabel = record0 ? "Save template" : "Create template";
    const body = v("body", record0?.body ?? "");
    const used = (body.match(/\{[a-z]+\}/g) ?? []).map((x) => x.replace(/[{}]/g, ""));
    const unknown = [...new Set(used.filter((x) => !PLACEHOLDERS.includes(x)))];
    fields = [
      { key: "name", label: "Template name", value: v("name", record0?.name ?? "") },
      {
        key: "cat", label: "Category", value: v("cat", record0?.cat ?? "Payment reminder"), half: true,
        select: ["Order confirmation", "Payment reminder", "Routine check-in", "Reactivation", "Other"],
      },
      { key: "stage", label: "Escalation stage", value: v("stage", record0?.stage ?? "—"), half: true, select: ["—", "1", "2", "3"] },
      {
        key: "body", label: "Message body", value: body, area: true,
        help: `Available: ${PLACEHOLDERS.map((p) => `{${p}}`).join(" ")}`,
        error: unknown.length
          ? `Unknown placeholder: ${unknown.map((x) => `{${x}}`).join(", ")}. The system cannot resolve it, so it would send literally.`
          : undefined,
      },
    ];
    preview = { name: SAMPLE.customer, body };
  } else if (kind === "scripts") {
    title = record0 ? "Edit call script" : "New call script";
    sub = "Read aloud, so it is set larger in the CRM than the rest of the interface.";
    saveLabel = record0 ? "Save script" : "Create script";
    const body = v("body", record0?.body ?? "OPENING\n\n\nPURPOSE\n\n\nCLOSING\n");
    fields = [
      { key: "name", label: "Script name", value: v("name", record0?.name ?? "") },
      {
        key: "situation", label: "Situation it matches", value: v("situation", record0?.situation ?? "Routine check-in"), half: true,
        select: ["Routine check-in", "Order due", "Collections stage 1", "Collections stage 2", "Collections stage 3", "Complaint handling", "Inactive"],
      },
      { key: "lang", label: "Language", value: v("lang", record0?.lang ?? "Hindi"), half: true, select: ["Hindi", "English", "Marathi"] },
      {
        key: "body", label: "Body — named blocks", value: body, area: true,
        help: "Use block headings in caps: OPENING · PURPOSE · IF … (repeatable) · CLOSING.",
      },
    ];
    preview = { name: SAMPLE.customer, body };
  } else if (kind === "help") {
    title = record0 ? "Edit article" : "New article";
    sub = "Read in the CRM Help Center, authored here.";
    saveLabel = record0 ? "Save article" : "Create article";
    fields = [
      { key: "name", label: "Title", value: v("name", record0?.name ?? "") },
      {
        key: "cat", label: "Category", value: v("cat", record0?.cat ?? "Collections SOP"), half: true,
        select: ["Call scripts", "Collections SOP", "Order capture", "Complaints", "System basics"],
      },
      { key: "type", label: "Type", value: v("type", record0?.type ?? "SOP"), half: true, select: ["SOP", "Call script", "System guide", "Policy"] },
      {
        key: "roles", label: "Visible to", value: v("roles", record0?.roles ?? "Telecaller, Manager"),
        select: ["Telecaller", "Manager", "Telecaller, Manager"],
      },
      {
        key: "body", label: "Body", value: v("body", record0?.body ?? ""), rich: true,
        help: "Read in the CRM Help Center. Written as Markdown so the stored article stays legible in an audit diff.",
      },
    ];
  } else if (kind === "holidays") {
    title = "Add holiday";
    sub = "Excluded from working-day counts and run-rate maths.";
    saveLabel = "Add holiday";
    fields = [
      { key: "date", label: "Date", value: v("date"), placeholder: "02 Oct 2026" },
      { key: "name", label: "Name", value: v("name"), placeholder: "Gandhi Jayanti" },
      { key: "applies", label: "Applies to", value: v("applies", "Whole company"), select: ["Whole company", "Telecalling only", "Field sales only"] },
    ];
  } else if (kind === "rules") {
    title = record0 ? `Field rules · ${record0.name}` : "Per-outcome rules";
    sub = "Which fields appear, and what saving this outcome creates.";
    saveLabel = "Save rules";
    const three = ["Hidden", "Optional", "Required"];
    fields = [
      { key: "products", label: "Product list", value: v("products", "Required"), select: ["Hidden", "Shown", "Required"], half: true },
      { key: "followDate", label: "Follow-up date", value: v("followDate", "Hidden"), select: three, half: true },
      { key: "payDate", label: "Payment promise date", value: v("payDate", "Optional"), select: three, half: true },
      { key: "payAmt", label: "Payment promise amount", value: v("payAmt", "Required"), select: three, half: true },
      { key: "cmpCat", label: "Complaint category", value: v("cmpCat", "Hidden"), select: three, half: true },
      { key: "orderDate", label: "Order date", value: v("orderDate", "Hidden"), select: three, half: true },
      { key: "notes", label: "Notes", value: v("notes", "Optional"), select: ["Optional", "Required"], half: true },
      {
        key: "effects", label: "Side effects", area: true,
        value: v("effects", "Creates an order · updates last order date · counts as connected"),
        help: "Creates an order · creates a reminder · creates or updates a complaint · updates last order, call or contact date · counts as attempted, connected or missed.",
      },
    ];
  } else if (kind === "notes") {
    title = record0 ? `Quick notes · ${record0.name}` : "Quick notes";
    sub = "Tappable in the Call Log for this outcome.";
    saveLabel = "Save notes";
    fields = [
      {
        key: "items", label: "Notes for this outcome", area: true,
        value: v("items", "Customer confirmed order\nRepeat order\nUrgent delivery\nRate accepted\nPayment on delivery"),
        help: "One per line, in display order. A manager can add a seasonal note here without a code change.",
      },
      { key: "max", label: "Maximum length", value: v("max", "1000"), half: true },
    ];
  } else if (kind === "createUser" || kind === "editUser") {
    const editing = kind === "editUser";
    title = editing ? "Edit user" : "Create user";
    sub = editing
      ? (user?.name ?? "")
      : "Accounts are created here — there is no sign-up. Set a password now and tell them to change it, or send a reset link from the row menu afterwards.";
    saveLabel = editing ? "Save user" : "Create the account";
    fields = [
      { key: "name", label: "Full name", value: v("name", user?.name ?? ""), placeholder: "Priya Sharma" },
      {
        key: "contact", label: "Work email", value: v("contact", user?.contact ?? ""), placeholder: "priya@mahek.in",
        help: editing
          ? "This is their sign-in. Changing it changes how they log in."
          : "The set-password link goes here. It expires in 30 minutes.",
      },
    ];
    if (editing) {
      fields.push(
        {
          key: "mobile", label: "Work number", value: v("mobile", user?.mobile ?? ""), half: true,
          help: "Also a sign-in — telecallers know their number, not their email.",
        },
        {
          key: "userRole", label: "Role", value: v("userRole", user?.designation ?? "Telecaller"), half: true,
          select: ["Telecaller", "Manager", "Accounts", "Admin"],
        },
      );
    }
    if (!editing) {
      fields.push(
        {
          key: "mobile", label: "Work number", value: v("mobile", ""), half: true,
          help: "Also a sign-in — telecallers know their number, not their email.",
        },
        {
          key: "userRole", label: "Role", value: v("userRole", "Telecaller"), half: true,
          select: ["Telecaller", "Manager", "Accounts", "Admin"],
        },
        {
          key: "password", label: "First password", value: v("password", ""),
          help: "Eight characters at least. They can change it from the sign-in screen, and a reset link is one click away in the row menu.",
        },
        {
          key: "apps", label: "Apps", value: v("apps", "crm"),
          select: registry.map((a) => a.id),
          help: "One app means MahekOne takes them straight in and hides the switcher. Two or more means they land on the launcher.",
        },
      );
    }
  } else if (kind === "deactivate" && user) {
    title = `Deactivate ${user.name}`;
    sub = "Their sessions end and MahekOne stops opening for them.";
    saveLabel = "Deactivate user";
    fields = [{ key: "reason", label: "Reason", value: v("reason"), area: true, placeholder: "Left the company on 31 Aug" }];
    // Said, not enforced: deactivating is reversible and a book with no owner
    // is visible on the console's own attention list, so blocking the action
    // behind a reassignment flow that does not exist would strand the leaver.
    if (user.customers) {
      blockers = [
        {
          line: `${user.name} holds ${user.customers} customers. Deactivating does not reassign them — they will sit in nobody's book until somebody is given them, and the Overview says so.`,
        },
      ];
    }
  } else if (kind === "delegate" && user) {
    title = `Delegate access · ${user.name}`;
    sub = "A dated grant so nothing quietly becomes permanent.";
    saveLabel = "Delegate";
    fields = [
      {
        key: "app", label: "App", value: v("app", registry[0].name),
        select: registry.map((a) => a.name),
      },
      { key: "from", label: "Starts", value: v("from", "2026-08-07"), half: true },
      { key: "until", label: "Ends", value: v("until", "2026-08-31"), half: true, help: "Required — this is what keeps it temporary." },
      { key: "why", label: "Why", value: v("why"), area: true, placeholder: "Covering Priya while she is on leave" },
    ];
  } else if (kind === "leave" && user) {
    title = `Mark ${user.name} on leave`;
    sub = "Their queue is covered rather than left to pile up.";
    saveLabel = "Mark on leave";
    fields = [
      { key: "from", label: "From", value: v("from", "2026-08-07"), half: true },
      { key: "until", label: "Until", value: v("until", "2026-08-20"), half: true },
      {
        key: "cover", label: "Covered by", value: v("cover", ""),
        select: ["—", ...users.filter((u) => u.status === "Active" && u.id !== user.id).map((u) => u.name)],
        help: "Leaving this empty means their reminders and follow-ups simply age.",
      },
    ];
  } else if (kind === "decline") {
    title = "Decline the request";
    sub = "The reason is shown to whoever asked, so they do not simply ask again.";
    saveLabel = "Decline request";
    fields = [{ key: "why", label: "Reason", value: v("why"), area: true, placeholder: "Dispatch data is not needed to work a collections list." }];
  } else if (kind === "registerApp") {
    const app = id ? registry.find((a) => a.id === id) : null;
    title = app ? "Edit registry entry" : "Register an app";
    sub = "The console reads its settings from the schema endpoint. No console change is needed.";
    saveLabel = app ? "Save entry" : "Register app";

    const name = v("name", app?.name ?? "");
    const status = v("status", app?.status ?? "Coming soon");
    const live = status === "Live";
    // Suggest a slug from the name, but only once there is a name to derive one
    // from — and never overwrite what somebody typed themselves.
    const slug = app ? app.id : (draft.slug ?? (name.trim() ? slugify(name) : ""));
    const route = v("route", app?.route ?? "");

    fields = [
      { key: "name", label: "App name", value: name, placeholder: "Dispatch" },
      { key: "short", label: "Short name", value: v("short", app?.short ?? ""), placeholder: "Dispatch", half: true },
      {
        key: "status", label: "Status", value: status, half: true,
        select: ["Live", "Coming soon", "Maintenance", "Retired"],
      },
      {
        key: "slug", label: "Slug", value: slug, placeholder: "dispatch", half: true,
        readOnly: !!app,
        help: app
          ? "Fixed once registered. Every access grant is a row against this slug, so changing it would orphan them all."
          : "Lowercase, hyphenated. It becomes the URL and the key every access grant is written against.",
        error: app ? undefined : (validateAppSlug(slug, registry.map((a) => a.id)) ?? undefined),
      },
      {
        key: "route", label: "Route or entry URL", value: route, placeholder: `/${slug || "dispatch"}`,
        help: "Where the launcher sends people. It must sit under the app's own slug.",
        error: validateAppRoute(route, slug, live) ?? undefined,
      },
      {
        key: "schema", label: "Configuration schema endpoint", value: v("schema", app?.schemaEndpoint ?? ""),
        placeholder: `/api/${slug || "dispatch"}/config/schema`,
        help: "Where the console fetches this app's settings definition.",
        error: validateAppEndpoint(v("schema", app?.schemaEndpoint ?? "")) ?? undefined,
      },
      {
        key: "write", label: "Configuration write endpoint", value: v("write", app?.writeEndpoint ?? ""),
        placeholder: `/api/${slug || "dispatch"}/config`,
        error: validateAppEndpoint(v("write", app?.writeEndpoint ?? "")) ?? undefined,
      },
      {
        key: "summary", label: "Summary endpoint", value: v("summary", app?.summaryEndpoint ?? ""),
        placeholder: `/api/${slug || "dispatch"}/summary`,
        help: "Where the launcher fetches the attention count and status line.",
        error: validateAppEndpoint(v("summary", app?.summaryEndpoint ?? "")) ?? undefined,
      },
      {
        key: "roles", label: "Role vocabulary", value: v("roles", app?.roles.join(", ") ?? ""), placeholder: "Dispatcher, Manager",
        help: "The roles this app understands. The console renders these options in People → Roles.",
      },
      {
        key: "desc", label: "Description", value: v("desc", app?.desc ?? ""), area: true,
        help: "Shown on the launcher's locked chip so people know what the app is.",
      },
    ];
  }

  const fieldError = fields.find((f) => f.error);
  const blocked = !!fieldError;

  return (
    <Drawer open onClose={onClose} label={title}>
      <DrawerHeader onClose={onClose}>
        <div className="text-lg font-semibold text-ink">{title}</div>
        {sub ? <div className="mt-0.5 text-[13px] text-muted">{sub}</div> : null}
      </DrawerHeader>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        <div className="flex flex-wrap gap-x-[4%] gap-y-3.5">
          {fields.map((f) => (
            <label key={f.key} className={cx("block", f.half ? "w-[48%]" : "w-full")}>
              <span className="mb-1 block text-xs font-medium tracking-[0.04em] text-muted uppercase">
                {f.label}
              </span>
              {f.rich ? (
                <RichTextEditor
                  value={f.value}
                  placeholder={f.placeholder}
                  onChange={(next) => setDraft((d) => ({ ...d, [f.key]: next }))}
                />
              ) : f.area ? (
                <VoiceTextarea
                  value={f.value}
                  onChange={set(f.key)}
                  onDictate={(v) => setDraft((d) => ({ ...d, [f.key]: v }))}
                  placeholder={f.placeholder}
                  invalid={!!f.error}
                  className="h-[180px] font-mono text-[13px]"
                />
              ) : f.select ? (
                <Select value={f.value} onChange={set(f.key)} className="w-full">
                  {f.select.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </Select>
              ) : (
                <Input
                  value={f.value}
                  onChange={set(f.key)}
                  placeholder={f.placeholder}
                  invalid={!!f.error}
                  disabled={f.readOnly}
                  className={f.readOnly ? "bg-canvas text-muted" : undefined}
                />
              )}
              {f.error ? (
                <span className="mt-1 block text-[13px] text-danger">{f.error}</span>
              ) : f.help ? (
                <span className="mt-1 block text-[13px] text-muted">{f.help}</span>
              ) : null}
            </label>
          ))}
        </div>

        {preview ? <MessagePreview name={preview.name} body={preview.body} /> : null}

        {blockers.length ? (
          <div className="mt-4 rounded-[4px] border border-danger-soft border-l-[3px] border-l-danger bg-danger-soft px-3.5 py-3">
            <div className="text-sm font-medium text-danger">Worth knowing first</div>
            <div className="mt-2 flex flex-col gap-2">
              {blockers.map((b) => (
                <div key={b.line} className="rounded-[4px] border border-danger-soft bg-surface px-3 py-2.5">
                  <div className="text-sm text-ink">{b.line}</div>
                  {b.cta && b.run ? (
                    <Button size="sm" variant="ghost" className="mt-2" onClick={b.run}>
                      {b.cta}
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <div className="flex flex-none items-center gap-2.5 border-t border-line px-5 py-3">
        {record0 ? (
          <Button
            variant="ghost"
            className="border-none text-danger"
            onClick={() => {
              archiveEntity(entityKind!, record0.id);
              onClose();
            }}
          >
            {record0.active ? "Archive" : "Restore"}
          </Button>
        ) : null}
        <span className="flex-1" />
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={blocked}
          title={
            blockers.length
              ? "Reassign their book first"
              : fieldError
                ? "Fix the flagged field first"
                : undefined
          }
          onClick={async () => {
            // Templates are the one collection with a write path today, so this
            // is a real save. Everything else records the intent locally and
            // says nothing that is not true.
            if (kind === "templates") {
              const result = await saveTemplate({
                id: id ?? undefined,
                name: v("name", record0?.name ?? ""),
                category: v("cat", record0?.cat ?? "payment_reminder"),
                body: v("body", record0?.body ?? ""),
                appliesTo: "personal",
              });
              notify(result.ok ? (result.message ?? "Template saved") : (result.error ?? "That did not save."));
              if (result.ok) onClose();
              return;
            }
            if (kind === "createUser") {
              const result = await createUser({
                name: v("name", ""),
                email: v("contact", ""),
                phone: v("mobile", "") || null,
                role: v("userRole", "Telecaller").toLowerCase() as
                  | "telecaller"
                  | "manager"
                  | "accounts"
                  | "admin",
                password: v("password", ""),
                apps: [v("apps", "crm")],
              });
              notify(result.ok ? (result.message ?? "Created") : result.error);
              if (result.ok) {
                onClose();
                router.refresh();
              }
              return;
            }

            if (kind === "editUser" && user) {
              const identity = await updateUserIdentity(user.id, {
                name: v("name", user.name),
                email: v("contact", user.contact),
                phone: v("mobile", user.mobile) || null,
              });
              if (!identity.ok) {
                notify(identity.error ?? "That did not save.");
                return;
              }
              const wanted = v("userRole", user.designation).toLowerCase();
              if (wanted !== user.designation.toLowerCase()) {
                const r = await setUserRole(
                  user.id,
                  wanted as "telecaller" | "manager" | "accounts" | "admin",
                );
                if (!r.ok) {
                  notify(r.error ?? "The role did not change.");
                  return;
                }
              }
              notify(identity.message ?? "Saved");
              onClose();
              router.refresh();
              return;
            }

            if (kind === "deactivate" && user) {
              const result = await setUserActive(user.id, false);
              notify(result.ok ? (result.message ?? "Deactivated") : (result.error ?? "That did not save."));
              if (result.ok) {
                onClose();
                router.refresh();
              }
              return;
            }

            // Everything with a write path returned above. What is left is a
            // collection the CRM does not expose a save for yet, and saying
            // "saved" would be the one thing this console must never do.
            notify(`${title} cannot be saved yet — nothing was changed.`);
            onClose();
          }}
        >
          {saveLabel}
        </Button>
      </div>
    </Drawer>
  );
}

/**
 * What the customer will actually read. Placeholders are resolved against one
 * real-looking account, because a template that reads well as `{customer}` can
 * still read badly as a name.
 */
function MessagePreview({ name, body }: { name: string; body: string }) {
  const resolved = body.replace(/\{([a-z]+)\}/g, (m, k: string) => SAMPLE[k] ?? m);
  return (
    <div className="mt-4">
      <div className="mb-1.5 text-xs font-medium tracking-[0.04em] text-muted uppercase">
        Preview against {name}
      </div>
      <div className="flex justify-end rounded-[6px] border border-line bg-canvas p-4">
        <div className="max-w-[320px] rounded-[6px_6px_2px_6px] border border-brand-softer bg-brand-soft px-3 py-2.5 text-[15px] leading-[22px] whitespace-pre-wrap text-ink">
          {resolved || " "}
        </div>
      </div>
      <div className={cx("mt-2 text-[13px]", body.length > 700 ? "text-warn-ink" : "text-muted")}>
        {body.length} characters{body.length > 700 ? " — long messages get skimmed" : ""}
      </div>
    </div>
  );
}

function isEntityKind(kind: string): boolean {
  // "products" is deliberately absent: the catalogue is edited on its own
  // screen against the database, not in a drawer against a fixture.
  return ["templates", "scripts", "help", "holidays", "rules", "notes"].includes(kind);
}
