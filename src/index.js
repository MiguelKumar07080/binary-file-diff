/**
 * Binary File Diff — public API.
 *
 * Exports the three operations this library performs:
 *   - computeDiff(source, target) -> Patch
 *   - applyPatch(source, patch)   -> target (a new Uint8Array)
 *   - serializePatch(patch)      -> Uint8Array (portable byte stream)
 *   - deserializePatch(bytes)    -> Patch
 *
 * The implementation lives in core.js. This file is a thin re-export so
 * consumers import from a single entry point.
 */
export {
  computeDiff,
  applyPatch,
  serializePatch,
  deserializePatch,
  createPatch,
  OP_COPY,
  OP_ADD,
} from './core.js';
