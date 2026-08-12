/**
 * The Ramp-card half of the daily capture.
 *
 * Sits beside plaidCapture.ts and exists for the same reason: Ramp's card
 * balance endpoint answers only about right now, so a month-end figure exists
 * only if something recorded it on the day. The treasury feed needs none of
 * this, which is why the two Ramp connections are separate providers -- see
 * methods/registry.ts's ConnectionProvider.
 *
 * Deliberately thin. The read itself, and with it the sign flip and the
 * currency refusal, lives in providers/rampCardBalance.ts so that the capture,
 * the snapshot and the connect-time check all exercise one implementation. A
 * second copy here is how the sign ends up flipped in one path and not the
 * other, which no test that mocks the API would ever catch.
 */
import { readRampCardBalance } from "./providers/rampCardBalance";
import type { BalanceReader } from "./dailyCapture";

/**
 * Today's Ramp card balance in internal-convention cents (negative -- it is a
 * liability), for recording against the accounts this connection feeds.
 *
 * Throws rather than returning null on a failed read: captureDailyBalances
 * treats both as a failed capture, but a thrown message reaches the
 * connection's status line and its generic "the source returned no balance"
 * does not.
 */
export const captureRampCardBalance: BalanceReader = async (connection) => {
  const result = await readRampCardBalance(connection);
  if (!result.ok) throw new Error(result.reason);
  return result.owedCents;
};
