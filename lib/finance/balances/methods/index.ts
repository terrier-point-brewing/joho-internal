/**
 * Side-effect registration for the method layer.
 *
 * Order matters: providers must be registered before methods, because
 * registerMethod validates nothing about provider existence at import time but
 * runMethod resolves providers at execution time, and the conformance suite
 * asserts every declared step resolves. Importing the provider barrel first
 * keeps that assertion meaningful rather than order-dependent.
 *
 * Consumers write `import "@/lib/finance/balances/methods";` and then use
 * getMethod/listMethods/methodsFor from ./registry.
 */
import "../providers";
import "./definitions";
