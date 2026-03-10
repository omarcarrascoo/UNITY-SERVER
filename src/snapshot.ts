import fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import puppeteer from 'puppeteer';
import os from 'os';
import { WORKSPACE_DIR } from './config.js';
import { TARGET_EXPO_PATH, TARGET_API_PATH } from './git.js';

// Long-lived process handles allow restarts between runs without zombie servers.
let currentExpoProcess: ChildProcess | null = null;
let currentNestProcess: ChildProcess | null = null;
let currentNgrokProcess: ChildProcess | null = null;

export interface SnapshotResult {
    snapshotPath: string | null;
    publicUrl: string | null;
    localUrl: string;
    warning?: string;
}

// Selects the first non-loopback IPv4 address for LAN preview links.
function getLocalIpAddress(): string | null {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name] || []) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return null;
}

// Boots backend/frontend as needed and captures a mobile viewport screenshot of the target route.
export async function takeSnapshot(targetRoute: string = '/'): Promise<SnapshotResult> {
    // Normalizes Expo Router file paths into a browser-safe route.
    let safeRoute = targetRoute.replace(/^\/?app\//, '/').replace(/\/\([^)]+\)/g, '').replace(/\/index\/?$/i, ''); 
    if (!safeRoute || safeRoute === '') safeRoute = '/';
    if (!safeRoute.startsWith('/')) safeRoute = '/' + safeRoute;

    const snapshotPath = path.join(WORKSPACE_DIR, 'snapshot.png');
    const port = 8081;
    const localUrl = `http://localhost:${port}${safeRoute}`;
    const ip = getLocalIpAddress();
    const mobileUrl = ip ? `http://${ip}:${port}${safeRoute}` : null;

    console.log(`📸 Requested route: ${targetRoute}`);

    // Ensure previous run processes do not conflict with required ports.
    if (currentExpoProcess) currentExpoProcess.kill();
    if (currentNestProcess) currentNestProcess.kill();
    if (currentNgrokProcess) currentNgrokProcess.kill();
    await new Promise(r => setTimeout(r, 2000)); 

    let backendNgrokUrl: string | null = null;
    
    if (TARGET_API_PATH) {
        // API startup is optional; frontend-only repos skip this entire block.
        console.log("🔌 Starting NestJS Backend...");
        currentNestProcess = spawn('npm', ['run', 'start'], { cwd: TARGET_API_PATH, shell: true });
        
        console.log("🚇 Opening Ngrok Tunnel for Backend (Port 3000)...");
        // Avoid interactive npx prompts when ngrok is not already installed.
        currentNgrokProcess = spawn('npx', ['--yes', 'ngrok', 'http', '3000', '--log=stdout'], { shell: true });
        
        await new Promise<void>((resolveBackend) => {
            let isBackendResolved = false;

            const processNgrokOutput = (data: any) => {
                const output = data.toString();
                if (output.trim()) {
                    console.log(`[NGROK LOG] ${output.trim()}`);
                }

                const match = output.match(/url=(https:\/\/[a-zA-Z0-9-]+\.ngrok[^\s]*)/i);
                
                if (match && !backendNgrokUrl && !isBackendResolved) {
                    backendNgrokUrl = match[1];
                    console.log(`✅ Backend Tunnel Ready: ${backendNgrokUrl}`);
                    
                    // Persist tunnel URL so Expo can call the API from browser/mobile environments.
                    const envPath = path.join(TARGET_EXPO_PATH, '.env');
                    let envContent = '';
                    if (fs.existsSync(envPath)) {
                        envContent = fs.readFileSync(envPath, 'utf8');
                    }
                    
                    envContent = envContent.replace(/^EXPO_PUBLIC_API_URL=.*$/gm, '').trim();
                    envContent += `\nEXPO_PUBLIC_API_URL=${backendNgrokUrl}\n`;
                    fs.writeFileSync(envPath, envContent.trim() + '\n');
                    console.log(`💉 Injected EXPO_PUBLIC_API_URL into Expo App`);
                    
                    isBackendResolved = true;
                    resolveBackend();
                }
            };

            // Ngrok can emit the URL on stdout or stderr depending on version/platform.
            currentNgrokProcess?.stdout?.on('data', processNgrokOutput);
            currentNgrokProcess?.stderr?.on('data', processNgrokOutput);

            setTimeout(() => {
                if (!isBackendResolved) {
                    console.log("⚠️ Ngrok backend tunnel timeout. Continuing without it...");
                    isBackendResolved = true;
                    resolveBackend();
                }
            }, 15000);
        });
    }

    return new Promise((resolve) => {
        console.log("🚀 Starting new Expo Web Server...");
        
        currentExpoProcess = spawn('npx', ['expo', 'start', '--web', '--port', port.toString()], {
            cwd: TARGET_EXPO_PATH,
            shell: true
        });

        let isResolved = false;
        let serverReady = false;

        // Expo startup logs vary by version; match multiple readiness signatures.
        const processOutput = (data: any) => {
            const rawString = data.toString();
            if (rawString.includes('http://localhost') || rawString.includes('Web is waiting on') || rawString.includes('ready in')) {
                serverReady = true;
            }
        };

        currentExpoProcess.stdout?.on('data', processOutput);
        currentExpoProcess.stderr?.on('data', processOutput);

        const checkInterval = setInterval(async () => {
            if (serverReady && !isResolved) {
                isResolved = true;
                clearInterval(checkInterval);
                
                try {
                    console.log(`🌐 Expo Server ready! Taking snapshot...`);
                    const browser = await puppeteer.launch({ headless: true });
                    const page = await browser.newPage();
                    await page.setViewport({ width: 390, height: 844, isMobile: true });
                    
                    await page.goto(localUrl, { waitUntil: 'networkidle2', timeout: 30000 });
                    await page.screenshot({ path: snapshotPath });
                    await browser.close();
                    
                    resolve({ snapshotPath, publicUrl: mobileUrl, localUrl });
                } catch (error: any) {
                    // Snapshot failure should not fail the entire request pipeline.
                    console.log(`⚠️ Puppeteer failed: ${error.message}`);
                    resolve({ snapshotPath: null, publicUrl: mobileUrl, localUrl, warning: `Snapshot failed: ${error.message}` });
                }
            }
        }, 1000);

        // Hard timeout so callers are not blocked forever by server boot issues.
        setTimeout(async () => {
            if (!isResolved) {
                isResolved = true;
                clearInterval(checkInterval);
                resolve({ snapshotPath: null, publicUrl: mobileUrl, localUrl, warning: "⚠️ Server start timeout." });
            }
        }, 30000); 
    });
}
