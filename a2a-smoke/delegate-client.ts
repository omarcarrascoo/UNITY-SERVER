/**
 * Step-3 verification: send a REAL delegation to the Dev Squad and stream it.
 * Targets the throwaway repo at /tmp/a2a-test-repo. Makes real DeepSeek calls.
 * Throwaway — delete with a2a-smoke/ when Step 3 is signed off.
 */
import 'dotenv/config';
import { A2AClient } from '@a2a-js/sdk/client';
import type { MessageSendParams } from '@a2a-js/sdk';
import { encodeDelegation, parseResult, type DelegationPayload } from '../src/a2a/shared/delegation.js';
import { getProjectTree } from '../src/scanner.js';

const REPO = '/tmp/a2a-test-repo';
const BASE = 'http://127.0.0.1:5001';

async function main(): Promise<void> {
  const client = await A2AClient.fromCardUrl(`${BASE}/.well-known/agent-card.json`);
  console.log('🔌 connected to', (await client.getAgentCard()).name);

  const payload: DelegationPayload = {
    repoPath: REPO,
    userPrompt:
      'In src/greet.js, change the greeting so the function returns "Hi " + name instead of "Hello " + name. Keep everything else identical.',
    writeScope: ['src/greet.js'],
    projectTree: getProjectTree(REPO),
    projectMemory: null,
    figmaData: null,
    learnedPatterns: null,
    baselineFailures: null,
    projectName: 'a2a-test-repo',
    correlationRunId: 'verify-run',
    correlationTaskId: 'verify-task',
  };

  const params: MessageSendParams = { message: encodeDelegation(payload) };

  let result: ReturnType<typeof parseResult> | null = null;
  let terminal = '';

  for await (const event of client.sendMessageStream(params)) {
    if (event.kind === 'status-update') {
      const note = event.status.message?.parts.find((p) => p.kind === 'text')?.text;
      console.log(`   [${event.status.state}]${note ? ' ' + note.slice(0, 120) : ''}`);
      if (event.final) terminal = event.status.state;
    } else if (event.kind === 'artifact-update' && event.artifact.artifactId === 'result') {
      const text = event.artifact.parts.find((p) => p.kind === 'text')?.text ?? '{}';
      result = parseResult(text);
    }
  }

  console.log('\n--- terminal state:', terminal, '---');
  if (result) {
    console.log('commitMessage:', result.commitMessage);
    console.log('tokenUsage:', result.tokenUsage, '| iterations:', result.iterations);
    console.log('filesRead:', result.filesRead.join(', ') || '(none)');
  }

  process.exit(terminal === 'completed' && result ? 0 : 1);
}

main().catch((err) => {
  console.error('❌ delegate-client error:', err);
  process.exit(1);
});
