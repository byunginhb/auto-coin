require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { binance } = require('./binance');
const binanceFutures = require('./binance_futures').binance;
const token = process.env.TELEGRAM_BOT_TOKEN;
const futureToken = process.env.TELEGRAM_FUTURE_BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });
const futureBot = new TelegramBot(futureToken, { polling: true });

bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const args = msg.text.split(' ');
  if (args[0] === '/시작') {
    const symbol = args[1];
    const interval = args[2];
    binance.startTrade(symbol, interval);
    bot.sendMessage(chatId, `자동 거래 시작`);
  } else if (args[0] === '/종료') {
    binance.endTrade();
    bot.sendMessage(chatId, `자동 거래 종료`);
  } else if (args[0] === '/잔액') {
    const symbol = args[1];
    binance.getBalance(symbol);
  } else if (args[0] === '/현재') {
    const symbol = args[1];
    binance.sendTradeData(symbol);
  } else {
    bot.sendMessage(chatId, `Received your message ${msg.text}`);
  }
});

futureBot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const args = msg.text.split(' ');
  if (args[0] === '/시작') {
    const symbol = args[1];
    const interval = args[2];
    binanceFutures.startTrade(symbol, interval);
    futureBot.sendMessage(chatId, `자동 거래 시작`);
  } else if (args[0] === '/종료') {
    binanceFutures.endTrade();
    futureBot.sendMessage(chatId, `자동 거래 종료`);
  } else if (args[0] === '/체크') {
    binanceFutures.sendPositionData();
  } else if (args[0] === '/잔액') {
    binanceFutures.sendUSDTBalance();
  } else {
    futureBot.sendMessage(chatId, `Received your message ${msg.text}`);
  }
});

exports.bot = bot;
exports.futureBot = futureBot;
