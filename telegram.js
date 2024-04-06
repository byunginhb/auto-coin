require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { binance } = require('./binance');
const binanceFutures = require('./binance_futures').binance;
const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const args = msg.text.split(' ');
  if (args[0] === '/시작' && args.length === 2) {
    const symbol = args[1];
    binance.startTrade(symbol, '5m');
    bot.sendMessage(chatId, `자동 거래 시작`);
  } else if (args[0] === '/종료') {
    binance.endTrade();
    bot.sendMessage(chatId, `자동 거래 종료`);
  } else if (args[0] === '/테스트') {
    const symbol = args[1];
    const rb = args[2];
    const rs = args[3];
    binance.backtest(symbol, rb, rs, '5m');
    bot.sendMessage(chatId, `백테스트 시작`);
  } else if (args[0] === '/선물') {
    const symbol = args[1];
    binanceFutures.startTrade(symbol, '5m');
    bot.sendMessage(chatId, `자동 거래 시작`);
  } else if (args[0] === '/선물종료') {
    binanceFutures.endTrade();
    bot.sendMessage(chatId, `자동 거래 종료`);
  } else if (args[0] === '/체크') {
    binance.setMonitorCount(101);
    binanceFutures.setMonitorCount(101);
  } else {
    bot.sendMessage(chatId, `Received your message ${msg.text}`);
  }
});

exports.bot = bot;
