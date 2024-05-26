require('dotenv').config();
const Binance = require('node-binance-api');
const { getFutureAccountInfo, fetchCandlestickData } =
  require('./binance_common').binance_common;
const { truncateNumber } = require('./utils').utils;
const chatId = process.env.TELEGRAM_FUTURE_BOT_CHAT_ID;

// 바이낸스 API 객체 생성
const binance = new Binance().options({
  APIKEY: process.env.BINANCE_API_KEY,
  APISECRET: process.env.BINANCE_API_SECRET,
  family: 4,
});

// 매수 및 매도 조건 설정
const rsiBuyThreshold = 33; // RSI 과매도 조건
const rsiSellThreshold = 60; // RSI 과매수 조건

// 손절, 손익 조건
const stopLossUSDT = -10;
const stopPlusUSDT = 40;

let intervalHandler = null;
let telegramBot = null;

let leverage = 1;

let coolDownTime = 0;
let coolDownMilliseconds = 0;

let buyCheck = false;
let sellCheck = false;

// 텔레그램 봇 설정
function setTelegramBot(bot) {
  telegramBot = bot;
}

// 텔레그램 메시지 전송
function sendMessage(message) {
  telegramBot.sendMessage(chatId, message);
}

// 현재 가격 가져오기
async function getCurrentPrice(symbol) {
  try {
    const prices = await binance.futuresPrices();
    return parseFloat(prices[symbol]);
  } catch (error) {
    console.error(`Failed to get current price for ${symbol}:`, error);
    throw error;
  }
}

// 포지션 오픈
async function openPosition(symbol, quantity, type, entryPrice) {
  try {
    console.log(
      `Opening ${type} position for ${symbol} with quantity ${quantity}`
    );
    if (type === 'LONG') {
      const order = await binance.futuresMarketBuy(symbol, quantity);
      console.log(`Long position opened: `, order);
    } else if (type === 'SHORT') {
      const order = await binance.futuresMarketSell(symbol, quantity);
      console.log(`Short position opened: `, order);
    }
  } catch (error) {
    console.error(`Failed to open ${type} position for ${symbol}:`, error);
    sendMessage(
      `포지션 오픈 실패: symbol, quantity, type, entryPrice, 
${symbol}, ${quantity}, ${type}, ${entryPrice} ${error.message}`
    );
    throw error;
  }
}

// 포지션 클로즈
async function closePosition(symbol, positionAmt) {
  try {
    if (positionAmt > 0) {
      await binance.futuresMarketSell(symbol, Math.abs(positionAmt));
    } else {
      await binance.futuresMarketBuy(symbol, Math.abs(positionAmt));
    }
  } catch (error) {
    console.error(`Failed to close position for ${symbol}:`, error);
    sendMessage(`포지션 청산 실패: ${error.message}`);
    throw error;
  }
}

//포지션 데이터 메시지 전송
const sendPositionData = async () => {
  try {
    const { positions } = await getFutureAccountInfo(binance);

    if (positions.length === 0) {
      sendMessage('진행된 포지션이 없습니다.');
      return;
    }

    for (let pos of positions) {
      const { symbol, positionAmt, profitPercent, unrealizedProfit } =
        await getPositionData(pos);

      sendMessage(
        `${symbol} 포지션 정보
포지션: ${positionAmt > 0 ? '롱' : '숏'}, 
실현손익: ${parseFloat(unrealizedProfit).toFixed(2)}USDT`
      );
    }
  } catch (error) {
    sendMessage(`sendPositionData 실행 중에 에러 발생 ${error.message}`);
  }
};

//현재 포지션 정보 가져오기
const getPositionData = async (position) => {
  const symbol = position.symbol;
  const positionAmt = parseFloat(position.positionAmt);
  const markPrice = await getCurrentPrice(symbol);
  const profitPercent =
    (position.unrealizedProfit / position.initialMargin) * 100;

  return {
    symbol,
    positionAmt,
    markPrice,
    profitPercent,
    unrealizedProfit: parseFloat(position.unrealizedProfit),
  };
};

// 포지션 모니터링
async function checkStopLoss() {
  try {
    const { positions } = await getFutureAccountInfo(binance);

    if (positions.length === 0) {
      console.log('No open positions to monitor.');
      return;
    }

    for (let pos of positions) {
      const { symbol, positionAmt, profitPercent, unrealizedProfit } =
        await getPositionData(pos);

      // 손절 로직
      if (unrealizedProfit <= stopLossUSDT) {
        buyCheck = false;
        sellCheck = false;

        await closePosition(symbol, positionAmt);
        await sendUSDTBalance();

        sendMessage(
          `${symbol} 포지션 청산
실현손익: ${unrealizedProfit.toFixed(2)}USDT`
        );

        // 손절시 coolDownTime 설정
        if (profitPercent <= stopLossUSDT) {
          coolDownTime = new Date().getTime() + coolDownMilliseconds;
        }
      }
    }
  } catch (error) {
    console.error('Failed to monitor positions:', error);
    throw error;
  }
}

//잔액 전송하기
const sendUSDTBalance = async () => {
  const { usdtBalance } = await getFutureAccountInfo(binance);
  sendMessage(`현재 USDT 잔액: ${usdtBalance}`);
};

