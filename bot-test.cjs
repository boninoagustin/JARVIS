const { Bot } = require('grammy');
const bot = new Bot("8290529986:AAG6ghovv8T8FfmY9eI1TC5DOd4utxd-tEk");

console.log("Starting minimal bot...");
bot.api.getMe().then(me => {
    console.log("Logged in as", me.username);
    bot.start();
}).catch(err => {
    console.error("Failed:", err);
});
