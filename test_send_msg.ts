import { config } from '/home/agustinbonino/Descargas/JARVIS/src/config.js';
import { Bot } from 'grammy';
const testBot = new Bot(config.TELEGRAM_BOT_TOKEN);
async function main() {
    console.log("Testing sendMessage...");
    try {
        await testBot.api.sendMessage(config.TELEGRAM_ALLOWED_USER_IDS[0], 'Test without ipv4Agent');
        console.log("Success");
    } catch(e) {
        console.error("Failed:", e);
    }
}
main();
