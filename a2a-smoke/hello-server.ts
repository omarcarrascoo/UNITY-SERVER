/**
 * A2A Phase A — Step 1 smoke test: the "dev-squad-like" SERVER process.
 * Stands up a real A2A JSON-RPC server over HTTP, streaming Task lifecycle events.
 * NOT brain-station code — throwaway. Mirrors the shape of the future startA2AServer helper.
 */
import express from 'express';
import { randomUUID } from 'crypto';
import { AGENT_CARD_PATH } from '@a2a-js/sdk';
import type { Message, Task, TaskStatusUpdateEvent, TaskArtifactUpdateEvent } from '@a2a-js/sdk';
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  type AgentExecutor,
  type RequestContext,
  type ExecutionEventBus,
} from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { helloAgentCard, HELLO_PORT } from './hello-card.js';

class HelloExecutor implements AgentExecutor {
  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage, task } = ctx;
    const greeting =
      userMessage.parts.find((p) => p.kind === 'text')?.text ?? '(no text)';

    // 1. Publish the initial task if it doesn't already exist.
    if (!task) {
      const initialTask: Task = {
        kind: 'task',
        id: taskId,
        contextId,
        status: { state: 'submitted', timestamp: new Date().toISOString() },
        history: [userMessage],
      };
      bus.publish(initialTask);
    }

    // 2. working
    const working: TaskStatusUpdateEvent = {
      kind: 'status-update',
      taskId,
      contextId,
      status: { state: 'working', timestamp: new Date().toISOString() },
      final: false,
    };
    bus.publish(working);

    // 3. an artifact (the "result")
    const artifact: TaskArtifactUpdateEvent = {
      kind: 'artifact-update',
      taskId,
      contextId,
      artifact: {
        artifactId: 'reply',
        name: 'reply.txt',
        parts: [{ kind: 'text', text: `Hello from the dev-squad process! You said: "${greeting}"` }],
      },
    };
    bus.publish(artifact);

    // 4. completed (final)
    const completed: TaskStatusUpdateEvent = {
      kind: 'status-update',
      taskId,
      contextId,
      status: { state: 'completed', timestamp: new Date().toISOString() },
      final: true,
    };
    bus.publish(completed);
    bus.finished();
  }

  cancelTask = async (_taskId: string, _bus: ExecutionEventBus): Promise<void> => {
    // no-op for the smoke test
  };
}

function buildMessage(text: string): Message {
  return { kind: 'message', messageId: randomUUID(), role: 'agent', parts: [{ kind: 'text', text }] };
}

const requestHandler = new DefaultRequestHandler(
  helloAgentCard,
  new InMemoryTaskStore(),
  new HelloExecutor(),
);

const app = express();
app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler }));
app.use('/a2a/jsonrpc', jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));

app.listen(HELLO_PORT, '127.0.0.1', () => {
  console.log(`🛰️  [hello-server] A2A server up on http://127.0.0.1:${HELLO_PORT}`);
  console.log(`🛰️  [hello-server] AgentCard at http://127.0.0.1:${HELLO_PORT}/${AGENT_CARD_PATH}`);
  // Touch buildMessage so it isn't dead code if execute changes; harmless.
  void buildMessage;
});
