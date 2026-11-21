import type { ErpPower } from "../erp/powers";
import type { HrmsPower } from "../hrms/powers";
import type { TaskPower } from "../tasks/permissions";
import type { Owner } from "./action-owners";

/* ---------------------------------------------------------------------------
 * THE ERP'S, HRMS'S AND TASKS' OWN POWERS, AS TICKS ON THEIR SCREENS.
 *
 * Those three apps grew powers of their own beside the level — ticked one by
 * one under the app in the old dialog. Under the screen model each becomes
 * the screen it is used on, at Edit or Delete:
 *
 *   - A decision is Edit on the screen where it is taken (approving a
 *     purchase order is Edit on Purchase orders); undoing one or writing
 *     something off is Delete there.
 *   - SEEING MONEY OR A SENSITIVE FIELD comes with Edit on the screen that
 *     shows it — whoever may edit purchases sees their rates. Signed off:
 *     nobody sees cost without being able to edit where it is shown.
 *   - "EVERYBODY'S" — everyone's performance, anyone's tasks — is the
 *     Everyone position, the third beside Associate and Manager, plus the
 *     screen it is read or changed on.
 *
 * `Record`s over every power, so one added to an app fails the build here
 * until it is placed. Powers that land on the same screen at the same tick
 * now travel together; `permissions.test.ts` pins exactly which.
 * ------------------------------------------------------------------------- */

const e = (screen: string): Owner => ({ screen, tick: "edit" });
const d = (screen: string): Owner => ({ screen, tick: "delete" });
const a = (screen: string): Owner => ({ screen, tick: "access" });
const all = (o: Owner): Owner => ({ ...o, position: "everyone" });

export const ERP_POWER_OWNERS: Record<ErpPower, Owner[]> = {
  viewPurchaseMoney: [e("erp.register"), e("erp.purchaseOrders")],
  viewCost: [e("erp.stock"), e("erp.sfgBatches")],
  viewSalesRate: [e("erp.orders")],
  viewSalesAmounts: [e("erp.orders")],
  verifyTest: [e("erp.testing")],
  verifyPurchase: [e("erp.register")],
  reopenPurchase: [d("erp.register")],
  purchaseBuyer: [e("erp.requisitions")],
  approvePurchaseOrder: [e("erp.purchaseOrders")],
  lostStock: [d("erp.stock")],
  customerStatus: [e("erp.customers")],
  approveParty: [e("erp.orderHub")],
  verifyOrders: [e("erp.underProcess")],
  productionCheck: [e("erp.mrpCheck")],
  editOrders: [e("erp.orders")],
  checkInvoices: [e("erp.dispatchRegister")],
  decideRequests: [e("erp.requests")],
  employeeAdmin: [e("erp.godowns")],
  approveSfgQc: [e("erp.sfgBatches")],
  dispatchOverride: [d("erp.dispatch")],
  stockControl: [e("erp.stockCheck")],
  scrapSale: [e("erp.scrapSales")],
  scrapAccounts: [d("erp.scrapSales")],
  scrapApprove: [e("erp.emptyDrums")],
  returnApprove: [e("erp.vendorReturns"), e("erp.customerReturns")],
  returnQc: [d("erp.customerReturns")],
  approveMoney: [e("erp.expenses")],
};

export const HRMS_POWER_OWNERS: Record<HrmsPower, Owner[]> = {
  hr: [e("hrms.employees")],
  markStaff: [e("hrms.attendance")],
  checkoutStaff: [e("hrms.attendance")],
  onBehalf: [e("hrms.leave")],
  editAtt: [d("hrms.attendance")],
  import: [e("hrms.offices")],
  approveLeave: [e("hrms.leave")],
  split: [e("hrms.leave")],
  entitle: [d("hrms.leave")],
  aadhaar: [d("hrms.employees")],
  payroll: [e("hrms.payroll")],
  pay: [d("hrms.payroll")],
  advance: [d("hrms.payroll")],
  verifyExp: [e("hrms.payroll")],
  tasksAdmin: [all(e("hrms.home"))],
  perfAdmin: [all(a("hrms.kpi"))],
  salesAll: [all(a("hrms.kpi"))],
  journeyAnyone: [all(e("hrms.org"))],
  custStatus: [e("hrms.home")],
  resolve: [e("hrms.help")],
  timings: [e("hrms.offices")],
  admin: [d("hrms.settings")],
};

export const TASK_POWER_OWNERS: Record<TaskPower, Owner[]> = {
  seeAll: [all(a("tasks.team"))],
  giveAnyone: [all(e("tasks.team"))],
  manageAnyone: [all(d("tasks.team"))],
  automations: [e("tasks.setup")],
};
