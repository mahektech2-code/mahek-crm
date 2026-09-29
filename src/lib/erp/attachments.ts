import "server-only";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { attachments } from "@/db/schema";
import { listUserApps, listUserModules } from "@/lib/access";

/* ---------------------------------------------------------------------------
 * ERP attachments: which screen a file belongs to, who may open it, and
 * binding uploads to the record they were taken for.
 *
 * A file is read under the SCREEN its record lives on — a test photo by whoever
 * may open Purchase testing — and never under a customer's scope, because
 * none of these has a customer behind it that decides who should see it.
 * ------------------------------------------------------------------------- */

export type ErpParent = "erp_test" | "erp_purchase" | "erp_transport" | "erp_video";

/*
 * The screen each kind of file is read under. `complaint` is not an ERP parent
 * — it is the CRM's own — but the ERP's complaints screen decides complaints,
 * so its holders may open their files too (see `canRead`). The retired
 * `erp_request` files became the complaint's when 0184 carried them over.
 */
const SCREENS: Record<ErpParent | "complaint", string[]> = {
  erp_test: ["testing"],
  erp_purchase: ["register"],
  erp_transport: ["transport"],
  erp_video: ["videos"],
  complaint: ["requests", "myCustomers"],
};

export async function canReadErpAttachment(userId: string, parentType: string, parentId: string): Promise<boolean> {
  void parentId;
  const screens = SCREENS[parentType as ErpParent | "complaint"];
  if (!screens) return false;
  const apps = await listUserApps(userId);
  if (!apps.includes("erp")) return false;
  const held = (await listUserModules(userId, "erp")).map((m) => m.key);
  return screens.some((s) => held.includes(`erp.${s}`));
}

/**
 * Binds uploaded files to the record they were taken for, inside the record's
 * own transaction. Only files still unparented and uploaded by this person are
 * bound — an id typed into a request cannot claim somebody else's file.
 */
export async function bindErpFiles(
  tx: typeof db,
  ids: (string | null | undefined)[],
  parentType: ErpParent,
  parentId: string,
  userId: string,
): Promise<void> {
  const list = ids.filter((x): x is string => !!x);
  if (!list.length) return;
  await tx
    .update(attachments)
    .set({ parentType, parentId, updatedAt: new Date() })
    .where(and(inArray(attachments.id, list), isNull(attachments.parentId), eq(attachments.uploadedById, userId)));
}
