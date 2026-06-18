import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonInteraction,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Interaction,
  Message,
} from 'discord.js';
import { approveSession } from '../../application/approve-session.js';
import { createAutonomousRunPlan } from '../../application/run-autonomous-agent.js';
import { runDevelopmentTask } from '../../application/run-development-task.js';
import { initProject } from '../../application/projects/init-project.js';
import { rejectSession } from '../../application/reject-session.js';
import { getProjectByName, getRuntimeConfig } from '../../config.js';
import type { AutonomousRunPolicy } from '../../domain/policies.js';
import { RuntimeState } from '../../runtime/state.js';
import { unityStore } from '../../runtime/services.js';
import { getRepositoryStatus, prepareWorkspace } from '../../git.js';
import {
  getProjectPolicy,
  normalizePolicy,
  applyPolicyPreset,
  isPolicyPreset,
} from '../../services/orchestration/policy-engine.js';
import { getTelemetryStore } from '../../services/telemetry/telemetry-store.js';
import { getLearningStore } from '../../services/learning/learning-store.js';
import { getApprovalGateway } from '../../a2a/approval/approval-gateway.js';
import { runMarketingDraft } from '../../a2a/executors/marketing.executor.js';
import { setTicketSink } from '../../services/tickets/ticket-notifier.js';
import { routeAndDispatch } from '../../a2a/registry/route-and-dispatch.js';

const runtimeConfig = getRuntimeConfig();
const DISCORD_CONTENT_LIMIT = 3800;

function formatElapsed(startMs: number): string {
  const seconds = Math.floor((Date.now() - startMs) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

function formatAgentStatus(statusMsg: string, thought?: string): string {
  let logMessage = `**${statusMsg}**`;

  if (thought && thought !== '') {
    logMessage += `\n> 💭 *${thought.replace(/\n/g, '\n> ')}*`;
  }

  return logMessage;
}

function chunkDiscordContent(content: string, limit = DISCORD_CONTENT_LIMIT): string[] {
  if (content.length <= limit) {
    return [content];
  }

  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > limit) {
    const slice = remaining.slice(0, limit);
    const breakIndex = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf(' '));

    if (breakIndex > Math.floor(limit * 0.6)) {
      chunks.push(remaining.slice(0, breakIndex).trimEnd());
      remaining = remaining.slice(breakIndex + 1);
    } else {
      chunks.push(remaining.slice(0, limit).trimEnd());
      remaining = remaining.slice(limit);
    }
  }

  if (remaining.trim()) {
    chunks.push(remaining.trim());
  }

  return chunks;
}

async function sendChunkedThreadMessages(thread: any, content: string): Promise<void> {
  for (const chunk of chunkDiscordContent(content)) {
    await thread.send(chunk).catch(() => {});
  }
}

function buildSessionButtonId(
  action: 'approve' | 'reject',
  projectName: string,
  sessionId: string,
): string {
  return `${action}:${encodeURIComponent(projectName)}:${sessionId}`;
}

function parseButtonContext(customId: string): {
  action: string;
  projectName?: string;
  sessionId?: string;
} {
  if (customId === 'cancel_task') {
    return {
      action: 'cancel',
      sessionId: 'task',
    };
  }

  // Approval gateway buttons: "approve-appr:<id>" / "reject-appr:<id>" (2 parts).
  if (customId.startsWith('approve-appr:') || customId.startsWith('reject-appr:')) {
    const [action, approvalId] = customId.split(':');
    return { action, sessionId: approvalId };
  }

  if (customId.includes(':')) {
    const [action, encodedProjectName, sessionId] = customId.split(':');

    return {
      action,
      projectName: encodedProjectName ? decodeURIComponent(encodedProjectName) : undefined,
      sessionId,
    };
  }

  const [action, sessionId] = customId.split('_');
  return { action, sessionId };
}

async function cleanupLostSession(
  interaction: ButtonInteraction,
  runtime: RuntimeState,
  projectName?: string,
): Promise<void> {
  const project = projectName ? getProjectByName(projectName) : runtime.getActiveProject();

  await rejectSession(project).catch(() => {});

  await interaction.update({
    content:
      `⚠️ No pude encontrar el contexto de esta sesión.\n` +
      `🧹 Limpié el workspace de \`${project.name}\` para destrabarte. Ya puedes empezar otra solicitud.`,
    components: [],
    files: [],
  });
}

