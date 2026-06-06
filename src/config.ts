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
  GOOGLE_DRIVE_REFRESH_TOKEN: process.env.GOOGLE_DRIVE_REFRESH_TOKEN || '',
  GOOGLE_OAUTH_CLIENT_ID: process.env.GOOGLE_OAUTH_CLIENT_ID || '',
  GOOGLE_OAUTH_CLIENT_SECRET: process.env.GOOGLE_OAUTH_CLIENT_SECRET || '',
  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY || '',
  FIRESTORE_PROJECT_ID: process.env.FIRESTORE_PROJECT_ID || 'jarvis-ef6b0',
  // cTrader Open API
  CTRADER_CLIENT_ID: process.env.CTRADER_CLIENT_ID || '',
  CTRADER_CLIENT_SECRET: process.env.CTRADER_CLIENT_SECRET || '',
  CTRADER_ACCESS_TOKEN: process.env.CTRADER_ACCESS_TOKEN || '',
  CTRADER_ACCOUNT_ID: process.env.CTRADER_ACCOUNT_ID || '',
  CTRADER_DEMO: (process.env.CTRADER_DEMO || 'true').toLowerCase() === 'true',
  CTRADER_RISK_PERCENT: parseFloat(process.env.CTRADER_RISK_PERCENT || '1'),
  CTRADER_MAX_POSITIONS: parseInt(process.env.CTRADER_MAX_POSITIONS || '3', 10),
};

// Security Validations
if (!config.TELEGRAM_BOT_TOKEN) {
  throw new Error('CRITICAL: TELEGRAM_BOT_TOKEN is missing in .env');
}

if (config.TELEGRAM_ALLOWED_USER_IDS.length === 0) {
  throw new Error('CRITICAL: TELEGRAM_ALLOWED_USER_IDS is missing or invalid in .env');
}
