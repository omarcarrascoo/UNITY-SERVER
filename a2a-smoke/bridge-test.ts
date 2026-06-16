/**
 * Step-4 verification: delegate via the real client, pipe through the task-bridge,
 * then read unityStore back to prove events were mirrored. Real DeepSeek calls.
 * Uses a synthetic runId/taskId (events/artifacts tables have no FK constraints).
 * Throwaway — delete with a2a-smoke/ when Phase A is done.
 */
import 'dotenv/config';
import { sendDelegation } from '../src/a2a/clients/dev-squad.client.js';
import { bridgeDelegationStream } from '../src/a2a/shared/task-bridge.js';
import { unityStore } from '../src/runtime/services.js';
import { getProjectTree } from '../src/scanner.js';
import type { DelegationPayload } from '../src/a2a/shared/delegation.js';

const REPO = '/tmp/a2a-bridge-repo';
const RUN_ID = `verify-bridge-run-${Date.now()}`;
const TASK_ID = `verify-bridge-task-${Date.now()}`;

async function main(): Promise<void> {
  const payload: DelegationPayload = {
    repoPath: REPO,
    userPrompt:
      'In src/calc.js, change the add function so it returns a + b + 0 (keep behavior identical, just add "+ 0"). Touch nothing else.',
    writeScope: ['src/calc.js'],
    projectTree: getProjectTree(REPO),
    projectMemory: null,
    figmaData: null,
    learnedPatterns: null,
    baselineFailures: null,
    projectName: 'a2a-bridge-repo',
    correlationRunId: RUN_ID,
    correlationTaskId: TASK_ID,
  };

  console.log('📨 delegating + bridging into unityStore...');
  const stream = await sendDelegation(payload);
  const outcome = await bridgeDelegationStream(stream, {
    runId: RUN_ID,
    taskId: TASK_ID,
    onProgress: (m) => console.log('   progress:', m.slice(0, 80)),
  });

  console.log('\n--- bridge outcome ---');
  console.log('terminalState:', outcome.terminalState);
  console.log('result.commitMessage:', outcome.result?.commitMessage ?? '(none)');

  // Read back what the bridge wrote — this is the actual Step-4 assertion.
  const events = unityStore.listEventsByRun(RUN_ID);
  const artifacts = unityStore.listArtifactsByRun(RUN_ID);
  console.log('\n--- unityStore read-back for', RUN_ID, '---');
  console.log('events mirrored:', events.length);
  for (const e of events.slice(0, 8)) console.log(`   [${e.level}] ${e.type}: ${e.message.slice(0, 70)}`);
  console.log('artifacts mirrored:', artifacts.length, '→', artifacts.map((a) => a.type).join(', '));

  const sawSubmitted = events.some((e) => e.type === 'a2a.task.submitted');
  const sawCompleted = events.some((e) => e.type === 'a2a.status.completed');
  const sawResultArtifact = artifacts.some((a) => a.type === 'a2a:result');

  const pass = outcome.terminalState === 'completed' && sawSubmitted && sawCompleted && sawResultArtifact && events.length >= 3;
  console.log(pass ? '\n✅ STEP 4 PASS — lifecycle mirrored to unityStore.' : '\n❌ STEP 4 FAIL');
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error('❌ bridge-test error:', err);
  process.exit(1);
});
