/**
 * Internal public barrel for the plureslm-openclaw plugin.
 *
 * Per OpenClaw plugin conventions, internal modules import through this barrel
 * (and `./pluresdb.js`), never through `openclaw/plugin-sdk/plureslm`.
 */

export { PluresLmStore } from "./pluresdb.js";
export type {
  RecallHit,
  StoreStatus,
  PluresLmStoreOptions,
} from "./pluresdb.js";

// Test-only fixture seeder (routes through the same native binding resolver as
// the read path). Exported here so the cross-process recall gate can import it
// from the built `dist/api.js`. Not used by any runtime path.
export { seedStoreForTests } from "./pluresdb.js";

export {
  buildMemoryCapability,
  createPluresLmSearchManager,
} from "./memory-capability.js";
export type { PluresLmCapabilityConfig } from "./memory-capability.js";