//매수 체크 로직
const getBuyCheck = async (
  rsi,
  lastClose,
  bb,
  positionAmt,
  position,
  lastLow
) => {
  if (positionAmt < 0 && rsi < rsiBuyThreshold && lastClose < bb.lower) {
    const { symbol, positionAmt, profitPercent, unrealizedProfit } =
      await getPositionData(position);

    await closePosition(symbol, positionAmt);
    sendMessage(
      `${symbol} 숏 포지션 청산
실현손익: ${unrealizedProfit.toFixed(2)}USDT`
    );
    await sendUSDTBalance();
  }

  if (coolDownTime > new Date().getTime()) {
    return false;
  }

  if (
    buyCheck &&
    positionAmt <= 0 &&
    lastClose > bb.lower &&
    lastLow > bb.lower
  ) {
    buyCheck = false;
    return true;
  } else if (
    positionAmt <= 0 &&
    rsi < rsiBuyThreshold &&
    lastClose < bb.lower
  ) {
    if (!buyCheck) {
      buyCheck = true;
      coolDownTime = new Date().getTime() + coolDownMilliseconds;
      return false;
    } else {
      buyCheck = false;
    }
    return true;
  }
  return false;
};

//매도 체크 로직
const getSellCheck = async (
  rsi,
  lastClose,
  bb,
  positionAmt,
  position,
  lastHigh
) => {
  if (positionAmt > 0 && rsi > rsiSellThreshold && lastClose > bb.upper) {
    const { symbol, positionAmt, profitPercent, unrealizedProfit } =
      await getPositionData(position);

    await closePosition(symbol, positionAmt);
    sendMessage(
      `${symbol} 롱 포지션 청산
실현손익: ${unrealizedProfit.toFixed(2)}USDT`
    );
    await sendUSDTBalance();
  }

  if (coolDownTime > new Date().getTime()) {
    return false;
  }

  if (
    sellCheck &&
    positionAmt >= 0 &&
    lastClose < bb.upper &&
    lastHigh < bb.upper
  ) {
    sellCheck = false;
    return true;
  } else if (
    positionAmt >= 0 &&
    rsi > rsiSellThreshold &&
    lastHigh > bb.upper
  ) {
    if (!sellCheck) {
      sellCheck = true;
      coolDownTime = new Date().getTime() + coolDownMilliseconds / 2;
      return false;
    } else {
      sellCheck = false;
    }
    return true;
  }
  return false;
};

//trade('BTCUSDT', '15m');

// 트레이딩 함수
async function trade(symbol, interval = '15m') {
  try {
    // 쿨다운 시간 계산 (분봉 간격의 5배)
    const intervalMinutes = parseFloat(interval.replace(/[^0-9\.]+/g, ''));
    coolDownMilliseconds = intervalMinutes * 1 * 60 * 1000;

    // 레버리지 설정
    const setLeverage = 30;
    await binance.futuresLeverage(symbol, setLeverage);

    const { lastRSI, lastBB, lastClose, lastHigh, lastLow } =
      await fetchCandlestickData(binance, symbol, interval, 1500);
    const { positions, usdtBalance } = await getFutureAccountInfo(binance);
    const currentPrice = await getCurrentPrice(symbol);

    // 포지션 사이징 로직
    const quantity = (parseFloat(usdtBalance) / currentPrice) * leverage;
    const adjustedQuantity = truncateNumber(quantity, 3);

    let positionAmt = 0;
    if (positions.length > 0) {
      const pos = positions[0];
      positionAmt = parseFloat(pos.positionAmt);
    }

    // 거래 조건 확인
    const checkBuy = await getBuyCheck(
      lastRSI,
      lastClose,
      lastBB,
      positionAmt,
      positions[0],
      lastLow
    );
    const checkSell = await getSellCheck(
      lastRSI,
      lastClose,
      lastBB,
      positionAmt,
      positions[0],
      lastHigh
    );

    await checkStopLoss();

    if (checkBuy) {
      await openPosition(symbol, adjustedQuantity, 'LONG', currentPrice);
      sendMessage(`롱포지션 조건 충족.
${adjustedQuantity} 수량으로 ${currentPrice} ${symbol} 롱포지션 실행.
선물 RSI: ${lastRSI},
마지막 금액: ${currentPrice},
볼린저 하단: ${lastBB.lower.toFixed(3)},
볼린저 상단: ${lastBB.upper.toFixed(3)}
`);
    }
    // 매도 조건 확인
    else if (checkSell) {
      await openPosition(symbol, adjustedQuantity, 'SHORT', currentPrice);
      sendMessage(`숏포지션 조건 충족. 
${adjustedQuantity} 수량으로 ${currentPrice} ${symbol} 숏포지션 실행
선물 RSI: ${lastRSI},
마지막 금액: ${currentPrice},
볼린저 하단: ${lastBB.lower.toFixed(3)},
볼린저 상단: ${lastBB.upper.toFixed(3)}
`);
    } else {
      console.log('조건에 해당하지 않음. 대기합니다.');
    }
  } catch (error) {
    console.error('Trade execution start failed:', error);
    sendMessage(`선물 트레이딩 실패: ${error.message}`);
  }
}

// 트레이딩 시작
async function startTrade(symbol = 'BTCUSDT', interval = '15m') {
  try {
    if (intervalHandler !== null) {
      clearInterval(intervalHandler);

      intervalHandler = null;
      sendMessage('기존 실행된 선물 트레이딩을 종료합니다.');
    }

    trade(symbol, interval);

    // 15초마다 trade 함수 실행
    intervalHandler = setInterval(() => trade(symbol, interval), 15 * 1000);
    sendMessage('트레이딩을 시작합니다.');
  } catch (error) {
    sendMessage('Trade execution start failed:', error);
  }
}

// 트레이딩 종료
async function endTrade() {
  try {
    if (intervalHandler !== null) {
      clearInterval(intervalHandler);
      intervalHandler = null;
      console.log('Trading stopped.');
    }
  } catch (error) {
    console.error('Trade execution end failed:', error);
  }
}

exports.binance = {
  startTrade,
  endTrade,
  setTelegramBot,
  sendPositionData,
  sendUSDTBalance,
};
