/**
 * The one string naming a stated-balance override in
 * gl_account_balances.contributions.
 *
 * A leaf module with no imports on purpose. The balance sheet renders a marker
 * on any month carrying an override, so this name is needed in a CLIENT
 * component -- and importing it from methods/registry.ts would drag the whole
 * provider registry, and every integration client behind it, into the browser
 * bundle to learn a single constant.
 *
 * methods/registry.ts re-exports it, so server code can keep importing it from
 * the module that gives it meaning.
 */
export const STATED_BALANCE_KEY = "statedBalanceOverride";
