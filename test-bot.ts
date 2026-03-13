import { Bot } from 'grammy';
import * as dotenv from 'dotenv';
dotenv.config();

const token = process.env.TELEGRAM_BOT_TOKEN || '';
const bot = new Bot(token);

console.log('Testing bot connection with token:', token.substring(0, 10) + '...');

try {
    const me = await bot.api.getMe();
    console.log('SUCCESS! Connected to Telegram as:', me.username);
    process.exit(0);
} catch (err) {
    console.error('FAILED to connect to Telegram:', err);
    process.exit(1);
}
