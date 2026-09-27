import { PageHeader } from "@/components/ui/primitives";

/* A page that is not a list: the CRM's page padding and header. There is no
   crumb above the title — the CRM draws none, and the sidebar already says
   where you are. */
export function Page({ title, sub, actions, children }: { title: string; sub?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="px-6 pt-6 pb-10">
      <PageHeader title={title} subtitle={sub} actions={actions} />
      {children}
    </div>
  );
}
