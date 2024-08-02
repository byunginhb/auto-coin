require('dotenv').config();
const express = require('express');
const bot = require('./telegram').bot;
const futureBot = require('./telegram').futureBot;
const binance = require('./binance_spot').binance;
const binanceFutures = require('./binance_futures').binance;
const { sendUSDTBalance } = require('./binance_common').binance_common;
const app = express();
const port = process.env.PORT || 3000;
const chatId = process.env.TELEGRAM_BOT_CHAT_ID;
const cron = require('node-cron');

// back test
// const future_backtest = require('./future_backtest').backtest;
// const spot_backtest = require('./spot_backtest').backtest;
// const martin_bb_backtest = require('./martin_bb_backtest').backtest;
// const future_backtest_ma_bol = require('./future_backtest_ma_bol').backtest;
// const future_backtest_bb_stochrsi =
//   require('./future_backtest_bb_stochrsi').backtest;
// const future_backtest_bb_rsi = require('./future_backtest_bb_rsi').backtest;

cron.schedule('5 0 * * *', async () => {
  try {
    sendUSDTBalance(binance.binance, true);
    console.log('API 호출 성공:', response.data);
  } catch (error) {
    console.error('API 호출 실패:', error);
  }
});

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
