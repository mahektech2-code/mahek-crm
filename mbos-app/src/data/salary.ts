import { all } from '../db';

/**
 * His own pay, read off the office's own figures.
 *
 * Read-only, like `performance` — HR maintains the salary columns in the
 * employee workbook and this app writes none of them. No incentive column:
 * MahekOne sets no monthly target for a field salesman, so a number computed
 * from one would be an invention on the one screen where a wrong figure is
 * least forgivable.
 */
export type SalaryMonth = {
  period: string;
  employeeCode: string | null;
  employeeStatus: string | null;
  netSalaryPaise: number | null;
  conveyancePaise: number | null;
  otherSalaryPaise: number | null;
  pfEsicApplicable: number | null;
  dateOfJoining: string | null;
  daysWorked: number | null;
  daysOnLeave: number | null;
  reimbursedPaise: number | null;
};

export async function listSalary(): Promise<SalaryMonth[]> {
  return all<SalaryMonth>('SELECT * FROM salary ORDER BY period DESC');
}
