/* The register row as a screen receives it: plain, serialisable, no Dates.
   PURE — the client screens import the type; register-service builds it. */

import type { Status } from "./engine";
import type { TimeModel } from "./catalogue";

export type AssetLite = {
  id: string;
  code: string;
  title: string;
  category: string;
  typeCode: string;
  typeName: string;
  model: TimeModel;
  crit: number;
  status: Status;
  d: number | null;
  actionIn: number | null;
  endDate: string | null;
  actionDate: string | null;
  noticeDays: number;
  entityId: string | null;
  entityName: string | null;
  siteId: string | null;
  siteName: string | null;
  siteState: string | null;
  ownerId: string | null;
  ownerName: string | null;
  backupId: string | null;
  checkedAgo: number | null;
  unchecked: boolean;
  docNo: string;
  provider: string;
  live: boolean;
  consequence: string | null;
  leadDays: number;
  graceDays: number;
};
