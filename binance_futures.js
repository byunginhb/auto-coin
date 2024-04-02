require('dotenv').config();
const Binance = require('node-binance-api');
const { BollingerBands, RSI } = require('technicalindicators');
const chatId = process.env.TELEGRAM_BOT_CHAT_ID;

const binance = new Binance().options({
  APIKEY: process.env.BINANCE_API_KEY,
  APISECRET: process.env.BINANCE_API_SECRET,
  family: 4,
});

// 매수 및 매도 조건 설정
const rsiBuyThreshold = 30; // RSI 과매도 조건
const rsiSellThreshold = 70; // RSI 과매수 조건

let tradeIntervalHandler = null;
let monitorIntervalHandler = null;
let telegramBot = null;

function sendMessage(message) {
  telegramBot.sendMessage(chatId, message);
}

function setTelegramBot(bot) {
  telegramBot = bot;
}

let position = {
  symbol: null,
  entryPrice: null,
  quantity: null,
  type: null, // 'LONG' 또는 'SHORT'
  isOpen: false,
};

async function fetchCandlestickData(symbol, interval, limit) {
  return binance.futuresCandles(symbol, interval, { limit: limit });
}

async function calculateIndicators(candles) {
  const closes = candles.map((c) => parseFloat(c[4]));
  const rsiValues = RSI.calculate({ period: 14, values: closes });
  const bbValues = BollingerBands.calculate({
    period: 20,
    stdDev: 2,
    values: closes,
  });
  return {
    rsi: rsiValues[rsiValues.length - 1],
    bb: bbValues[bbValues.length - 1],
    lastClose: closes[closes.length - 1],
  };
}

async function getCurrentPrice(symbol) {
  const prices = await binance.futuresPrices();
  return parseFloat(prices[symbol]);
}

async function executeTrade(symbol, interval) {
  try {
    const candles = await fetchCandlestickData(symbol, interval, 500);
    const { rsi, bb, lastClose } = await calculateIndicators(candles);

    const accountInfo = await binance.futuresAccount();
    const usdtBalance = accountInfo.assets.find(
      (asset) => asset.asset === 'USDT'
    ).walletBalance;
    const currentPrice = await getCurrentPrice(symbol);
    const quantity = (usdtBalance / currentPrice).toFixed(3); // Adjust based on the asset

    // 롱 포지션 개시 조건
    if (!position.isOpen && (rsi < 30 || lastClose < bb.lower)) {
      console.log('롱 포지션 개시 조건 충족');
      await openPosition(symbol, quantity, 'LONG', lastClose);
    }
    // 숏 포지션 개시 조건
    else if (!position.isOpen && (rsi > 70 || lastClose > bb.upper)) {
      console.log('숏 포지션 개시 조건 충족');
      await openPosition(symbol, quantity, 'SHORT', lastClose);
    }
  } catch (error) {
    console.error('Execute trade failed:', error);
  }
}

async function monitorPrice() {
  if (!position.isOpen) return;

  const currentPrice = await getCurrentPrice(position.symbol);
  const priceChangePercent =
    ((currentPrice - position.entryPrice) / position.entryPrice) * 100;

  // 청산 조건 체크
  if (
    (position.type === 'LONG' &&
      (priceChangePercent <= -3 || priceChangePercent >= 10)) ||
    (position.type === 'SHORT' &&
      (priceChangePercent >= 3 || priceChangePercent <= -10))
  ) {
    await closePosition();
  }
}

async function openPosition(symbol, quantity, type, entryPrice) {
  console.log(
    `Opening ${type} position for ${symbol} with quantity ${quantity}`
  );
  if (type === 'LONG') {
    // 롱 포지션을 위한 매수 주문 실행
    try {
      const order = await binance.futuresMarketBuy(symbol, quantity);
      console.log(`Long position opened: `, order);
      sendMessage(
        `Long position opened: ${quantity} ${entryPrice} 롱 포지션 실행.`
      );
      position = { symbol, entryPrice, quantity, type, isOpen: true };
    } catch (error) {
      console.error(`Failed to open long position for ${symbol}:`, error);
    }
  } else if (type === 'SHORT') {
    // 숏 포지션을 위한 매도 주문 실행
    try {
      const order = await binance.futuresMarketSell(symbol, quantity);
      console.log(`Short position opened: `, order);
      sendMessage(
        `Short position opened: ${quantity} ${entryPrice} 숏 포지션 실행.`
      );
      position = { symbol, entryPrice, quantity, type, isOpen: true };
    } catch (error) {
      console.error(`Failed to open short position for ${symbol}:`, error);
    }
  }
}

async function closePosition() {
  if (!position.isOpen) {
    console.log('No position to close.');
    return;
  }
  console.log(
    `Closing ${position.type} position for ${position.symbol} with quantity ${position.quantity}`
  );
  if (position.type === 'LONG') {
    // 롱 포지션 청산을 위한 매도 주문 실행
    try {
      const order = await binance.futuresMarketSell(
        position.symbol,
        position.quantity
      );
      console.log(`Long position closed: `, order);
      position.isOpen = false;
    } catch (error) {
      console.error(
        `Failed to close long position for ${position.symbol}:`,
        error
      );
    }
  } else if (position.type === 'SHORT') {
    // 숏 포지션 청산을 위한 매수 주문 실행
    try {
      const order = await binance.futuresMarketBuy(
        position.symbol,
        position.quantity
      );
      console.log(`Short position closed: `, order);
      position.isOpen = false;
    } catch (error) {
      console.error(
        `Failed to close short position for ${position.symbol}:`,
        error
      );
    }
  }
}

async function startTrade(symbol, interval = '5m') {
  try {
    if (tradeIntervalHandler !== null) {
      clearInterval(tradeIntervalHandler);
      tradeIntervalHandler = null;
      console.log('실행중인 트레이딩을 종료합니다.');
    }

    if (monitorIntervalHandler !== null) {
      clearInterval(monitorIntervalHandler);
      monitorIntervalHandler = null;
      console.log('실행중인 모니터링을 종료합니다.');
    }

    // trade(symbol, interval);

    executeTrade(symbol, interval);
    // 1분마다 trade 함수 실행
    tradeIntervalHandler = setInterval(
      () => executeTrade(symbol, interval),
      60 * 1000
    );
    monitorIntervalHandler = setInterval(monitorPrice, 20 * 1000);
    console.log('트레이딩을 실행합니다.');
  } catch (error) {
    console.error('Trade execution start failed:', error);
  }
}

async function endTrade() {
  try {
    if (tradeIntervalHandler !== null) {
      clearInterval(tradeIntervalHandler);
      tradeIntervalHandler = null;
      console.log('트레이딩을 종료합니다.');
    }

    if (monitorIntervalHandler !== null) {
      clearInterval(monitorIntervalHandler);
      monitorIntervalHandler = null;
      console.log('실행중인 모니터링을 종료합니다.');
    }
  } catch (error) {
    console.error('Trade execution end failed:', error);
  }
}

startTrade('BTCUSDT', '1m');

exports.binance = { startTrade, endTrade, setTelegramBot };
