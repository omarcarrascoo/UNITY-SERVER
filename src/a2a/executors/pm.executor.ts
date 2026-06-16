/**
 * PM AgentExecutor — hosted inside the `core` process.
 *
 * Phase A Step 2: STUB. Streams a trivial lifecycle so the PM server is reachable.
 * Step 5 wires the real orchestration: call planAutonomousRun, delegate the pilot
 * task to the Dev Squad over A2A, mirror events to unityStore, run the existing
 * commit/gate/review/integrate tail. See planning-docs/A2A_PHASE_A_DESIGN.md §7.2.
 *
 * Holds a RuntimeState ref (it lives in-process with Discord + the DB), so unlike
 * the Dev Squad it CAN reach brain-station internals directly.
 */
import type {
  AgentExecutor,
  RequestContext,
  ExecutionEventBus,
} from '@a2a-js/sdk/server';
import type { RuntimeState } from '../../runtime/state.js';
import { initialTask, statusUpdate, artifactUpdate, firstText } from '../shared/events.js';

export class PMExecutor implements AgentExecutor {
  constructor(private readonly runtime: RuntimeState) {}

  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage, task } = ctx;

    if (!task) bus.publish(initialTask(taskId, contextId, userMessage));
    bus.publish(statusUpdate(taskId, contextId, 'working', false, 'PM stub received objective.'));

    // TODO(Step 5): planAutonomousRun → delegate pilot task to Dev Squad via A2A
    // client → mirror lifecycle to unityStore → existing integration tail.
    bus.publish(
      artifactUpdate(
        taskId,
        contextId,
        'stub-ack',
        `PM stub. Objective: "${firstText(userMessage)}". Active project: ${this.runtime.getActiveProjectName()}. Orchestration wires in Step 5.`,
      ),
    );

    bus.publish(statusUpdate(taskId, contextId, 'completed', true));
    bus.finished();
  }

  cancelTask = async (_taskId: string, _bus: ExecutionEventBus): Promise<void> => {
    // TODO(Step 5): forward cancellation to the active run's AbortController.
  };
}
