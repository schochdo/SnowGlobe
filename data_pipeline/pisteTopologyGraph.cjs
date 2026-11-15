/**
 * Canonical entry point for Node scripts.
 * Re-exports the single source of truth implementation from src/utils/pisteTopologyGraph.ts.
 * Node 22+ natively executes TypeScript via the type stripping loader.
 */
const { classifySkiAreaTopology } = require('../src/utils/pisteTopologyGraph.ts');

module.exports = {
  classifySkiAreaTopology,
};
