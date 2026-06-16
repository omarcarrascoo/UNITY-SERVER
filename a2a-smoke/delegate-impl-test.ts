/**
 * Step-5 verification: exercise the NEW executeTask branch unit (delegateImplementation)
 * directly against a live Dev Squad + /tmp repo. Confirms it returns the in-process
 * result shape, edits the file, and emits a token rollup. Real DeepSeek calls.
 * Throwaway.
 */
import 'dotenv/config';
import { delegateImplementation, isA2ADelegationEnabled } from '../src/a2a/delegate-implementation.js';
import { getTelemetryStore } from '../src/services/telemetry/telemetry-store.js';
import { getProjectTree } from '../src/scanner.js';

const REPO = '/tmp/a2a-impl-repo';
const RUN_ID = `verify-impl-run-${Date.now()}`;
const TASK_ID = `verify-impl-task-${Date.now()}`;

async function main(): Promise<void> {
  console.log('A2A_DELEGATE enabled?', isA2ADelegationEnabled());

  const result = await delegateImplementation({
    repoPath: REPO,
    userPrompt:
      'In src/util.js, rename the function double to triple and make it return n * 3 instead of n * 2. Update nothing else.',
    writeScope: ['src/util.js'],
    projectTree: getProjectTree(REPO),
    projectMemory: null,
    figmaData: null,
    learnedPatterns: null,
    baselineFailures: null,
    projectName: 'a2a-impl-repo',
    runId: RUN_ID,
    taskId: TASK_ID,
    onProgress: (m) => console.log('   ', m.slice(0, 80)),
  });

  console.log('\n--- ImplementationResult ---');
  console.log('commitMessage:', result.commitMessage);
  console.log('targetRoute:', result.targetRoute);
  console.log('tokenUsage:', result.tokenUsage, '| iterations:', result.iterations);
  console.log('filesRead:', result.filesRead.join(', ') || '(none)');
  console.log('toolHistory len:', result.toolHistory.length);

  // Assert the token rollup telemetry landed (core emitted it on the squad's behalf).
  const tasksCosts = getTelemetryStore().getTaskCosts(RUN_ID);
  const rollup = tasksCosts.find((t) => t.taskId === TASK_ID);
  console.log('\ntelemetry rollup for task:', rollup ? `${rollup.totalTokens} tokens` : '(none found)');

  const shapeOk =
    typeof result.commitMessage === 'string' &&
    typeof result.targetRoute === 'string' &&
    typeof result.tokenUsage === 'number' &&
    Array.isArray(result.filesRead) &&
    Array.isArray(result.toolHistory);

  const pass = shapeOk && result.tokenUsage > 0 && !!rollup;
  console.log(pass ? '\n✅ STEP 5 unit PASS' : '\n❌ STEP 5 unit FAIL');
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error('❌ delegate-impl-test error:', err);
  process.exit(1);
});
