import * as dotenv from 'dotenv';
dotenv.config();

export const config = {
  TELEGRAM_BOT_TOKEN: (process.env.TELEGRAM_BOT_TOKEN || '').trim(),
  TELEGRAM_ALLOWED_USER_IDS: (process.env.TELEGRAM_ALLOWED_USER_IDS || '')
    .split(',')
    .map((id) => parseInt(id.trim(), 10))
    .filter((id) => !isNaN(id)),
  GROQ_API_KEY: process.env.GROQ_API_KEY || '',
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
  OPENROUTER_MODEL: process.env.OPENROUTER_MODEL || 'openrouter/free',
  DB_PATH: process.env.DB_PATH || './memory.db',
  // GEMINI API KEY is read automatically by @google/genai if set as GEMINI_API_KEY.
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS || './service-account.json',
  GOOGLE_DRIVE_FOLDER_ID: process.env.GOOGLE_DRIVE_FOLDER_ID || '',
  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY || '',
};

// Security Validations
if (!config.TELEGRAM_BOT_TOKEN) {
  throw new Error('CRITICAL: TELEGRAM_BOT_TOKEN is missing in .env');
}

if (config.TELEGRAM_ALLOWED_USER_IDS.length === 0) {
  throw new Error('CRITICAL: TELEGRAM_ALLOWED_USER_IDS is missing or invalid in .env');
}

if (!config.GEMINI_API_KEY && !config.GROQ_API_KEY && !config.OPENROUTER_API_KEY) {
    console.warn('WARNING: No LLM API keys found. The agent will not be able to think.');
}
