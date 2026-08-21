import { buildDeterministicFixtureSeed } from './delegate-deterministic-seed.js';

/**
 * Cross-process determinism probe.
 *
 * Builds the shared deterministic seed fixture in a fresh Node process and
 * prints its digest, so the unit test can prove the seed bytes do not depend on
 * process-local state such as Map iteration order or module load order.
 */
process.stdout.write(`${buildDeterministicFixtureSeed().sha256}\n`);
