require('dotenv').config();
const express = require('express');
const bot = require('./telegram').bot;
const binance = require('./binance').binance;
const app = express();
const port = process.env.PORT || 3000;
const chatId = '239211182';

app.get('/', (req, res) => {
  res.send('Hello World!');
});

app.get('/check', (req, res) => {
  bot.sendMessage(chatId, 'check');
  res.send('check');
});

app.get('/backtest', (req, res) => {
  const symbol = req.query.symbol;
  const finalSymbol = symbol || 'BTCUSDT';

  bot.sendMessage(chatId, 'start backtest');
  binance.backtest(finalSymbol, '5m');
  res.send('backtest');
});

app.get('/trade/start', (req, res) => {
  const symbol = req.query.symbol;
  const finalSymbol = symbol || 'BTCUSDT';

  const sendMessage = (message) => {
    bot.sendMessage(chatId, message);
  };

  binance.startTrade(finalSymbol, '5m', sendMessage);
  bot.sendMessage(chatId, 'start trade');
  res.send('trade start');
});

app.get('/trade/end', (req, res) => {
  binance.endTrade();
  bot.sendMessage(chatId, 'end trade');
  res.send('trade start');
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
