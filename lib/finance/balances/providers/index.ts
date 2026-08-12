/**
 * Side-effect registration for every balance provider.
 *
 * Each provider module registers itself with lib/finance/balances/registry.ts
 * at import time (`registerProvider(...)` at module load). Importing this
 * file -- and only this file -- from any consumer (snapshot service, API
 * routes, tests) guarantees every provider is registered before
 * getProvider/listProviders runs, without each consumer needing to know the
 * full list of provider modules. Mirrors lib/tax/parties/index.ts's shape.
 *
 * Add a new `import "./<module>";` line here whenever a new balance provider
 * module is added under lib/finance/balances/providers/.
 */
import "./accruals";
import "./transactionPostings";
import "./retainedEarnings";
import "./manualBalance";
import "./rampBalance";
import "./squareBalance";
import "./plaidBalance";
import "./inventoryOnHand";
