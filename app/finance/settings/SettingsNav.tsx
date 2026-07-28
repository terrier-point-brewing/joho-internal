"use client";
import SubNav from "@/app/components/SubNav";
import { CAP } from "@/lib/auth/capabilities";

// Each subtab rides the `manage` face of the domain it configures — the same
// capability its own layout gates on and its own APIs enforce. They used to
// share one finance.statements gate that none of their APIs referenced.
const SUBTABS = [
  { href: "/finance/settings/chart-of-accounts", label: "Chart of Accounts", requires: CAP.financeTransactionsManage },
  { href: "/finance/settings/account-mapping",   label: "Account Mapping",   requires: CAP.financeTransactionsManage },
  { href: "/finance/settings/expense-accounts",  label: "Expense Accounts",  requires: CAP.financeTransactionsManage },
  { href: "/finance/settings/counterparty-accounts", label: "Counterparty Accounts", requires: CAP.financeTransactionsManage },
  { href: "/finance/settings/payroll-department-mappings", label: "Payroll Departments", requires: CAP.payrollManage },
  { href: "/finance/settings/tax-profile",       label: "Tax Profile",       requires: CAP.taxManage },
  { href: "/finance/settings/tax-filing",        label: "Tax Filing",        requires: CAP.taxFilingManage },
  { href: "/finance/settings/payroll",           label: "Payroll",           requires: CAP.payrollManage },
];

export default function SettingsNav() {
  return <SubNav entries={SUBTABS} />;
}
