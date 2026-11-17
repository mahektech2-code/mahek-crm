/* ---------------------------------------------------------------------------
 * WHO A PERSON IS — by id, never by the name they happen to carry today.
 *
 * Pure. Employees, accounts, the org chart and the remembered spellings go in;
 * answers come out. Nothing here reads a clock or a database.
 *
 * THE RULE THIS EXISTS TO HOLD: a name is a label, and labels change. Somebody
 * is renamed in HRMS, a sheet spells them differently, two people share one —
 * and every question answered by comparing name strings (whose manager is
 * this, which salesman is "Prakash", whose shops are these) quietly gives a
 * different answer the next morning. So:
 *
 *   1. An ACCOUNT (`users.id`) and an EMPLOYEE (`employees.id`) are the only
 *      identities. `users.employee_id` joins the two.
 *   2. The org chart is employee ids (`employee_reporting`), and a manager is
 *      read through those ids — never by matching the employee's name to the
 *      account's name.
 *   3. A NAME is only ever turned into a person ONCE, at the door (a sheet
 *      row, an old import), and only when exactly one person answers to it.
 *      Every spelling a person has ever carried is remembered
 *      (`person_name_aliases`), so a rename does not orphan what the sheet
 *      still calls them.
 *   4. A name nobody can be resolved from is NOT guessed. It stays text, and
 *      the caller keeps whatever it had.
 *
 * The fallback for an account nobody has linked to an employee yet is a
 * unique email, then a unique mobile, then — last, and only where it names
 * exactly one person on BOTH sides — the folded name. That last step is the
 * old behaviour, kept so an unlinked account is no worse off than it was;
 * linking it (Admin → Manage access, or `npm run employee:link`) is what
 * makes it rename-proof. The nightly `autoLinkAccounts` stores the email and
 * mobile matches for good; a name match is only ever SUGGESTED for a person to
 * confirm. An account marked `notEmployee` is never matched at all.
 * ------------------------------------------------------------------------- */

export type DirEmployee = {
  id: string;
  name: string;
  email: string | null;
  companyMobile: string | null;
  personalMobile: string | null;
  /** On the books: not inactive, not withdrawn from the sheet. */
  active: boolean;
};

export type DirAccount = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  employeeId: string | null;
  active: boolean;
  /** What the sheets call this account, where a person said so. */
  salesPersonName: string | null;
  /** An administrator said this account is not an employee: never guessed onto one. */
  notEmployee?: boolean;
};

export type DirAlias = { key: string; employeeId: string };
export type DirLink = { employeeId: string; managerId: string };

export type DirectoryInput = {
  employees: readonly DirEmployee[];
  accounts: readonly DirAccount[];
  links: readonly DirLink[];
  aliases?: readonly DirAlias[];
};

/** Trim, collapse whitespace, uppercase — the fold every sheet name is compared under. */
export function personKey(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ").toUpperCase();
}

