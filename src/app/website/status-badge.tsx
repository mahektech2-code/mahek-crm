import { Badge, type Tone } from "@/components/ui/primitives";
import type { ContentStatus } from "./mock-data";

const TONE: Record<string, Tone> = {
  draft: "muted",
  published: "success",
  archived: "neutral",
  open: "success",
  closed: "neutral",
};

const LABEL: Record<string, string> = {
  draft: "Draft",
  published: "Published",
  archived: "Archived",
  open: "Open",
  closed: "Closed",
};

export function StatusBadge({ status }: { status: ContentStatus | "open" | "closed" }) {
  return <Badge tone={TONE[status] ?? "neutral"}>{LABEL[status] ?? status}</Badge>;
}
