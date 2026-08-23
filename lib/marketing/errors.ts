/**
 * A refusal that already knows its status code.
 *
 * Marketing's lib functions own the rules — which statuses app code may write,
 * that scheduling is not reachable, that a channel needs a login — so they are
 * also the only place that knows whether a refusal is the caller's fault (400),
 * a thing that is not there (404), or a state clash (409). Carrying the code on
 * the error means a route handler is three lines and never re-derives a
 * judgement it did not make.
 *
 * The message is always a sentence a person can act on. It is rendered to a
 * human with nothing in between.
 */
export class MarketingRequestError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "MarketingRequestError";
  }
}
