/**
 * Side-effect registration for every tax party template.
 *
 * Each party module registers itself with `@/lib/tax/registry` at import
 * time (`registerParty(...)` at module load). Importing this file — and only
 * this file — from any consumer (API routes, cron handlers, tests) guarantees
 * every supported party is registered before `getParty`/`listParties` runs,
 * without each consumer needing to know the full list of party modules.
 *
 * Add a new `import "./<partyDir>/template";` line here whenever a new party
 * template is added under `lib/tax/parties/`.
 */
import "./ncDorSalesUse/template";
import "./ncDorBeerExcise/template";
import "./wakeCountyFoodBeverage/template";
import "./wakeCountyBeerWine/template";
import "./ttbBeerExcise/template";
