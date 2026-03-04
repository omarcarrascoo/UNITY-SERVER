import { spawn } from 'child_process';
import path from 'path';
import puppeteer from 'puppeteer';
import { WORKSPACE_DIR, TARGET_REPO_PATH } from './config.js';

export async function takeSnapshot(targetRoute: string = '/'): Promise<string> {
    
    // 🧹 Sanitizador de Rutas de Expo Router
    let safeRoute = targetRoute;
    safeRoute = safeRoute.replace(/^\/?app\//, '/'); 
    safeRoute = safeRoute.replace(/\/\([^)]+\)/g, ''); 
    safeRoute = safeRoute.replace(/\/index\/?$/i, ''); 
    if (!safeRoute || safeRoute === '') safeRoute = '/';
    if (!safeRoute.startsWith('/')) safeRoute = '/' + safeRoute;

    console.log(`📸 Requested route: ${targetRoute} | Sanitized URL: ${safeRoute}`);
    
    const snapshotPath = path.join(WORKSPACE_DIR, 'snapshot.png');
    const port = 8081;

    return new Promise((resolve, reject) => {
        const expoProcess = spawn('npx', ['expo', 'start', '--web', '--port', port.toString()], {
            cwd: TARGET_REPO_PATH,
            shell: true
        });

        let isResolved = false;

        expoProcess.stdout.on('data', async (data) => {
            if (data.toString().includes('http://localhost') && !isResolved) {
                isResolved = true;
                console.log(`🌐 Expo web ready. Navigating to http://localhost:${port}${safeRoute} ...`);
                
                try {
                    await new Promise(r => setTimeout(r, 8000)); 

                    const browser = await puppeteer.launch({ headless: true });
                    const page = await browser.newPage();
                    await page.setViewport({ width: 390, height: 844, isMobile: true });
                    
                    await page.goto(`http://localhost:${port}${safeRoute}`, { waitUntil: 'networkidle2', timeout: 60000 });
                    await page.screenshot({ path: snapshotPath });
                    
                    console.log('📸 Snapshot captured and saved.');
                    await browser.close();
                    expoProcess.kill(); 
                    resolve(snapshotPath);
                } catch (error) {
                    expoProcess.kill();
                    reject(error);
                }
            }
        });

        setTimeout(() => {
            if (!isResolved) {
                expoProcess.kill();
                reject(new Error("Timeout: Expo took too long to start."));
            }
        }, 60000); 
    });
}