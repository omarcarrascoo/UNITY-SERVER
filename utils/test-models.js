import 'dotenv/config';

async function checkModels() {
    console.log('🔍 Consultando a Google qué modelos tienes habilitados...');
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`);
    const data = await response.json();
    
    if (data.models) {
        console.log('\n✅ Modelos disponibles para tu API Key:');
        data.models
            .filter(m => m.supportedGenerationMethods.includes('generateContent'))
            .forEach(m => console.log(`👉 ${m.name.replace('models/', '')}`));
    } else {
        console.log('❌ Error leyendo modelos:', data);
    }
}

checkModels();
