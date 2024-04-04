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
const rsiBuyThreshold = 40; // RSI 과매도 조건
const rsiSellThreshold = 60; // RSI 과매수 조건

let tradeIntervalHandler = null;
let monitorIntervalHandler = null;
let telegramBot = null;
let monitorCount = 0;

function sendMessage(message) {
  telegramBot.sendMessage(chatId, message);
}

function setTelegramBot(bot) {
  telegramBot = bot;
}

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
  monitorCount++;
  try {
    const candles = await fetchCandlestickData(symbol, interval, 500);
    const { rsi, bb, lastClose } = await calculateIndicators(candles);

    const accountInfo = await binance.futuresAccount();
    const usdtBalance = accountInfo.assets.find(
      (asset) => asset.asset === 'USDT'
    ).walletBalance;
    const currentPrice = await getCurrentPrice(symbol);
    const quantity = (usdtBalance / currentPrice).toFixed(3); // Adjust based on the asset

    if (monitorCount >= 10) {
      sendMessage(
        `${symbol} - RSI: ${rsi}, 
        마지막 금액: ${lastClose}, 
        볼린저 하단: ${bb.lower}, 
        볼린저 상단: ${bb.upper}`
      );
      monitorCount = 0;
    }

    // 롱 포지션 개시 조건
    if (quantity > 0 && (rsi < rsiBuyThreshold || lastClose < bb.lower)) {
      console.log('롱 포지션 개시 조건 충족');
      await openPosition(symbol, quantity, 'LONG', lastClose);
    }
    // 숏 포지션 개시 조건
    else if (quantity > 0(rsi > rsiSellThreshold || lastClose > bb.upper)) {
      console.log('숏 포지션 개시 조건 충족');
      await openPosition(symbol, quantity, 'SHORT', lastClose);
    }
  } catch (error) {
    console.error('Execute trade failed:', error);
  }
}

async function monitorPrice() {
  // 사용자의 현재 포지션 정보 조회
  const accountInfo = await binance.futuresAccount();
  const positions = accountInfo.positions.filter(
    (position) => parseFloat(position.positionAmt) !== 0
  );

  if (positions.length === 0) {
    console.log('No open positions to monitor.');
    return;
  }

  for (let pos of positions) {
    const symbol = pos.symbol;
    const entryPrice = parseFloat(pos.entryPrice);
    const positionAmt = parseFloat(pos.positionAmt);
    //const markPrice = parseFloat(pos.markPrice); // 현재 시장 가격
    const markPrice = await getCurrentPrice(symbol);

    let priceChangePercent = ((markPrice - entryPrice) / entryPrice) * 100;

    // 숏 포지션의 경우 수익률 계산 방식 조정
    if (positionAmt < 0) {
      priceChangePercent = ((entryPrice - markPrice) / entryPrice) * 100;
    }

    console.log(
      `[Monitoring] ${symbol} - Entry Price: ${entryPrice}, Mark Price: ${markPrice}, Change: ${priceChangePercent.toFixed(
        2
      )}%`
    );

    if (monitorCount >= 10) {
      sendMessage(
        `[Monitoring] ${symbol} - 진입 금액: ${entryPrice}, 현재 금액: ${markPrice}, 상태: ${priceChangePercent.toFixed(
          2
        )}%`
      );
    }

    // 수익률 조건 체크
    if (priceChangePercent >= 3 || priceChangePercent <= -1) {
      sendMessage(
        `청산 ${symbol} position with ${priceChangePercent.toFixed(2)}% return.`
      );
      if (positionAmt > 0) {
        sendMessage('롱 포지션 청산');
        await binance.futuresMarketSell(symbol, Math.abs(positionAmt)); // 롱 포지션 청산
      } else {
        sendMessage('숏 포지션 청산');
        await binance.futuresMarketBuy(symbol, Math.abs(positionAmt)); // 숏 포지션 청산
      }
    }
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
      sendMessage(`${quantity} ${entryPrice} 롱 포지션 실행.`);
    } catch (error) {
      console.error(`Failed to open long position for ${symbol}:`, error);
    }
  } else if (type === 'SHORT') {
    // 숏 포지션을 위한 매도 주문 실행
    try {
      const order = await binance.futuresMarketSell(symbol, quantity);
      console.log(`Short position opened: `, order);
      sendMessage(`${quantity} ${entryPrice} 숏 포지션 실행.`);
    } catch (error) {
      console.error(`Failed to open short position for ${symbol}:`, error);
    }
  }
}

async function startTrade(symbol, interval = '1m') {
  try {
    monitorCount = 0;
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

const setMonitorCount = (count) => {
  monitorCount = count;
};

// startTrade('BTCUSDT', '1m');

exports.binance = { startTrade, endTrade, setTelegramBot, setMonitorCount };
