import PageHeader from "@/app/components/PageHeader";
import ThemeToggle from "@/app/components/brand/ThemeToggle";
import BrandChromeToggle from "@/app/components/brand/BrandChromeToggle";

/**
 * Appearance settings — the theme (light/dark/system) and brand-skin controls,
 * moved here from the Brand area header. No client state of its own: both
 * toggles are self-contained client components (cookie / system_settings).
 */
export default function AppearanceSettings({
  isAdmin,
  brandChromeEnabled,
}: {
  isAdmin: boolean;
  brandChromeEnabled: boolean;
}) {
  return (
    <div className="p-4 sm:p-6 max-w-md">
      <PageHeader title="Appearance" description="Theme and skin for the internal app." />

      <div className="flex flex-col gap-4 mt-4">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-secondary">Theme</span>
          <div>
            <ThemeToggle />
          </div>
          <p className="text-xs text-muted">
            Light/dark for the brand surfaces — and, when the brand skin is on, the whole
            internal app. Saved per browser.
          </p>
        </div>

        {isAdmin && (
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-secondary">Brand skin</span>
            <div>
              <BrandChromeToggle initialEnabled={brandChromeEnabled} />
            </div>
            <p className="text-xs text-muted">
              Apply the Joho brand palette to the whole internal app, for all users. Off uses
              the default ops theme.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
