import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import util from 'util';

const execPromise = util.promisify(exec);

// Creates an Expo project preloaded with the project's preferred state, API, and styling stack.
export async function initExpoProject(projectName: string, workspaceDir: string) {
    const projectPath = path.join(workspaceDir, projectName);
    console.log(`🚀 Iniciando creación de Expo App: ${projectName}...`);

    await execPromise(`npx create-expo-app ${projectName} --template default`, { cwd: workspaceDir });

    console.log(`📦 Instalando Zustand, Axios, SecureStore, Fonts, Icons y Tailwind...`);
    const deps = ['zustand', 'axios', 'expo-secure-store', '@react-native-async-storage/async-storage', '@expo-google-fonts/oswald', 'nativewind', 'tailwindcss'].join(' ');
    
    await execPromise(`npx expo install ${deps}`, { cwd: projectPath });
    await execPromise(`npm install --save-dev tailwindcss@3.3.2`, { cwd: projectPath });
    await execPromise(`npx tailwindcss init`, { cwd: projectPath });
    
    // Write deterministic baseline config so generated code can assume NativeWind + Oswald setup.
    const tailwindConfig = `/** @type {import('tailwindcss').Config} */\nmodule.exports = { content: ["./app/**/*.{js,jsx,ts,tsx}", "./components/**/*.{js,jsx,ts,tsx}"], theme: { extend: { fontFamily: { oswald: ['Oswald_400Regular'] } } }, plugins: [] }`;
    fs.writeFileSync(path.join(projectPath, 'tailwind.config.js'), tailwindConfig);

    const babelConfig = `module.exports = function (api) { api.cache(true); return { presets: ['babel-preset-expo'], plugins: ['nativewind/babel'] }; };`;
    fs.writeFileSync(path.join(projectPath, 'babel.config.js'), babelConfig);

    ['components/ui', 'theme', 'store', 'api', 'constants'].forEach(folder => fs.mkdirSync(path.join(projectPath, folder), { recursive: true }));

    fs.writeFileSync(path.join(projectPath, 'theme/index.ts'), `export const COLORS = { primary: '#000000', secondary: '#ffffff' };\nexport const SPACING = { sm: 8, md: 16, lg: 24 };`);
    fs.writeFileSync(path.join(projectPath, 'store/authStore.ts'), `import { create } from 'zustand';\nexport const useAuthStore = create((set) => ({ user: null, token: null, setAuth: (data) => set(data), logout: () => set({ user: null, token: null }) }));`);
    fs.writeFileSync(path.join(projectPath, 'api/axios.ts'), `import axios from 'axios';\nconst api = axios.create({ baseURL: process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3000' });\napi.interceptors.request.use(config => { config.headers['ngrok-skip-browser-warning'] = 'true'; return config; });\nexport default api;`);

    const unityMemory = `# Reglas de Arquitectura - Frontend (Expo)\n1. **Estilos:** Usa SIEMPRE las constantes de \`theme/index.ts\`.\n2. **Estado Global:** Usa Zustand.\n3. **Peticiones HTTP:** Usa SIEMPRE \`api/axios.ts\`.\n4. **TypeScript:** Prohibido el uso de \`any\`.`;
    fs.writeFileSync(path.join(projectPath, '.unityrc.md'), unityMemory);

    console.log(`✅ ¡Plantilla de Expo lista!`);
}

// Creates a NestJS API starter with auth-ready dependencies and Swagger bootstrap.
export async function initNestProject(projectName: string, workspaceDir: string) {
    const projectPath = path.join(workspaceDir, projectName);
    console.log(`🚀 Iniciando creación de NestJS API: ${projectName}...`);

    await execPromise(`npx @nestjs/cli new ${projectName} --package-manager npm --skip-git`, { cwd: workspaceDir });

    console.log(`📦 Instalando Backend Stack...`);
    const deps = ['@nestjs/mongoose', 'mongoose', '@nestjs/jwt', '@nestjs/passport', 'passport', 'passport-jwt', 'bcrypt', 'class-validator', 'class-transformer', '@nestjs/swagger'].join(' ');
    await execPromise(`npm install ${deps}`, { cwd: projectPath });
    await execPromise(`npm install -D @types/passport-jwt @types/bcrypt`, { cwd: projectPath });

    ['src/auth', 'src/users', 'src/common/guards', 'src/common/decorators', 'src/config'].forEach(folder => fs.mkdirSync(path.join(projectPath, folder), { recursive: true }));

    const mainTsPath = path.join(projectPath, 'src/main.ts');
    let mainTs = fs.readFileSync(mainTsPath, 'utf8');
    mainTs = mainTs.replace(
        `await app.listen(process.env.PORT ?? 3000);`,
        `app.enableCors({ origin: true, credentials: true });\n  const { DocumentBuilder, SwaggerModule } = require('@nestjs/swagger');\n  const config = new DocumentBuilder().setTitle('API').setVersion('1.0').addBearerAuth().build();\n  const document = SwaggerModule.createDocument(app, config);\n  SwaggerModule.setup('api/docs', app, document);\n  await app.listen(process.env.PORT ?? 3000);`
    );
    fs.writeFileSync(mainTsPath, mainTs);

    const unityMemory = `# Reglas de Arquitectura - Backend (NestJS)\n1. **Base de Datos:** Mongoose estricto.\n2. **Validación:** DTOs con class-validator.\n3. **Seguridad:** Guards de JWT para rutas protegidas.`;
    fs.writeFileSync(path.join(projectPath, '.unityrc.md'), unityMemory);

    console.log(`✅ ¡Plantilla de NestJS lista!`);
}

// Creates a monorepo container and scaffolds backend + mobile projects inside it.
export async function initFullstackProject(projectName: string, workspaceDir: string) {
    const projectRoot = path.join(workspaceDir, projectName);
    console.log(`🚀 Creando Monorepo Fullstack: ${projectName}...`);
    fs.mkdirSync(projectRoot, { recursive: true });
    await initNestProject('api', projectRoot);
    await initExpoProject('mobile', projectRoot);
    console.log(`✅ ¡Monorepo Fullstack creado con éxito!`);
}
