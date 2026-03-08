import { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder, Message, Interaction } from 'discord.js';
import 'dotenv/config';

import { TARGET_REPO_PATH } from './src/config.js';
import { prepareWorkspace, createPullRequest } from './src/git.js';
import { getProjectTree } from './src/scanner.js';
import { getFigmaContext } from './src/figma.js';
import { takeSnapshot } from './src/snapshot.js';
import { generateAndWriteCode } from './src/ai.js';

const client = new Client({ intents: [ GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent ]});

const sessionStore = new Map<string, string>();

client.on('messageCreate', async (message: Message) => {
    if (message.author.bot || (message.channel as any).name !== 'jarvis-dev') return;

    const isIteration = !!message.reference;

    const replyMessage = await message.reply(
        isIteration 
        ? '🤖 Acknowledged. Agent waking up for iteration...' 
        : '🤖 Acknowledged. Preparing a fresh workspace...'
    );

    const threadName = message.content.length > 20 
        ? `🧠 Jarvis Logs - ${message.content.substring(0, 20)}...` 
        : `🧠 Jarvis Logs - ${message.content}`;
        
    const thread = await message.startThread({
        name: threadName,
        autoArchiveDuration: 60,
    });

    try {
        if (!isIteration) {
            await prepareWorkspace();
        }
        
        const figmaData = await getFigmaContext(message.content);
        if (figmaData) await thread.send('🎨 Figma link detected. Analyzing design...');
        
        const projectTree = getProjectTree(TARGET_REPO_PATH);
        
        const finalPrompt = isIteration 
            ? `We are iterating on the current code. Keep the recent changes but apply this correction: "${message.content}"` 
            : message.content;

        const { targetRoute, commitMessage, tokenUsage } = await generateAndWriteCode(
            finalPrompt, figmaData, projectTree,
            async (statusMsg, thought) => {
                let logMessage = `**${statusMsg}**`;
                if (thought && thought !== "") {
                    logMessage += `\n> 💭 *${thought.replace(/\n/g, '\n> ')}*`;
                }
                await thread.send(logMessage).catch(() => {});
            }
        );
        
        const sessionId = Date.now().toString().slice(-6);
        sessionStore.set(sessionId, commitMessage);
        
        await thread.send(`📸 Code generated. Navigating to \`${targetRoute}\` to take snapshot...`);
        
        // 👈 Aquí extraemos AMBAS URLs
        const { snapshotPath, publicUrl, localUrl, warning } = await takeSnapshot(targetRoute);

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`approve_${sessionId}`).setLabel('✅ Approve & PR').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`reject_${sessionId}`).setLabel('🔄 Reject').setStyle(ButtonStyle.Danger),
        );

        // 👈 Aquí imprimimos 🏠 Local y 🌍 Public
        const finalContent = `✨ **Ready!**\n📝 **Commit:** \`${commitMessage}\`\n💰 **Tokens Used:** \`${tokenUsage.toLocaleString()}\`\n🏠 **Local:** ${localUrl}\n📱 **Mobile (Wi-Fi):** ${publicUrl ? publicUrl : 'Unavailable'}\n${warning ? `\n⚠️ *${warning}*` : ''}`;
        if (snapshotPath) {
            await replyMessage.edit({ content: finalContent, files: [new AttachmentBuilder(snapshotPath)], components: [row] });
        } else {
            await replyMessage.edit({ content: finalContent, components: [row] });
        }

        await thread.send("✅ Task completed. Archiving thread.");
        await thread.setArchived(true);

    } catch (error: any) {
        console.error(error);
        const safeError = error.message.length > 1500 ? error.message.substring(0, 1500) + '...' : error.message;
        
        await thread.send(`❌ **CRITICAL ERROR:**\n\`\`\`bash\n${safeError}\n\`\`\``);
        await replyMessage.edit(`❌ Error encountered. Please check the thread logs for details.`);
    }
});

client.on('interactionCreate', async (interaction: Interaction) => {
    if (!interaction.isButton()) return;

    const [action, sessionId] = interaction.customId.split('_');

    if (action === 'approve') {
        await interaction.update({ content: '🚀 Creating PR with exact commit message...', components: [], files: [] });
        
        try {
            const exactCommitMessage = sessionStore.get(sessionId) || 'feat: update from Jarvis';
            const prUrl = await createPullRequest(`req-${sessionId}`, exactCommitMessage);
            await interaction.followUp(`✅ **Pull Request successfully created!**\n🔗 Review here: ${prUrl}`);
            sessionStore.delete(sessionId);
        } catch (error) {
            console.error(error);
            await interaction.followUp(`❌ Failed to create PR.`);
        }
    } else if (action === 'reject') {
        await interaction.update({ 
            content: '🛑 Operation cancelled.\n👉 **To iterate:** Reply to this message with your corrections.\n👉 **To start over:** Send a new regular message.', 
            components: [], 
            files: [] 
        });
        sessionStore.delete(sessionId);
    }
});

client.login(process.env.DISCORD_TOKEN as string);
console.log('🤖 Jarvis Architect listening on Discord...');