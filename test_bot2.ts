import { bot } from './src/bot/telegram.js';
bot.api.sendMessage(1348898450, "<b>Prueba TEXTO PLANO via ts</b>\nTest", { parse_mode: 'HTML' })
  .then((res) => { console.log("OK:", res.message_id); process.exit(0); })
  .catch((err) => { console.error("ERR:", err); process.exit(1); });
