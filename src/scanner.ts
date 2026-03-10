import fs from 'fs';
import path from 'path';

// Keep the tree shallow to reduce prompt size sent to the model.
export function getProjectTree(dirPath: string, prefix: string = '', currentDepth: number = 0, maxDepth: number = 2): string {
    let tree = '';
    if (!fs.existsSync(dirPath)) return tree;

    if (currentDepth > maxDepth) {
        return `${prefix}└── ... (más archivos. Usa 'ls' o 'search_project' para explorar aquí)\n`;
    }

    const items = fs.readdirSync(dirPath);
    
    const ignoreDirs = ['node_modules', '.git', 'assets', 'dist', '.expo', 'workspaces', 'ios', 'android', 'web-build', 'scripts', '.github', 'components/__tests__'];
    const ignoreFiles = ['package-lock.json', 'yarn.lock', 'bun.lockb', 'babel.config.js', 'metro.config.js', 'app.json', 'eas.json', '.gitignore', '.env', '.env.example'];

    // Sort directories first to produce a predictable, human-readable tree.
    items.sort((a, b) => {
        const aIsDir = fs.statSync(path.join(dirPath, a)).isDirectory();
        const bIsDir = fs.statSync(path.join(dirPath, b)).isDirectory();
        if (aIsDir && !bIsDir) return -1;
        if (!aIsDir && bIsDir) return 1;
        return a.localeCompare(b);
    });

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const fullPath = path.join(dirPath, item);
        const isLast = i === items.length - 1;
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
            if (!ignoreDirs.includes(item)) {
                tree += `${prefix}${isLast ? '└── ' : '├── '}${item}/\n`;
                tree += getProjectTree(fullPath, prefix + (isLast ? '    ' : '│   '), currentDepth + 1, maxDepth);
            }
        } else {
            if (!ignoreFiles.includes(item) && !item.startsWith('.')) {
                tree += `${prefix}${isLast ? '└── ' : '├── '}${item}\n`;
            }
        }
    }
    return tree;
}

// Accept both hidden and non-hidden UnityRC variants.
export function getProjectMemory(repoPath: string): string | null {
    const possibleNames = [
        '.unityrc.md', 
        'unityrc.md', 
        '.unityrc.md.txt', 
        'unityrc.md.txt'
    ];
    
    for (const name of possibleNames) {
        const memoryPath = path.join(repoPath, name);
        if (fs.existsSync(memoryPath)) {
            console.log(`🧠 Memoria de proyecto detectada y cargada desde: ${name}`);
            return fs.readFileSync(memoryPath, 'utf8');
        }
    }
    
    console.log(`⚠️ No se encontró memoria de proyecto en la raíz de: ${repoPath}`);
    return null;
}
