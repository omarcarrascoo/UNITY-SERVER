/**
 * Helpers for building A2A lifecycle events that an AgentExecutor publishes.
 *
 * Centralizing these keeps event shapes consistent across executors and is the
 * single place to adjust if the SDK's event contract shifts. Used by the stub
 * executors (Phase A Step 2) and the real ones (Steps 3 & 5).
 */
import { randomUUID } from 'crypto';
import type {
  Message,
  Task,
  TaskState,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
} from '@a2a-js/sdk';

/** Initial Task object, published once when a task is first seen. */
export function initialTask(taskId: string, contextId: string, userMessage: Message): Task {
  return {
    kind: 'task',
    id: taskId,
    contextId,
    status: { state: 'submitted', timestamp: new Date().toISOString() },
    history: [userMessage],
  };
}

/** A status transition. `final: true` ends the stream for terminal/paused states. */
export function statusUpdate(
  taskId: string,
  contextId: string,
  state: TaskState,
  final: boolean,
  note?: string,
): TaskStatusUpdateEvent {
  return {
    kind: 'status-update',
    taskId,
    contextId,
    status: {
      state,
      timestamp: new Date().toISOString(),
      ...(note
        ? { message: { kind: 'message', messageId: randomUUID(), role: 'agent', parts: [{ kind: 'text', text: note }] } }
        : {}),
    },
    final,
  };
}

/** A produced artifact (a diff, a result blob, a summary). */
export function artifactUpdate(
  taskId: string,
  contextId: string,
  artifactId: string,
  text: string,
  name?: string,
): TaskArtifactUpdateEvent {
  return {
    kind: 'artifact-update',
    taskId,
    contextId,
    artifact: {
      artifactId,
      ...(name ? { name } : {}),
      parts: [{ kind: 'text', text }],
    },
  };
}

/** Extract the first text part from an inbound message (delegation payloads). */
export function firstText(message: Message): string {
  return message.parts.find((p) => p.kind === 'text')?.text ?? '';
}
