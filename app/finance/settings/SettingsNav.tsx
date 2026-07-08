"use client";
import SubNav from "@/app/components/SubNav";

const SUBTABS = [
  { href: "/finance/settings/chart-of-accounts", label: "Chart of Accounts" },
  { href: "/finance/settings/account-mapping",   label: "Account Mapping"   },
  { href: "/finance/settings/expense-accounts",  label: "Expense Accounts"  },
  { href: "/finance/settings/excise-tax",        label: "Excise Tax"        },
  { href: "/finance/settings/payroll",           label: "Payroll"           },
];

export default function SettingsNav() {
  return <SubNav entries={SUBTABS} />;
}
