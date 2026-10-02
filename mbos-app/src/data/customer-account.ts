import { all, getKv, one, setKv } from '../db';
import { customerAccount } from '../sync/api';
import { fromPhone, type AccountView } from '../engines/account-view';
import {
  ACCOUNT_SUMMARY_SQL,
  accountCountQuery,
  accountPageQuery,
  type AccountFilter,
  type AccountSort,
} from './customer-query';
import { billLines, customerBills, customerPayments, getCustomer, type Customer } from './customers';
import { isoDate } from '../lib/format';

/**
 * CUSTOMER ACCOUNTS — the Accounts app's customer account, on the handset.
 *
 * The list is the phone's own book and needs no signal: every figure on it is
 * the office's `outstandingPaise`, sent down the pull. Opening one asks the
 * office for the account in full (`/api/mbos/customer-account`) and keeps the
 * answer per shop in `kv`, so an account looked at this morning opens the same
 * way in a godown with no bars this afternoon — saying how old it is. An
 * account never opened online falls back on the thirteen months of bills and
 * receipts the pull keeps, put into the same shape by `fromPhone`.
 *
 * Three answers, never blended: today's from the office, the office's last
 * one remembered, or the phone's own window. The screen says which.
 */

export type AccountPage = { rows: Customer[]; total: number; hasMore: boolean };

export async function listAccountsPage(args: {
  query?: string;
  filter: AccountFilter;
  sort: AccountSort;
  offset?: number;
  limit?: number;
}): Promise<AccountPage> {
  const offset = args.offset ?? 0;
  const limit = args.limit ?? 40;
  const count = accountCountQuery(args.query, args.filter);
  const [totalRow, rows] = await Promise.all([
    one<{ n: number }>(count.sql, count.params),
    (async () => {
      const q = accountPageQuery({ ...args, offset, limit });
      return all<Customer>(q.sql, q.params);
    })(),
  ]);
  const total = totalRow?.n ?? 0;
  return { rows, total, hasMore: offset + rows.length < total };
}

export type BookMoney = {
  accounts: number;
  owedPaise: number;
  owing: number;
  over: number;
  blocked: number;
  syncedAt: number | null;
};

export async function bookMoney(): Promise<BookMoney> {
  const row = await one<BookMoney>(ACCOUNT_SUMMARY_SQL);
  return row ?? { accounts: 0, owedPaise: 0, owing: 0, over: 0, blocked: 0, syncedAt: null };
}

const KEY = (customerId: string) => `customerAccount:${customerId}`;

/** What the office last said, if it ever has. Instant, and works offline. */
export async function rememberedAccount(customerId: string): Promise<AccountView | null> {
  const raw = await getKv(KEY(customerId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as AccountView;
    return parsed && parsed.customer && Array.isArray(parsed.bills) ? parsed : null;
  } catch {
    return null;
  }
}

/** The account from the bills and receipts this phone holds. */
export async function phoneAccount(customerId: string): Promise<AccountView | null> {
  const [c, bills, receipts] = await Promise.all([
    getCustomer(customerId),
    customerBills(customerId),
    customerPayments(customerId),
  ]);
  if (!c) return null;
  return fromPhone(c, bills, receipts, isoDate(new Date()), billLines);
}

/**
 * Today's answer from the office, remembered for next time.
 *
 * `{ ok: false }` carries the office's own sentence: "not on your book" is a
 * different thing to be told than "no signal", and the screen says which.
 */
export async function freshAccount(
  customerId: string,
): Promise<{ ok: true; view: AccountView } | { ok: false; error: string }> {
  const answer = await customerAccount(customerId);
  if (!answer.ok) return { ok: false, error: answer.error };
  const view = { ...(answer.account as Omit<AccountView, 'source' | 'readAtMs'>), source: 'office', readAtMs: Date.now() } as AccountView;
  if (!view.customer || !Array.isArray(view.bills)) {
    return { ok: false, error: 'The office sent something this phone could not read.' };
  }
  /* Kept so the next open with no signal still has the full account. A
     failure to remember is not a failure to show. */
  await setKv(KEY(customerId), JSON.stringify(view)).catch(() => undefined);
  return { ok: true, view };
}
