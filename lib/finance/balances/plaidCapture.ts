/**
 * The Plaid half of the daily capture — the only place a stored bank credential
 * is actually used.
 *
 * Kept out of providers/plaidBalance.ts on purpose. That module is pulled in by
 * every consumer of the provider registry (the statement route, the settings
 * route, the snapshot cron); this one is reached only by the capture cron, so
 * the code path that reads a live bank token has exactly one caller.
 */
import { getAccountBalances, balanceToCents, isDepository } from "@/lib/plaid";
import type { BalanceReader } from "./dailyCapture";

/**
 * Current balance for the connection's linked Plaid account, in cents.
 *
 * `external_id` identifies WHICH account on the item this connection is for.
 * An item can carry several (a business checking plus a savings, say), and
 * `/accounts/balance/get` returns all of them, so picking by id is what stops
 * the wrong account's money landing on GL 1020. Falling back to "the first
 * account" would be silently wrong on exactly the multi-account items where it
 * matters.
 */
export const readPlaidBalance: BalanceReader = async (connection) => {
  const accessToken = connection.credentials.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new Error("no stored bank credential — reconnect this account");
  }
  if (!connection.externalId) {
    throw new Error("no bank account chosen for this connection");
  }

  const accounts = await getAccountBalances(accessToken);
  const account = accounts.find((a) => a.account_id === connection.externalId);
  if (!account) {
    // The account was removed at the bank, or the item was relinked and issued
    // new account ids. Either way an operator has to re-choose, so this must
    // not degrade to a nearby account.
    throw new Error("the linked bank account is no longer on this connection — reconnect it");
  }

  // Guard rather than assume. A credit account's `current` is the amount OWED,
  // reported positive; stored unchanged on an asset row it would show a debt as
  // cash. The method only offers itself on bank-section accounts, so reaching
  // this means the connection points somewhere unintended.
  if (!isDepository(account)) {
    throw new Error(`the linked account is a ${account.type} account, not a bank account`);
  }

  // Same refusal the Ramp provider makes, for the same reason: a non-USD
  // balance summed into a USD balance sheet would be wrong by whatever the
  // exchange rate happens to be, with nothing on screen to say so. An
  // unofficial currency (crypto and similar, where Plaid leaves the ISO field
  // null) fails this too, which is correct.
  const currency = account.balances.iso_currency_code;
  if (currency !== "USD") {
    throw new Error(`the bank reports this account in ${currency ?? "an unrecognised currency"}; only US dollars can be used`);
  }

  return balanceToCents(account);
};
