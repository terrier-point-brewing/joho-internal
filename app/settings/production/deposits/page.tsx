import DepositSettingsPanel from "@/app/production/components/DepositSettingsPanel";

// Section chrome (production nav + page header + settings sub-nav) now comes
// from the settings hub layout, so the page is just its panel.
export default function DepositSettingsPage() {
  return <DepositSettingsPanel />;
}
