import OpenAI from 'openai';

export function createDeepseekClient(): OpenAI {
  return new OpenAI({
    baseURL: 'https://api.deepseek.com',
    apiKey: process.env.DEEPSEEK_API_KEY as string,
  });
}

