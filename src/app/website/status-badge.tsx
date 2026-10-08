import { Badge, type Tone } from "@/components/ui/primitives";
import type { Status } from "./mock-data";

const TONE: Record<Status, Tone> = {
  published: "success",
  draft: "warn",
  archived: "muted",
};

const LABEL: Record<Status, string> = {
  published: "Published",
  draft: "Draft",
  archived: "Archived",
};

export function StatusBadge({ status }: { status: Status }) {
  return <Badge tone={TONE[status]}>{LABEL[status]}</Badge>;
}
