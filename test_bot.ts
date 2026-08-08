import { bot } from './src/bot/telegram.ts';
bot.api.sendMessage(1348898450, "<b>Prueba HTML con Botón</b>\nTest", { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[ {text: 'OK', callback_data: 'ok'} ]] } })
  .then((res) => { console.log("OK:", res.message_id); process.exit(0); })
  .catch((err) => { console.error("ERR:", err); process.exit(1); });
