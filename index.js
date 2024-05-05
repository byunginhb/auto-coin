require('dotenv').config();
const express = require('express');
const bot = require('./telegram').bot;
const futureBot = require('./telegram').futureBot;
const binance = require('./binance').binance;
const binanceFutures = require('./binance_futures').binance;
const backTest = require('./backtest').backTest;
const app = express();
const port = process.env.PORT || 3000;
const chatId = process.env.TELEGRAM_BOT_CHAT_ID;

app.get('/', (req, res) => {
  res.send('Hello World!');
});

app.get('/check', (req, res) => {
  bot.sendMessage(chatId, 'check');
  res.send('check');
});

app.get('/backtest', (req, res) => {
  const symbol = req.query.symbol;
  const rb = req.query.rb;
  const rs = req.query.rs;
  const finalSymbol = symbol || 'BTCUSDT';

  bot.sendMessage(chatId, 'start backtest');
  binance.backtest(finalSymbol, rb, rs, '5m');
  res.send('backtest');
});

app.get('/trade/start', (req, res) => {
  const symbol = req.query.symbol;
  const finalSymbol = symbol || 'BTCUSDT';

  binance.startTrade(finalSymbol, '5m');
  bot.sendMessage(chatId, 'start trade');
  res.send('trade start');
});

app.get('/futures/start', (req, res) => {
  const symbol = req.query.symbol;
  const finalSymbol = symbol || 'BTCUSDT';

  binanceFutures.startTrade(finalSymbol, '5m');
  bot.sendMessage(chatId, 'start trade');
  res.send('trade start');
});

app.get('/futures/end', (req, res) => {
  binanceFutures.endTrade();
  bot.sendMessage(chatId, 'end trade');
  res.send('trade end');
});

app.get('/trade/end', (req, res) => {
  binance.endTrade();
  bot.sendMessage(chatId, 'end trade');
  res.send('trade end');
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
  binance.setTelegramBot(bot);
  binanceFutures.setTelegramBot(futureBot);
});
