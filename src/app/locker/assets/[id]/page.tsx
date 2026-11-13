import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import { lockerAccess } from "@/lib/locker/access";
import { CATEGORY, categoryModuleSlug, type TimeModel } from "@/lib/locker/catalogue";
import { assetDetail, toLite } from "@/lib/locker/register-service";
import { lockerEntitiesList, lockerSitesList } from "@/lib/locker/service";
import { stampIst } from "@/lib/locker/style";
import { AssetScreen, type AssetVM } from "./asset-screen";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  return { title: "Asset" };
}

export default async function AssetPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const user = await requireUser();
  const [{ id }, { tab }] = await Promise.all([params, searchParams]);
  const access = await lockerAccess(user.id);
  if (!access.categories.length) await requireModule(user.id, "locker.assets");
  const d = await assetDetail(user.id, id);
  if (!d) {
    /* Somebody without this category lands where their own modules start, not on a page that admits the asset exists. */
    notFound();
  }
  if (!access.catOk(d.asset.category)) await requireModule(user.id, `locker.cat.${categoryModuleSlug(d.asset.category)}`);
  const [entities, sites] = await Promise.all([lockerEntitiesList(), lockerSitesList()]);
  const a = d.asset;
  const vm: AssetVM = {
    lite: toLite(a),
    categoryName: CATEGORY[a.category]?.name ?? a.category,
    stage: a.stage,
    issuedOn: a.issuedOn,
    conditions: a.conditions,
    physicalLocation: a.physicalLocation,
    custodianId: a.custodianId,
    custodianName: d.custodianName,
    externalContact: a.externalContact,
    department: a.department,
    approverId: a.approverId,
    approverName: d.approverName,
    executorId: a.executorId,
    executorName: d.executorName,
    backupName: a.backupName,
    amountPaise: a.amountPaise,
    billingCycle: a.billingCycle,
    autoRenew: a.autoRenew,
    seats: a.seats,
    extra: a.extra,
    paymentMethod: d.paymentMethod ? { id: d.paymentMethod.id, label: d.paymentMethod.label, last4: d.paymentMethod.last4, expiresOn: d.paymentMethod.expiresOn } : null,
    paymentMethodId: a.paymentMethodId,
    type: {
      code: a.type.code,
      name: a.type.name,
      category: a.type.category,
      model: a.model as TimeModel,
      validityMonths: a.type.validityMonths,
      leadDays: a.type.leadDays,
      graceDays: a.type.graceDays,
      criticality: a.type.criticality,
      authority: a.type.authority,
      fields: a.type.fields,
      steps: a.type.steps,
      typicalCostPaise: a.type.typicalCostPaise,
    },
    ladder: d.ladder,
    newer: d.newer ? { id: d.newer.id, code: d.newer.code } : null,
    older: d.older.map((o) => ({ id: o.id, code: o.code, docNo: o.docNo, endDate: o.endDate })),
    openRenewal: d.openRenewal ? { id: d.openRenewal.id, step: d.openRenewal.step, done: d.openRenewal.checklist.filter((c) => c.done).length, total: d.openRenewal.checklist.length, ackNo: d.openRenewal.ackNo, assignedName: d.openRenewal.assignedName } : null,
    history: d.history.map((h) => ({ when: h.completedAt ? stampIst(h.completedAt) : "", docNo: h.newDocNo ?? "", cost: h.costPaise, by: h.assignedName ?? "" })),
    docs: d.docs.map((x) => ({ id: x.id, filename: x.filename, sizeBytes: x.sizeBytes, contentType: x.contentType, uploadedAt: stampIst(x.uploadedAt), by: x.by ?? "", hash: x.hash, current: x.current, assetId: x.assetId })),
    creds: d.creds.map((c) => ({ id: c.id, title: c.title, tier: c.tier, auth: c.auth, sole: c.sole, viaEmail: c.viaEmail, hint: c.hint, rotated: c.lastRotatedAt ? stampIst(c.lastRotatedAt) : null, lastReveal: c.lastReveal ? `${stampIst(c.lastReveal.at)} by ${c.lastReveal.by}` : null })),
    reliesOnThis: d.reliesOnThis.map(toLite),
    activity: d.activity.map((x) => ({ at: stampIst(x.at), who: x.who, t: x.t })),
    people: d.people.map((p) => ({ id: p.id, name: p.name, title: p.title, code: p.code })),
    pms: d.paymentMethods.map((p) => ({ id: p.id, label: p.label, last4: p.last4, expiresOn: p.expiresOn })),
    entities: entities.filter((e) => e.active).map((e) => ({ id: e.id, name: e.name, gstin: e.gstin })),
    sites: sites.filter((s) => s.active).map((s) => ({ id: s.id, name: s.name })),
    vault: access.vault,
    canEdit: d.canEdit,
    today: d.day,
  };
  return <AssetScreen vm={vm} initialTab={tab ?? "details"} />;
}