function phoneKey(v: string | null | undefined): string | null {
  const d = (v ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : null;
}
function emailKey(v: string | null | undefined): string | null {
  const e = (v ?? "").trim().toLowerCase();
  return e.includes("@") ? e : null;
}

/** A multimap that remembers when a key names more than one thing. */
function addTo(map: Map<string, Set<string>>, key: string | null, id: string) {
  if (!key) return;
  const s = map.get(key) ?? new Set<string>();
  s.add(id);
  map.set(key, s);
}
function only(set: Set<string> | undefined): string | null {
  return set && set.size === 1 ? [...set][0]! : null;
}

export type HowLinked = "stored" | "email" | "mobile" | "name" | null;

export type Directory = {
  /** The employee an account IS: the stored link, else a unique strong match, else a unique name. */
  employeeOfAccount(userId: string): string | null;
  /** How `employeeOfAccount` knew — "name" is the weak one a person should replace with a link. */
  howLinked(userId: string): HowLinked;
  /** The ACTIVE account for an employee, if exactly one is. */
  accountOfEmployee(employeeId: string): string | null;
  /** The person a piece of text names, if exactly one does. Remembered spellings count. */
  employeeByName(text: string | null | undefined): string | null;
  /** Whether a piece of text names nobody, exactly one person, or several. */
  nameStatus(text: string | null | undefined): "none" | "one" | "many";
  /** Is this text one of the spellings this employee answers to — today's name, a remembered one, or a linked account's? Shared spellings count. */
  isSpellingOf(text: string | null | undefined, employeeId: string): boolean;
  /** Who else (other employees) answers to this text, today or in the past. */
  othersNamed(text: string | null | undefined, employeeId: string): string[];
  /** The account a piece of text names: through the employee it resolves to, or a unique account name. */
  accountByName(text: string | null | undefined): string | null;
  /** The org-chart manager of an employee. */
  managerOfEmployee(employeeId: string): string | null;
  /** An account's manager on the org chart: the manager's account where they hold one, and their CURRENT name either way. */
  managerOfAccount(userId: string): { userId: string | null; employeeId: string; name: string } | null;
  /** The manager of whoever a piece of text names. */
  managerOfName(text: string | null | undefined): { userId: string | null; employeeId: string; name: string } | null;
  /** Today's name for an employee or an account. */
  employeeName(employeeId: string): string | null;
  accountName(userId: string): string | null;
};

export function buildDirectory(input: DirectoryInput): Directory {
  const employees = new Map(input.employees.map((e) => [e.id, e]));
  const accounts = new Map(input.accounts.map((a) => [a.id, a]));
  const managerOf = new Map(input.links.map((l) => [l.employeeId, l.managerId]));

  /* Employee keys. Every employee is indexed whether or not they are on the
     books — a name shared with a leaver is still a name shared, and resolving
     it to the one who stayed would be a guess. */
  const empByEmail = new Map<string, Set<string>>();
  const empByMobile = new Map<string, Set<string>>();
  const empByName = new Map<string, Set<string>>();
  for (const e of input.employees) {
    addTo(empByEmail, emailKey(e.email), e.id);
    addTo(empByMobile, phoneKey(e.companyMobile), e.id);
    if (phoneKey(e.personalMobile) !== phoneKey(e.companyMobile)) addTo(empByMobile, phoneKey(e.personalMobile), e.id);
    addTo(empByName, personKey(e.name) || null, e.id);
  }

  /* Stored links first: an employee a person has linked is spoken for, and
     no inference may hand it to a second account. */
  const stored = new Map<string, string>();
  const claimed = new Map<string, Set<string>>();
  for (const a of input.accounts) {
    if (a.employeeId && employees.has(a.employeeId)) {
      stored.set(a.id, a.employeeId);
      addTo(claimed, a.employeeId, a.id);
    }
  }

  /* Accounts by name, for the unique-on-both-sides fallback. */
  const accByName = new Map<string, Set<string>>();
  for (const a of input.accounts) addTo(accByName, personKey(a.name) || null, a.id);

  const inferred = new Map<string, { employeeId: string; how: Exclude<HowLinked, "stored" | null> }>();
  const inferredClaims = new Map<string, Set<string>>();
  for (const a of input.accounts) {
    if (stored.has(a.id) || a.notEmployee) continue;
    let hit: { employeeId: string; how: "email" | "mobile" | "name" } | null = null;
    const em = only(empByEmail.get(emailKey(a.email) ?? ""));
    if (em) hit = { employeeId: em, how: "email" };
    if (!hit) {
      const ph = only(empByMobile.get(phoneKey(a.phone) ?? ""));
      if (ph) hit = { employeeId: ph, how: "mobile" };
    }
    if (!hit) {
      const k = personKey(a.name);
      const emp = only(empByName.get(k));
      // Unique on BOTH sides: one employee carries the name and one account does.
      if (emp && only(accByName.get(k)) === a.id) hit = { employeeId: emp, how: "name" };
    }
    if (hit && !claimed.has(hit.employeeId)) {
      inferred.set(a.id, hit);
      addTo(inferredClaims, hit.employeeId, a.id);
    }
  }
  /* Two accounts inferring one employee: neither gets it. */
  for (const [emp, ids] of inferredClaims) {
    if (ids.size > 1) for (const id of ids) inferred.delete(id);
    else void emp;
  }

  const employeeOfAccount = (userId: string) => stored.get(userId) ?? inferred.get(userId)?.employeeId ?? null;

  const accountsOfEmployee = new Map<string, Set<string>>();
  for (const a of input.accounts) {
    if (!a.active) continue;
    const e = employeeOfAccount(a.id);
    if (e) addTo(accountsOfEmployee, e, a.id);
  }

  /* Text → employee: today's names, every remembered spelling, and what each
     linked account is called (its name and its sheet name). A key that lands
     on two people resolves to nobody. */
  const textToEmployee = new Map<string, Set<string>>();
  for (const [k, ids] of empByName) for (const id of ids) addTo(textToEmployee, k, id);
  for (const al of input.aliases ?? []) if (employees.has(al.employeeId)) addTo(textToEmployee, personKey(al.key) || null, al.employeeId);
  for (const a of input.accounts) {
    const e = employeeOfAccount(a.id);
    if (!e) continue;
    addTo(textToEmployee, personKey(a.name) || null, e);
    addTo(textToEmployee, personKey(a.salesPersonName) || null, e);
  }

  const employeeByName = (text: string | null | undefined) => only(textToEmployee.get(personKey(text)));
  const holdersOf = (text: string | null | undefined) => textToEmployee.get(personKey(text)) ?? new Set<string>();

  const accountOfEmployee = (employeeId: string) => only(accountsOfEmployee.get(employeeId));

  const managerOfEmployee = (employeeId: string) => {
    const m = managerOf.get(employeeId);
    return m && m !== employeeId && employees.has(m) ? m : null;
  };

  const managerFrom = (employeeId: string | null) => {
    if (!employeeId) return null;
    const m = managerOfEmployee(employeeId);
    if (!m) return null;
    return { userId: accountOfEmployee(m), employeeId: m, name: employees.get(m)!.name };
  };

  return {
    employeeOfAccount,
    howLinked: (userId) => (stored.has(userId) ? "stored" : (inferred.get(userId)?.how ?? null)),
    accountOfEmployee,
    employeeByName,
    nameStatus(text) {
      const n = personKey(text) ? holdersOf(text).size : 0;
      return n === 0 ? "none" : n === 1 ? "one" : "many";
    },
    isSpellingOf: (text, employeeId) => Boolean(personKey(text)) && holdersOf(text).has(employeeId),
    othersNamed: (text, employeeId) => [...holdersOf(text)].filter((id) => id !== employeeId),
    accountByName(text) {
      const e = employeeByName(text);
      if (e) return accountOfEmployee(e);
      const k = personKey(text);
      const a = only(accByName.get(k));
      return a && accounts.get(a)?.active ? a : null;
    },
    managerOfEmployee,
    managerOfAccount: (userId) => managerFrom(employeeOfAccount(userId)),
    managerOfName: (text) => managerFrom(employeeByName(text)),
    employeeName: (id) => employees.get(id)?.name ?? null,
    accountName: (id) => accounts.get(id)?.name ?? null,
  };
}

/* ------------------------------------------------- a typed name → an account */

/** What a piece of text says about WHO, answered by account id or not at all. */
export type StaffMatch =
  | { userId: string; why: null }
  /** none: nobody answers to it · many: two or more people do · no-account: one person, but no single account of theirs. */
  | { userId: null; why: "none" | "many" | "no-account" };

/**
 * Turn a staff name into ONE account, never a guess.
 *
 * The directory first — today's name, any spelling the person has carried,
 * the name the sheets call them — and only where exactly one person answers.
 * `accountByName` answers with LIVE accounts; somebody who has left still
 * owns what they did, so a name that is one former employee resolves to the
 * single (switched-off) account linked to them by `users.employee_id`. Two
 * accounts on one employee is a question for a person, not for this.
 */
export function staffAccountOf(
  dir: Directory,
  accounts: ReadonlyArray<{ id: string; employeeId: string | null }>,
): (text: string | null | undefined) => StaffMatch {
  const byEmployee = new Map<string, string[]>();
  for (const a of accounts) if (a.employeeId) byEmployee.set(a.employeeId, [...(byEmployee.get(a.employeeId) ?? []), a.id]);
  return (text) => {
    if (!personKey(text)) return { userId: null, why: "none" };
    if (dir.nameStatus(text) === "many") return { userId: null, why: "many" };
    const live = dir.accountByName(text);
    if (live) return { userId: live, why: null };
    const emp = dir.employeeByName(text);
    if (!emp) return { userId: null, why: "none" };
    const theirs = byEmployee.get(emp) ?? [];
    return theirs.length === 1 ? { userId: theirs[0]!, why: null } : { userId: null, why: theirs.length ? "many" : "no-account" };
  };
}
