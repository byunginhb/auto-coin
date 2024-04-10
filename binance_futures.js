require('dotenv').config();
const Binance = require('node-binance-api');
const { BollingerBands, RSI } = require('technicalindicators');
const chatId = process.env.TELEGRAM_BOT_CHAT_ID;

const binance = new Binance().options({
  APIKEY: process.env.BINANCE_API_KEY,
  APISECRET: process.env.BINANCE_API_SECRET,
  family: 4,
});

function truncateNumber(strNum, digits) {
  let num = Number(strNum);
  let factor = Math.pow(10, digits);
  num = Math.floor(num * factor) / factor;
  return num.toString();
}

// 매수 및 매도 조건 설정
const rsiBuyThreshold = 40; // RSI 과매도 조건
const rsiSellThreshold = 60; // RSI 과매수 조건

let intervalHandler = null;
let monitorIntervalHandler = null;

let telegramBot = null;
let monitorCount = 0;
let leverage = 21;
let setLeverage = 30;
let stopLossPercent = -7;

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

async function trade(symbol, interval = '1m') {
  try {
    //레버리지 설정
    await binance.futuresLeverage(symbol, setLeverage);

    const candles = await fetchCandlestickData(symbol, interval, 500);
    const { rsi, bb, lastClose } = await calculateIndicators(candles);

    const accountInfo = await binance.futuresAccount();
    const usdtBalance = accountInfo.assets.find(
      (asset) => asset.asset === 'USDT'
    ).walletBalance;
    const currentPrice = await getCurrentPrice(symbol);
    const quantity = ((usdtBalance / currentPrice) * leverage).toFixed(3);

    const positions = accountInfo.positions.filter(
      (position) => parseFloat(position.positionAmt) !== 0
    );

    let positionAmt = 0;
    if (positions.length > 0) {
      const pos = positions[0];
      positionAmt = parseFloat(pos.positionAmt);
    }

    if (monitorCount >= 100) {
      sendMessage(
        `${symbol} - 선물 RSI: ${rsi},
        마지막 금액: ${lastClose},
        볼린저 하단: ${bb.lower.toFixed(3)},
        볼린저 상단: ${bb.upper.toFixed(3)}`
      );
    }

    // 매수 조건 확인
    if (positionAmt < 0 && (rsi < rsiBuyThreshold || lastClose < bb.lower)) {
      await closePosition();
      await openPosition(symbol, quantity, 'LONG', lastClose);
      sendMessage(
        `롱포지션 조건 충족. ${usdtBalance} 수량으로 ${currentPrice} ${symbol} 롱포지션 실행.`
      );
    }
    // 매도 조건 확인
    else if (
      positionAmt > 0 &&
      (rsi > rsiSellThreshold || lastClose > bb.upper)
    ) {
      await closePosition();
      await openPosition(symbol, quantity, 'SHORT', lastClose);

      sendMessage(
        `숏포지션 조건 충족. ${quantity} 수량으로 ${currentPrice} ${symbol} 포지션 진입`
      );
    } else {
      console.log('조건에 해당하지 않음. 대기합니다.');
    }
  } catch (error) {
    console.error('Trade execution failed:', error);
    sendMessage('선물 트레이딩 실패: ' + error.message);
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

async function closePosition() {
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
    const markPrice = await getCurrentPrice(symbol);

    let priceChangePercent = ((markPrice - entryPrice) / entryPrice) * 100;

    // 숏 포지션의 경우 수익률 계산 방식 조정
    if (positionAmt < 0) {
      priceChangePercent = ((entryPrice - markPrice) / entryPrice) * 100;
    }

    if (positionAmt > 0) {
      sendMessage(
        `롱 포지션 청산 ${symbol} position with ${priceChangePercent.toFixed(
          2
        )}% return.`
      );
      await binance.futuresMarketSell(symbol, Math.abs(positionAmt)); // 롱 포지션 청산
    } else {
      sendMessage(
        `숏 포지션 청산 ${symbol} position with ${priceChangePercent.toFixed(
          2
        )}% return.`
      );
      await binance.futuresMarketBuy(symbol, Math.abs(positionAmt)); // 숏 포지션 청산
    }
  }
}

async function monitorPrice() {
  monitorCount++;
  // 사용자의 현재 포지션 정보 조회
  const accountInfo = await binance.futuresAccount();
  const positions = accountInfo.positions.filter(
    (position) => parseFloat(position.positionAmt) !== 0
  );

  if (positions.length === 0) {
    console.log('No open positions to monitor.');
    if (monitorCount >= 100) {
      sendMessage('진행중인 포지션이 없습니다.');
      monitorCount = 0;
    }
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

    //손절 로직
    if (priceChangePercent <= stopLossPercent) {
      await closePosition();
    }

    if (monitorCount >= 100) {
      sendMessage(
        `[Monitoring] ${symbol} - 진입 금액: ${entryPrice}, 현재 금액: ${markPrice}, 상태: ${priceChangePercent.toFixed(
          2
        )}%`
      );
      monitorCount = 0;
    }
  }
}

async function startTrade(symbol, interval = '1m') {
  monitorCount = 100;
  try {
    if (intervalHandler !== null) {
      clearInterval(intervalHandler);
      intervalHandler = null;
      console.log('실행중인 트레이딩을 종료합니다.');
    }

    if (monitorIntervalHandler !== null) {
      clearInterval(monitorIntervalHandler);
      monitorIntervalHandler = null;
      console.log('실행중인 모니터링을 종료합니다.');
    }

    trade(symbol, interval);

    // 1분마다 trade 함수 실행
    intervalHandler = setInterval(() => trade(symbol, interval), 60 * 1000);
    monitorIntervalHandler = setInterval(monitorPrice, 20 * 1000);

    console.log('트레이딩을 실행합니다.');
  } catch (error) {
    console.error('Trade execution start failed:', error);
  }
}

async function endTrade() {
  try {
    if (intervalHandler !== null) {
      clearInterval(intervalHandler);
      intervalHandler = null;
      console.log('트레이딩을 종료합니다.');
    }
  } catch (error) {
    console.error('Trade execution end failed:', error);
  }
}

const setMonitorCount = (count) => {
  monitorCount = count;
  monitorPrice();
};

exports.binance = {
  startTrade,
  endTrade,
  setTelegramBot,
  setMonitorCount,
  monitorPrice,
};
