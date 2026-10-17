import { sql, type SQL } from "drizzle-orm";

/**
 * Which HRMS employee an account is — the ONE place that question is answered.
 *
 * It is asked by the Sales Dashboard's Salary screen, by the MBOS bootstrap
 * that puts the same figures on a handset, and by the Access screen that shows
 * an employee code beside an account. Three copies of a rule about somebody's
 * PAY is how two screens come to quote one person two different salaries, so
 * it is written here and imported.
 *
 * **The explicit link wins; the old guess is the fallback.** `users.employeeId`
 * is somebody's deliberate answer and is trusted outright. Where it is null the
 * email-or-company-mobile guess still runs, exactly as it did before the column
 * existed — which is what let the column ship without moving a figure on any
 * screen. It is only ever a guess: 56 of the 71 employees on the real book
 * carry no email at all, and the accounts are `@mahek.in` while the sheet holds
 * personal addresses, so on this book it matches almost nobody.
 *
 * The two halves are mutually exclusive by construction. Written as a plain
 * `or` the guess would still fire on a linked account, and where an account is
 * linked to one employee while its email matches another — which is not
 * hypothetical on a book carrying two rows for one person — the join would
 * return BOTH and the salary screen would show the person twice.
 */
export function employeeJoinOn(u = "u", e = "e"): SQL {
  return sql`
    (${sql.raw(u)}.employee_id is not null and ${sql.raw(e)}.id = ${sql.raw(u)}.employee_id)
    or (
      ${sql.raw(u)}.employee_id is null
      and (
        (${sql.raw(e)}.email is not null and ${sql.raw(u)}.email is not null
         and lower(${sql.raw(e)}.email) = lower(${sql.raw(u)}.email))
        or (${sql.raw(e)}.company_mobile is not null and ${sql.raw(u)}.phone is not null
            and ${sql.raw(e)}.company_mobile = ${sql.raw(u)}.phone)
      )
    )
  `;
}

/**
 * Whether the row that came back was CHOSEN or merely matched.
 *
 * A salary screen that cannot say which is which invites the reader to trust a
 * guess as far as they trust an answer. The Access screen prints it, and it is
 * what tells an admin which accounts still need linking.
 */
export function employeeLinkKindSql(u = "u"): SQL {
  return sql`case when ${sql.raw(u)}.employee_id is not null then 'linked' else 'guessed' end`;
}

/**
 * The HRMS employee an account is, as ONE row — a `left join lateral` to put
 * after `from users u`, exposing the employee's columns under alias `e`.
 *
 * `employeeJoinOn` keeps the linked and guessed halves apart, but the guess
 * can still match two rows by itself: one employee by email and another by
 * company mobile, or one person listed twice on the sheet. As a plain join
 * that put the account on the screen twice — Bharat Singh appeared twice on
 * the Sales Dashboard's Cost and return screen, each copy carrying a
 * different salary. Asked as a lateral with `limit 1`, an account is always
 * one row. The tie is broken in the order a person would trust: the explicit
 * link, then an email match, then the mobile, then an ACTIVE employee over a
 * leaver.
 */
export function employeeLateral(u = "u", e = "e"): SQL {
  const U = sql.raw(u);
  return sql`
    left join lateral (
      select emp.*
        from employees emp
       where ${employeeJoinOn(u, "emp")}
       order by (${U}.employee_id is not null and emp.id = ${U}.employee_id) desc,
                (emp.email is not null and lower(emp.email) = lower(${U}.email)) desc,
                (emp.status = 'active') desc,
                emp.id
       limit 1
    ) ${sql.raw(e)} on true
  `;
}
