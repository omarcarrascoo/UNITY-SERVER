/**
 * Compatibility shim.
 *
 * The entrypoint moved to a 2-process model in Phase A:
 *   - src/procs/core.ts       (Discord + HTTP panel + PM A2A server)
 *   - src/procs/dev-squad.ts  (Dev Squad A2A server)
 *
 * Running this file boots the `core` process so old commands (`tsx index.ts`)
 * still work. Prefer `npm run dev` to start both processes.
 */
import './src/procs/core.js';
