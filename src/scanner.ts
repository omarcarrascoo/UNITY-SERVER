import fs from 'fs';
import path from 'path';

export function getProjectContext(dirPath: string, baseDir: string = dirPath): string {
    let context = '';
    if (!fs.existsSync(dirPath)) return context; 

    const items = fs.readdirSync(dirPath);
    
    // 🛡️ Filtros estrictos para no saturar a la IA
    const ignoreDirs = ['node_modules', '.git', 'assets', 'dist', '.expo', 'workspaces', 'ios', 'android', 'web-build', 'scripts', '.github'];
    const ignoreFiles = ['package-lock.json', 'yarn.lock', 'bun.lockb', 'babel.config.js', 'metro.config.js', 'app.json', 'eas.json'];

    for (const item of items) {
        const fullPath = path.join(dirPath, item);
        const stat = fs.statSync(fullPath);
        
        if (stat.isDirectory()) {
            if (!ignoreDirs.includes(item)) {
                context += getProjectContext(fullPath, baseDir);
            }
        } else {
            // Solo leemos código fuente
            if (/\.(js|jsx|ts|tsx)$/.test(item) && !ignoreFiles.includes(item)) {
                const relativePath = path.relative(baseDir, fullPath);
                const content = fs.readFileSync(fullPath, 'utf8');
                
                // Límite de 20,000 caracteres por archivo
                if (content.length < 20000) {
                    context += `\n--- FILE: ${relativePath} ---\n${content}\n`;
                } else {
                    console.log(`⚠️ Archivo muy grande saltado: ${relativePath}`);
                }
            }
        }
    }
    return context;
}