export function registerDiscordHandlers(client: Client, runtime: RuntimeState): void {
  // Find a text channel by name (returns the first sendable match, or null).
  const findChannel = (name: string): any =>
    client.channels.cache.find((c: any) => c?.name === name && typeof c?.send === 'function') as any;

  // Wire the Approval Gateway to Discord: when an agent (e.g. Marketing) requests
  // approval for an outward action, post ✅/🗑️ buttons to the APPROVALS channel.
  getApprovalGateway().setNotifier(async (approvalId, request) => {
    const channel = findChannel(runtimeConfig.approvalsChannelName);
    if (!channel) {
      throw new Error(`Approvals channel #${runtimeConfig.approvalsChannelName} not found.`);
    }
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`approve-appr:${approvalId}`)
        .setLabel('✅ Approve')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`reject-appr:${approvalId}`)
        .setLabel('🗑️ Reject')
        .setStyle(ButtonStyle.Danger),
    );
    await channel.send({
      content: [
        `🔔 **Authorization requested by \`${request.requestedBy}\`**`,
        `**${request.title}**`,
        '',
        request.detail.length > 1500 ? request.detail.slice(0, 1500) + '…' : request.detail,
        '',
        '_Approve to let the agent proceed, or Reject to cancel._',
      ].join('\n'),
      components: [row],
    });
  });

  // Wire ticket changes to Discord: announce meaningful transitions (→done,
  // →blocked) and new manual tickets to the TICKETS channel.
  setTicketSink((change) => {
    const t = change.ticket;
    const announce =
      (change.kind === 'status' && (t.status === 'done' || t.status === 'blocked')) ||
      (change.kind === 'created' && t.source === 'manual');
    if (!announce) return;
    const channel = findChannel(runtimeConfig.ticketsChannelName);
    if (!channel) return;
    const icon = t.status === 'done' ? '✅' : t.status === 'blocked' ? '🚧' : '🎫';
    const line =
      change.kind === 'created'
        ? `🎫 **New ticket:** ${t.title}`
        : `${icon} **Ticket ${t.status}:** ${t.title}${change.fromStatus ? ` _(was ${change.fromStatus})_` : ''}`;
    void channel.send(line).catch(() => {});
  });

  client.on('messageCreate', async (message: Message) => {
    if (message.author.bot) return;

    const channelName = (message.channel as any).name;
    if (![runtimeConfig.manualChannelName, runtimeConfig.autonomousChannelName].includes(channelName)) {
      return;
    }

    if (channelName === runtimeConfig.autonomousChannelName) {
      if (runtime.isProcessing()) {
        const warningMsg = await message.reply(
          '⏳ Unity Agent ya está ejecutando otro run. Espera a que termine o cancélalo.',
        );
        setTimeout(() => warningMsg.delete().catch(() => {}), 5000);
        return;
      }

      const project = runtime.getActiveProject();
      const abortController = runtime.startProcessing();
      const cancelRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('cancel_task')
          .setLabel('🛑 Cancelar Run')
          .setStyle(ButtonStyle.Secondary),
      );

      const replyMessage = await message.reply({
        content: '🤖 Unity Agent received the request. Planning autonomous execution...',
        components: [cancelRow],
      });

      const thread = await message.startThread({
        name:
          message.content.length > 20
            ? `⚙️ Unity Agent - ${message.content.substring(0, 20)}...`
            : `⚙️ Unity Agent - ${message.content}`,
        autoArchiveDuration: 60,
      });

      try {
        const runStartMs = Date.now();
        const result = await createAutonomousRunPlan({
          project,
          prompt: message.content,
          channelName,
          mode: 'interactive',
          signal: abortController.signal,
          onProgress: async (progressMessage) => {
            const elapsed = formatElapsed(runStartMs);
            await thread.send(`⏱ \`${elapsed}\` — ${progressMessage}`).catch(() => {});
          },
        });

        const taskLines = result.tasks
          .map(
            (task) =>
              `- ${task.title}\n  scope: ${task.writeScope.join(', ')}${
                task.dependencies.length ? `\n  deps: ${task.dependencies.join(', ')}` : ''
              }`,
          )
          .join('\n');

        await replyMessage.edit({
          content: [
            '🗺️ **Unity Agent Plan Ready**',
            `🆔 Run: \`${result.runId}\``,
            `🌿 Branch: \`${result.branchName}\``,
            `🔀 Merge target later: \`${result.defaultBranch}\``,
            `🧠 Approval required: \`${result.requiresApproval ? 'yes' : 'no'}\``,
            `🌐 Review plan: ${result.consoleUrl}`,
            '',
            'Approve or reject the plan from the local console.',
          ].join('\n'),
          components: [],
        });

        await sendChunkedThreadMessages(
          thread,
          `**Plan Summary**\n${result.planSummary}\n\n**Review in console**\n${result.consoleUrl}`,
        );

        if (taskLines) {
          await sendChunkedThreadMessages(thread, `**Planned Tasks**\n${taskLines}`);
        }

        await thread.setArchived(true);
      } catch (error: any) {
        if (error.message === 'AbortError' || error.name === 'AbortError') {
          await replyMessage.edit({
            content: '🛑 **Unity Agent Run Cancelled.**',
            components: [],
          });
          await thread.send('🛑 Autonomous run cancelled by the user.');
          await thread.setArchived(true);
        } else {
          console.error(error);
          const safeError =
            error.message.length > 1500 ? `${error.message.substring(0, 1500)}...` : error.message;
          await thread.send(`❌ **AUTONOMOUS RUN ERROR:**\n\`\`\`bash\n${safeError}\n\`\`\``);
          await replyMessage.edit({
            content: '❌ Unity Agent encountered an error. Check the thread for logs.',
            components: [],
          });
        }
      } finally {
        runtime.finishProcessing();
      }

      return;
    }

    if (runtime.isProcessing()) {
      const warningMsg = await message.reply(
        '⏳ **¡Paciencia!** Jarvis está procesando otra solicitud en este momento. Espera a que termine o cancélala.',
      );
      setTimeout(() => warningMsg.delete().catch(() => {}), 5000);
      return;
    }

    const project = runtime.getActiveProject();
    const isIteration = !!message.reference;

    if (!isIteration) {
      const gitStatus = await getRepositoryStatus(project);

      if (gitStatus.trim() !== '') {
        await message.reply(
          '⚠️ **¡Seguro Activado!** Tienes trabajo en progreso sin guardar.\n\n👉 Para iterar sobre el código actual, debes darle a **"Responder"** (Reply) al mensaje anterior.\n👉 Si realmente quieres empezar una tarea nueva, presiona el botón rojo `🗑️ Revert` del mensaje anterior para limpiar el entorno.',
        );
        return;
      }
    }

    const abortController = runtime.startProcessing();
    const cancelRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('cancel_task')
        .setLabel('🛑 Cancelar Tarea')
        .setStyle(ButtonStyle.Secondary),
    );

    const replyMessage = await message.reply({
      content: isIteration
        ? '🤖 Acknowledged. Agent waking up for iteration...'
        : '🤖 Acknowledged. Preparing a fresh workspace...',
      components: [cancelRow],
    });

    const thread = await message.startThread({
      name:
        message.content.length > 20
          ? `🧠 Jarvis Logs - ${message.content.substring(0, 20)}...`
          : `🧠 Jarvis Logs - ${message.content}`,
      autoArchiveDuration: 60,
    });

    try {
      const result = await runDevelopmentTask({
        project,
        prompt: message.content,
        isIteration,
        signal: abortController.signal,
        onProgress: async (progressMessage) => {
          await thread.send(progressMessage).catch(() => {});
        },
        onAgentStatusUpdate: async (status, thought) => {
          await thread.send(formatAgentStatus(status, thought)).catch(() => {});
        },
      });

      runtime.rememberSession(result.sessionId, result.commitMessage, project.name);

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(buildSessionButtonId('approve', project.name, result.sessionId))
          .setLabel('✅ Approve & PR')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(buildSessionButtonId('reject', project.name, result.sessionId))
          .setLabel('🗑️ Revert (Start Over)')
          .setStyle(ButtonStyle.Danger),
      );

      const finalContent = `✨ **Ready!**\n📝 **Commit:** \`${result.commitMessage}\`\n💰 **Tokens Used:** \`${result.tokenUsage.toLocaleString()}\`\n🏠 **Local:** ${result.localUrl}\n📱 **Mobile (Wi-Fi):** ${result.publicUrl ? result.publicUrl : 'Unavailable'}\n\n👉 **¿Quieres iterar?** Simplemente RESPONDE a este mensaje con tus correcciones.\n${result.warning ? `\n⚠️ *${result.warning}*` : ''}`;

      const filesToAttach = [];
      if (result.snapshotPath) filesToAttach.push(new AttachmentBuilder(result.snapshotPath));
      if (result.diffPath) filesToAttach.push(new AttachmentBuilder(result.diffPath));

      if (filesToAttach.length > 0) {
        await replyMessage.edit({ content: finalContent, files: filesToAttach, components: [row] });
      } else {
        await replyMessage.edit({ content: finalContent, components: [row] });
      }

      await thread.send('✅ Task completed. Archiving thread.');
      await thread.setArchived(true);
    } catch (error: any) {
      if (error.message === 'AbortError' || error.name === 'AbortError') {
        await rejectSession(project).catch(() => {});
        await thread.send('🛑 **Misión Abortada:** El usuario canceló la tarea. El repositorio ha sido restaurado.');
        await replyMessage.edit({
          content: '🛑 **Tarea Cancelada.** El entorno está limpio y listo para otra solicitud.',
          components: [],
        });
        await thread.setArchived(true);
      } else {
        console.error(error);
        const safeError =
          error.message.length > 1500 ? `${error.message.substring(0, 1500)}...` : error.message;
        await thread.send(`❌ **CRITICAL ERROR:**\n\`\`\`bash\n${safeError}\n\`\`\``);
        await replyMessage.edit({
          content: '❌ Error encountered. Please check the thread logs for details.',
          components: [],
        });
      }
    } finally {
      runtime.finishProcessing();
    }
  });

  client.on('interactionCreate', async (interaction: Interaction) => {
    if (interaction.isButton()) {
      const { action, projectName, sessionId } = parseButtonContext(interaction.customId);

      if (action === 'cancel' && sessionId === 'task') {
        if (runtime.abortCurrentTask()) {
          await interaction.update({
            content: '🛑 Interceptando a Jarvis... abortando procesos.',
            components: [],
          });
        } else {
          await interaction.update({ content: '⚠️ No hay ninguna tarea corriendo.', components: [] });
        }
        return;
      }

      // ── Approval Gateway buttons (approve-appr / reject-appr) ──
      // Handled BEFORE the isProcessing() guard: a marketing approval can arrive
      // while a dev run is executing and must not be blocked by it.
      if (action === 'approve-appr' || action === 'reject-appr') {
        const approvalId = sessionId as string;
        const approved = action === 'approve-appr';
        const resolved = getApprovalGateway().resolve(approvalId, approved, interaction.user?.username || 'discord-user');
        await interaction.update({
          content: resolved
            ? approved
              ? '✅ **Aprobado.** El agente continuará con la acción.'
              : '🗑️ **Rechazado.** El agente cancelará la acción.'
            : '⚠️ Esta solicitud de autorización ya no está activa (resuelta o expirada).',
          components: [],
        });
        return;
      }

      if (runtime.isProcessing()) {
        await interaction.reply({
          content: '⏳ Jarvis está ocupado en otra tarea. Espera a que termine.',
          ephemeral: true,
        });
        return;
      }

      runtime.startProcessing();

      try {
        if (!sessionId) {
          await cleanupLostSession(interaction, runtime, projectName);
          return;
        }

        const sessionRecord = runtime.getSessionRecord(sessionId);

        if (!sessionRecord) {
          await cleanupLostSession(interaction, runtime, projectName);
          return;
        }

        const project = getProjectByName(sessionRecord.projectName);

        if (action === 'approve') {
          await interaction.update({
            content: '🚀 Analyzing all session changes to generate a Smart PR...',
            components: [],
            files: [],
          });

          const prUrl = await approveSession({
            project,
            sessionId,
            fallbackCommitMessage: sessionRecord.commitMessage,
          });

          await interaction.followUp(`✅ **Smart Pull Request successfully created!**\n🔗 Review here: ${prUrl}`);
          runtime.deleteSession(sessionId);
          return;
        }

        if (action === 'reject') {
          await rejectSession(project);
          await interaction.update({
            content: '🗑️ **Cambios revertidos.** El repositorio ha vuelto a su estado original limpio.',
            components: [],
            files: [],
          });
          runtime.deleteSession(sessionId);
        }
      } catch (error) {
        console.error(error);

        if (interaction.isRepliable()) {
          await interaction.followUp('❌ Failed to process the session action.').catch(() => {});
        }
      } finally {
        runtime.finishProcessing();
      }

      return;
    }

    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;

      if (commandName === 'status') {
        const projectName = runtime.getActiveProjectName();
        const projectPolicy = getProjectPolicy(unityStore, projectName);
        const queueMetrics = runtime.getQueueMetrics();
        const activeRunIds = runtime.getActiveRunIds();

        const runLines = activeRunIds.length
          ? activeRunIds.map((id) => `  \`${id.slice(0, 12)}\``).join('\n')
          : '  None';

        await interaction.reply(
          [
            '🤖 **Unity Agent Status**',
            `📂 Project: \`${projectName}\``,
            `🔴 Processing: ${runtime.isProcessing() ? `Yes (${queueMetrics.activeRuns} run(s))` : 'No 🟢'}`,
            `📊 Queue: \`${queueMetrics.queueRunning}/${queueMetrics.queueMaxConcurrency}\` running, \`${queueMetrics.queuePending}\` pending`,
            `🔄 Active runs:\n${runLines}`,
            '',
            `📡 Manual: \`#${runtimeConfig.manualChannelName}\` | Autonomous: \`#${runtimeConfig.autonomousChannelName}\``,
            `🌐 Console: \`http://localhost:${runtimeConfig.localConsolePort}\``,
            '',
            '⚙️ **Policy**',
            `Branch: \`${projectPolicy.integrationBranchName}\``,
            `Auto-approve: \`${projectPolicy.autoApprovePlan ? 'on' : 'off'}\``,
            `Parallelism: \`${projectPolicy.maxParallelTasks}\` | Retries: \`${projectPolicy.maxRetriesPerTask}\` | Hours: \`${projectPolicy.maxHours}\` | Commits: \`${projectPolicy.maxCommits}\``,
            `Token budget: \`${(projectPolicy.maxTokensPerRun / 1_000_000).toFixed(1)}M/run\` | \`${(projectPolicy.maxTokensPerTask / 1_000).toFixed(0)}K/task\``,
            `Gates: typecheck=\`${projectPolicy.gates.runTypecheck}\` lint=\`${projectPolicy.gates.runLint}\` test=\`${projectPolicy.gates.runTests}\` security=\`${projectPolicy.gates.runSecurityScan}\``,
          ].join('\n'),
        );
        return;
      }

      if (commandName === 'policy') {
        const projectName = runtime.getActiveProjectName();
        const currentPolicy = getProjectPolicy(unityStore, projectName);

        // Check for preset first
        const presetValue = interaction.options.getString('preset');
        let updatedPolicy: AutonomousRunPolicy;
        let presetLabel = '';

        if (presetValue && isPolicyPreset(presetValue)) {
          updatedPolicy = applyPolicyPreset(currentPolicy, presetValue);
          presetLabel = ` (preset: **${presetValue}**)`;
        } else {
          updatedPolicy = normalizePolicy({
            ...currentPolicy,
            maxHours: interaction.options.getInteger('hours') ?? currentPolicy.maxHours,
            maxCommits: interaction.options.getInteger('commits') ?? currentPolicy.maxCommits,
            maxParallelTasks: interaction.options.getInteger('parallel') ?? currentPolicy.maxParallelTasks,
            maxRetriesPerTask: interaction.options.getInteger('retries') ?? currentPolicy.maxRetriesPerTask,
            maxImprovementCycles:
              interaction.options.getInteger('improvements') ?? currentPolicy.maxImprovementCycles,
            autoApprovePlan:
              interaction.options.getBoolean('autoapproveplan') ?? currentPolicy.autoApprovePlan,
          });
        }

        unityStore.upsertPolicy(projectName, updatedPolicy);

        await interaction.reply(
          [
            `⚙️ **Policy updated for \`${projectName}\`**${presetLabel}`,
            `Branch: \`${updatedPolicy.integrationBranchName}\``,
            `Auto-approve: \`${updatedPolicy.autoApprovePlan ? 'on' : 'off'}\``,
            `Hours: \`${updatedPolicy.maxHours}\` | Commits: \`${updatedPolicy.maxCommits}\``,
            `Parallelism: \`${updatedPolicy.maxParallelTasks}\` | Retries: \`${updatedPolicy.maxRetriesPerTask}\` | Improvements: \`${updatedPolicy.maxImprovementCycles}\``,
            `Token budget: \`${(updatedPolicy.maxTokensPerRun / 1_000_000).toFixed(1)}M/run\` | \`${(updatedPolicy.maxTokensPerTask / 1_000).toFixed(0)}K/task\``,
            '',
            '💡 Presets: `/policy preset:conservative|balanced|aggressive`',
          ].join('\n'),
        );
        return;
      }

      if (commandName === 'cost') {
        const runId = interaction.options.getString('run');
        if (!runId) {
          await interaction.reply({ content: '❌ Please provide a run ID: `/cost run:<id>`', ephemeral: true });
          return;
        }
        const telemetryStore = getTelemetryStore();
        const summary = telemetryStore.getRunCostSummary(runId);
        if (!summary) {
          await interaction.reply({ content: `❌ No telemetry found for run \`${runId}\`.`, ephemeral: true });
          return;
        }
        const modelLines = summary.modelBreakdown
          .map((m) => `  \`${m.model}\`: ${m.tokens.toLocaleString()} tokens ($${m.costUsd.toFixed(4)})`)
          .join('\n');
        await interaction.reply(
          [
            `💰 **Cost Summary for \`${runId.slice(0, 12)}\`**`,
            `Total tokens: \`${summary.totalTokens.toLocaleString()}\``,
            `Estimated cost: \`$${summary.totalCostUsd.toFixed(4)}\``,
            `Tasks: \`${summary.taskCount}\` | Avg tokens/task: \`${summary.avgTokensPerTask.toLocaleString()}\``,
            '',
            '**Model breakdown:**',
            modelLines || '  No model data',
          ].join('\n'),
        );
        return;
      }

      if (commandName === 'learning') {
        const projectName = runtime.getActiveProjectName();
        const learningStore = getLearningStore();
        const stats = learningStore.getProjectLearningStats(projectName);
        const topPatterns = learningStore.getTopPatterns(5);

        const patternLines = topPatterns.length
          ? topPatterns
              .map(
                (p, i) =>
                  `${i + 1}. **${p.taskKind}** (${p.filePattern || '*'}) — score: \`${p.effectivenessScore.toFixed(2)}\` | applied: \`${p.timesApplied}\``,
              )
              .join('\n')
          : '  No patterns learned yet.';

        await interaction.reply(
          [
            `🧠 **Learning Stats for \`${projectName}\`**`,
            `Patterns: \`${stats.totalPatterns}\` total, \`${stats.effectivePatterns}\` effective`,
            `Applications: \`${stats.totalApplications}\``,
            `Success rate: \`${(stats.overallSuccessRate * 100).toFixed(1)}%\``,
            '',
            '**Top patterns:**',
            patternLines,
          ].join('\n'),
        );
        return;
      }

      if (runtime.isProcessing()) {
        await interaction.reply({
          content: '⏳ Jarvis está ocupado en una tarea. Espera antes de cambiar el contexto.',
          ephemeral: true,
        });
        return;
      }

      if (commandName === 'workon') {
        const repoName = interaction.options.getString('repo', true);
        const project = runtime.setActiveProject(repoName);

        await interaction.reply(
          `🔄 **Cambio de Contexto:**\nJarvis ha movido su atención a \`${repoName}\`.\nEscaneando arquitectura...`,
        );

        try {
          await prepareWorkspace(project);
          await interaction.followUp(`✅ Arquitectura de \`${repoName}\` lista para trabajar.`);
        } catch (error: any) {
          await interaction.followUp(`⚠️ Error al preparar el workspace: ${error.message}`);
        }

        return;
      }

      if (commandName === 'init') {
        const type = interaction.options.getString('type', true);
        const name = interaction.options.getString('name', true);

        await interaction.reply(
          `🏗️ **Construyendo Base:** Iniciando scaffold de \`${name}\` (${type})...\n*Por favor espera, esto puede tomar 1 o 2 minutos.*`,
        );

        try {
          await initProject(type, name);
          await interaction.followUp(
            `✅ **Proyecto \`${name}\` creado exitosamente.**\n👉 Usa \`/workon repo:${name}\` para decirle a Jarvis que empiece a trabajar en él.`,
          );
        } catch (error: any) {
          await interaction.followUp(`❌ Error al crear el proyecto: ${error.message}`);
        }
        return;
      }

      if (commandName === 'marketing') {
        const brief = interaction.options.getString('brief', true);
        await interaction.reply(`📣 **Marketing Squad** está redactando un post sobre: _${brief}_\n*Te pediré aprobación antes de publicar.*`);
        // runMarketingDraft drafts, then requests approval via the gateway, which
        // posts ✅/🗑️ buttons to #unity-agent. We stream progress as follow-ups.
        runMarketingDraft(brief, (m) => {
          interaction.followUp(m.length > 1800 ? m.slice(0, 1800) + '…' : m).catch(() => {});
        })
          .then((result) => {
            interaction.followUp(
              result.status === 'published'
                ? `✅ **Publicado.** ${result.detail}`
                : result.status === 'rejected'
                  ? `🗑️ **No publicado.** ${result.detail}`
                  : `❌ ${result.detail}`,
            ).catch(() => {});
          })
          .catch((err) => {
            interaction.followUp(`❌ Marketing falló: ${err?.message || String(err)}`).catch(() => {});
          });
        return;
      }

      if (commandName === 'ask' || commandName === 'brainstorm') {
        const prompt = interaction.options.getString('prompt', true);
        const agentChoice = interaction.options.getString('agent') || 'auto';
        const manualAgentId = agentChoice !== 'auto' ? agentChoice : undefined;
        // /ask uses the active project; /brainstorm explores with no project.
        const isBrainstorm = commandName === 'brainstorm';
        const projectName = isBrainstorm ? 'brainstorm' : runtime.getActiveProjectName();
        await interaction.reply(
          isBrainstorm
            ? `💡 **Brainstorm:** _${prompt}_`
            : `🧭 **Routing** (project: \`${projectName}\`): _${prompt}_${manualAgentId ? ` → \`${manualAgentId}\`` : ''}`,
        );
        routeAndDispatch(prompt, {
          manualAgentId,
          projectName,
          onProgress: (m) => { interaction.followUp(m.length > 1800 ? m.slice(0, 1800) + '…' : m).catch(() => {}); },
        })
          .then((r) => {
            const convNote = `\n_(conversación \`${r.conversationId.slice(0, 12)}\` — re-léela en el panel)_`;
            if (r.outcome === 'needs-autonomous-run') {
              interaction.followUp(`🛠️ ${r.detail}\n👉 Manda el prompt al canal autónomo (#${runtimeConfig.autonomousChannelName}) para lanzar un run.${convNote}`).catch(() => {});
            } else if (r.outcome === 'dispatched') {
              const out = r.output ? `\n\n${r.output.length > 1500 ? r.output.slice(0, 1500) + '…' : r.output}` : '';
              interaction.followUp(`✅ **${r.decision.agent.name}** (${r.terminalState}).${out}${convNote}`).catch(() => {});
            } else {
              interaction.followUp(`❌ ${r.detail}`).catch(() => {});
            }
          })
          .catch((err) => {
            interaction.followUp(`❌ Routing falló: ${err?.message || String(err)}`).catch(() => {});
          });
        return;
      }
    }
  });
}
