/**
 * Task-bridge: mirror A2A lifecycle events from a delegation stream into the
 * `core`-owned unityStore, so the existing HTTP panel reflects work that ran in
 * the Dev Squad process. Runs ONLY in `core` (the SQLite owner).
 *
 * Join key: A2A `contextId` === brain-station `runId`. The A2A `taskId` is the
 * stream's own id; we attribute events to the brain-station task via `taskId`
 * passed by the caller (the PM knows which TaskRecord it delegated).
 *
 * See planning-docs/A2A_PHASE_A_DESIGN.md §8.
 */
import type { A2AClient } from '@a2a-js/sdk/client';
import type { Message, Task, TaskStatusUpdateEvent, TaskArtifactUpdateEvent } from '@a2a-js/sdk';
import { unityStore } from '../../runtime/services.js';
import { createEntityId } from '../../shared/ids.js';
import { parseResult, type DelegationResult } from './delegation.js';

type StreamEvent = Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent;

export interface BridgeOptions {
  /** brain-station run id (=== A2A contextId we expect). */
  runId: string;
  /** brain-station task id to attribute mirrored events to. */
  taskId: string;
  /** Optional human-facing progress callback (e.g. Discord thread). */
  onProgress?: (message: string) => void | Promise<void>;
}

export interface BridgeOutcome {
  /** Terminal A2A state: 'completed' | 'failed' | 'canceled' | ... */
  terminalState: string | null;
  /** Parsed Dev Squad result, if a 'result' artifact arrived. */
  result: DelegationResult | null;
}

function firstText(parts: Array<{ kind: string; text?: string }>): string {
  return parts.find((p) => p.kind === 'text')?.text ?? '';
}

/**
 * Consume a delegation event stream, mirror it into unityStore, and resolve the
 * outcome (terminal state + parsed result). Does not throw on agent failure —
 * it returns the terminal state so the caller decides retry/integration.
 */
export async function bridgeDelegationStream(
  stream: AsyncGenerator<StreamEvent, void, undefined>,
  opts: BridgeOptions,
): Promise<BridgeOutcome> {
  const { runId, taskId, onProgress } = opts;
  let terminalState: string | null = null;
  let result: DelegationResult | null = null;

  for await (const event of stream) {
    switch (event.kind) {
      case 'task': {
        unityStore.addEvent(
          createEntityId('event'), runId, taskId, 'info',
          'a2a.task.submitted', `Dev Squad accepted task (a2a:${event.id}).`,
          { a2aTaskId: event.id, state: event.status.state },
        );
        break;
      }

      case 'status-update': {
        const note = firstText(event.status.message?.parts ?? []);
        const state = event.status.state;
        const level = state === 'failed' ? 'error' : 'info';
        unityStore.addEvent(
          createEntityId('event'), runId, taskId, level,
          `a2a.status.${state}`, note || `Dev Squad → ${state}`,
          { final: event.final },
        );
        if (note && onProgress) await onProgress(note);
        if (event.final) terminalState = state;
        break;
      }

      case 'artifact-update': {
        const text = firstText(event.artifact.parts as Array<{ kind: string; text?: string }>);
        if (event.artifact.artifactId === 'result') {
          try {
            result = parseResult(text);
          } catch {
            // leave result null; non-result artifacts are stored as-is below
          }
        }
        unityStore.addArtifact(
          createEntityId('artifact'), runId, taskId,
          `a2a:${event.artifact.artifactId}`, text, null,
          { name: event.artifact.name ?? null },
        );
        break;
      }

      case 'message': {
        const text = firstText(event.parts);
        if (text) {
          unityStore.addEvent(
            createEntityId('event'), runId, taskId, 'info',
            'a2a.message', text,
          );
        }
        break;
      }
    }
  }

  return { terminalState, result };
}
