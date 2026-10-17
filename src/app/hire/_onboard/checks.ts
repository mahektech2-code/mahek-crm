/** Serializable tick-list rows shared by Induction and Provision. */
export type CheckItem = { kind: "asset" | "topic" | "setup"; group: string; item: string; label: string; done: boolean; serial: string | null; needsSerial: boolean; by: string | null; at: string | null };
export type CheckGroup = { key: string; label: string; items: CheckItem[] };
