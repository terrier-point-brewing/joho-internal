"use client";
import SubNav from "@/app/components/SubNav";

const TABS = [
  { href: "/finance/sales/taproom",          label: "Taproom"          },
  { href: "/finance/sales/events",           label: "Events"           },
  { href: "/finance/sales/contract-brewing", label: "Contract Brewing" },
  { href: "/finance/sales/distribution",     label: "Distribution"     },
  { href: "/finance/sales/wholesale",        label: "Wholesale"        },
];

export default function SalesNav() {
  return <SubNav entries={TABS} />;
}
