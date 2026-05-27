import { createAgentToolRuntime } from '../../tools.js';
import { buildSystemPrompt } from './prompt-builder.js';
import { applyEditsToFiles, getDirsToCheck, parseJsonObject } from './edit-operations.js';
import {
  getCurrentGitDiff,
  getNewCompilationErrors,
  runTypecheckForDirs,
} from './validation-service.js';
import {
  evaluateLoopControl,
  isFatalRuntimeError,
  isFatalToolError,
} from './loop-heuristics.js';
import { roleCompletion } from './completion.js';
import { telemetry } from '../telemetry/index.js';
import type { LLMMessage } from './providers/types.js';
import type { AIResponse, GenerateCodeParams } from './types.js';

export async function generateAndWriteCode({
  repoPath,
  userPrompt,
  figmaData,
  projectTree,
  projectMemory,
  currentDiff,
  onStatusUpdate,
  onThinking,
  signal,
  runId,
  taskId,
  projectName,
  learnedPatterns,
  architectContext,
}: GenerateCodeParams): Promise<{ targetRoute: string; commitMessage: string; tokenUsage: number; iterations: number; toolHistory: string[]; filesRead: string[] }> {
  const toolRuntime = createAgentToolRuntime(repoPath);
  const messages: LLMMessage[] = [
    {
      role: 'system',
      content: buildSystemPrompt({
        userPrompt,
        figmaData,
        projectTree,
        projectMemory,
        currentDiff,
        learnedPatterns,
        architectContext,
      }),
    },
    { role: 'user', content: userPrompt },
  ];

  let finalResult: AIResponse | null = null;
  const maxLoops = 100;
  let totalTokens = 0;
  const toolHistory: string[] = [];
  const filesReadSet = new Set<string>();
  let consecutiveRedirects = 0;
  let finalLoop = 0;

  for (let loop = 1; loop <= maxLoops; loop++) {
    finalLoop = loop;
    if (signal?.aborted) throw new Error('AbortError');

    const statusMsg = `🔄 Iteration ${loop}... Thinking...`;
    if (onStatusUpdate) onStatusUpdate(statusMsg);

    // After 3+ consecutive redirects, strip tools to force JSON output
    const enforceJsonOnly = consecutiveRedirects >= 3;
    const response = await roleCompletion('code-gen', {
      messages,
      tools: enforceJsonOnly ? undefined : (toolRuntime.tools as any),
      ...(enforceJsonOnly ? { responseFormat: { type: 'json_object' as const } } : {}),
      signal,
      runId,
      taskId,
      projectName,
    });

    totalTokens += response.usage.totalTokens;

    if (onThinking && typeof response.reasoningContent === 'string' && response.reasoningContent.trim()) {
      try {
        onThinking(loop, response.reasoningContent);
      } catch (err) {
        console.warn('onThinking callback threw (non-fatal):', err);
      }
    }

    const agentContent = response.content?.trim() || '';
    const agentToolCalls = response.toolCalls;

    // Reconstruct assistant message for conversation history.
    // DeepSeek requires reasoning_content to be echoed verbatim on EVERY
    // thinking-mode assistant turn in subsequent requests — including empty
    // strings and including turns that did NOT produce tool calls. Omitting
    // it on any such turn triggers a 400 once that turn is part of history.
    const assistantMessage: LLMMessage = {
      role: 'assistant',
      content: agentContent,
      ...(agentToolCalls.length ? { tool_calls: agentToolCalls } : {}),
      ...(typeof response.reasoningContent === 'string'
        ? { reasoning_content: response.reasoningContent }
        : {}),
    };
    messages.push(assistantMessage);

    const agentThought = agentContent;

    if (agentToolCalls.length) {
      // Record tool descriptors BEFORE evaluating loop control so heuristics
      // see the current iteration's tools (fixes off-by-1 spiral detection)
      for (const tc of agentToolCalls) {
        try {
          const args = JSON.parse(tc.function.arguments || '{}');
          const primaryArg = args.filepath || args.keyword || args.pattern || args.symbol || args.cmd || args.path || '';
          toolHistory.push(`${tc.function.name}:${primaryArg}`);
        } catch {
          toolHistory.push(`${tc.function.name}:`);
        }
      }

      const loopControl = evaluateLoopControl(toolHistory, loop, totalTokens);

      if (loopControl.shouldRedirect) {
        consecutiveRedirects++;

        // Must respond to every tool_call before adding a user message
        for (const tc of agentToolCalls) {
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            name: tc.function.name,
            content: '[Skipped — redirecting to implementation]',
          });
        }

        const escalation = consecutiveRedirects >= 3
          ? `\n\n🛑 HARD REDIRECT (${consecutiveRedirects} consecutive redirects): Tools have been DISABLED. You MUST respond with ONLY a JSON object containing your implementation (edits, targetRoute, commitMessage). No tool calls will be accepted.`
          : '';

        messages.push({
          role: 'user',
          content: loopControl.reason + escalation,
        });

        if (onStatusUpdate) {
          onStatusUpdate(
            consecutiveRedirects >= 3
              ? `🛑 Hard redirect enforced — tools stripped (redirect #${consecutiveRedirects}).`
              : '⚠️ Jarvis was redirected to implementation.',
          );
        }

        // Emit telemetry for redirect spirals (every redirect after the first)
        if (runId && taskId && consecutiveRedirects >= 2) {
          telemetry.redirectSpiral({
            runId,
            taskId,
            projectName: projectName ?? 'unknown',
            consecutiveRedirects,
            iterationCount: loop,
            toolsStripped: consecutiveRedirects >= 3,
          });
        }

        continue;
      }

      // Agent is making productive tool calls — reset redirect counter
      consecutiveRedirects = 0;

      for (const toolCall of agentToolCalls) {
        const functionName = toolCall.function.name;
        let toolResult = '';

        try {
          const args = JSON.parse(toolCall.function.arguments || '{}');
          const primaryArg = args.filepath || args.keyword || args.pattern || args.symbol || args.cmd || args.path || '';

          if (onStatusUpdate) {
            onStatusUpdate(
              `🛠️ Executing: ${functionName} -> ${primaryArg}`,
              agentThought,
            );
          }

          toolResult = await toolRuntime.executeTool(functionName, args);

          // Track file reads explicitly for learning patterns
          if (functionName === 'read_file' && args.filepath) {
            filesReadSet.add(args.filepath);
          }

          if (isFatalToolError(toolResult)) {
            throw new Error(toolResult);
          }
        } catch (error: any) {
          if (isFatalRuntimeError(error)) {
            throw error;
          }

          toolResult = `Tool error: ${error?.message || String(error)}`;
        }

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          name: functionName,
          content: toolResult,
        });
      }

      continue;
    }

    try {
      finalResult = parseJsonObject<AIResponse>(agentContent);

      if (agentThought && onStatusUpdate) {
        onStatusUpdate('🧪 Validating syntax and compilation...', agentThought);
      }

      const dirsToCheck = getDirsToCheck(finalResult.edits || []);
      const baselineValidation = await runTypecheckForDirs(repoPath, dirsToCheck);
      const patchErrors = applyEditsToFiles(repoPath, finalResult.edits || []);

      if (patchErrors.length > 0) {
        messages.push({
          role: 'user',
          content: `🚨 PATCH ERROR 🚨
I could not apply your code. The following errors occurred:
${patchErrors.join('\n')}

Please generate a new JSON correcting the 'search' block so it matches the current file exactly.
If the block is ambiguous, make the search more specific so it matches only one location.`,
        });

        if (onStatusUpdate) onStatusUpdate('⚠️ Error injecting code. Jarvis is self-correcting...');
        finalResult = null;
        continue;
      }

      const currentValidation = await runTypecheckForDirs(repoPath, dirsToCheck);
      const newCompilationErrors = getNewCompilationErrors(baselineValidation, currentValidation);

      if (currentValidation.rawOutput.trim() !== '') {
        if (baselineValidation.rawOutput.trim() === '') {
          messages.push({
            role: 'user',
            content: `🚨 COMPILATION ERROR 🚨
Your last changes introduced TypeScript errors in the validated scope.

Errors:
${currentValidation.rawOutput.substring(0, 1200)}

Repair only issues directly related to the files you edited.
Do NOT expand into unrelated project cleanup.
The files ALREADY have your changes applied. Your new 'search' must target the broken code you just wrote.
Generate a new JSON with the smallest fix.`,
          });

          if (onStatusUpdate) onStatusUpdate('⚠️ Compiler detected new errors. Jarvis is rewriting logic...');
          finalResult = null;
          continue;
        }

        if (newCompilationErrors.length > 0) {
          messages.push({
            role: 'user',
            content: `🚨 COMPILATION ERROR 🚨
The project already had TypeScript errors in this scope, but your last changes appear to have introduced ADDITIONAL errors.

New errors detected:
${newCompilationErrors.slice(0, 20).join('\n').substring(0, 1200)}

Only fix errors directly related to the files you edited.
Do NOT try to repair unrelated setup, ORM generation, environment, or infrastructure issues unless they are strictly required for the user's request.
Generate the smallest corrective JSON patch.`,
          });

          if (onStatusUpdate) {
            onStatusUpdate('⚠️ Compiler detected additional errors beyond the baseline. Jarvis is self-correcting...');
          }
          finalResult = null;
          continue;
        }

        if (onStatusUpdate) {
          onStatusUpdate('⚠️ TypeScript still has pre-existing errors in this scope, but no new errors were introduced by the latest edits.');
        }
      }

      if ((finalResult.edits || []).length === 0) {
        const diffAfterValidation = await getCurrentGitDiff(repoPath);
        const hasUnexpectedDiff = diffAfterValidation.trim() !== '' && !currentDiff?.trim();
        const wroteViaTool = toolHistory.some(
          (entry) => entry.startsWith('write_file:') || entry.startsWith('apply_diff:'),
        );

        if (hasUnexpectedDiff && !wroteViaTool) {
          messages.push({
            role: 'user',
            content: `🚨 RESULT CONSISTENCY ERROR 🚨
You returned "edits": [] but the repository still has uncommitted changes.

This usually means your final JSON does not accurately describe the current state.
Return a corrected JSON that reflects the actual changes needed from the CURRENT repository state, or explicitly clean up unintended changes first.`,
          });

          if (onStatusUpdate) {
            onStatusUpdate('⚠️ Final JSON was inconsistent with repository state. Jarvis is correcting the result...');
          }
          finalResult = null;
          continue;
        }

        if (hasUnexpectedDiff && wroteViaTool && onStatusUpdate) {
          onStatusUpdate('✅ Accepted edits:[] — repository changes already applied via write_file/apply_diff.');
        }
      }

      if ((finalResult.edits || []).length > 0) {
        const editedTopLevelTargets = new Set(
          finalResult.edits.map((edit) => edit.filepath.split('/')[0]),
        );

        if (finalResult.targetRoute && finalResult.targetRoute !== '/' && editedTopLevelTargets.size === 0) {
          messages.push({
            role: 'user',
            content: `🚨 RESULT COHERENCE ERROR 🚨
Your final result includes a targetRoute but the edits do not clearly reflect an implementation for that flow.
Re-check that your JSON accurately matches the code changes you made and return a corrected JSON.`,
          });

          if (onStatusUpdate) {
            onStatusUpdate('⚠️ Final result was weakly aligned with the implementation. Jarvis is correcting coherence...');
          }

          finalResult = null;
          continue;
        }
      }

      if (onStatusUpdate) onStatusUpdate('✅ Code successfully validated by compiler.');
      break;
    } catch (error) {
      if (isFatalRuntimeError(error)) {
        throw error;
      }

      messages.push({
        role: 'user',
        content: 'Response was not valid JSON or failed to parse. Return exactly one JSON object.',
      });
    }
  }

  if (!finalResult) {
    throw new Error('Agent reached loop limit without passing compilation checks.');
  }

  return {
    targetRoute: finalResult.targetRoute || '/',
    commitMessage: finalResult.commitMessage || 'feat: auto-update',
    tokenUsage: totalTokens,
    iterations: finalLoop,
    toolHistory,
    filesRead: Array.from(filesReadSet),
  };
}
