require('dotenv').config();
const Binance = require('node-binance-api');
const { BollingerBands, RSI } = require('technicalindicators');
const chatId = process.env.TELEGRAM_BOT_CHAT_ID;

// 바이낸스 API 객체 생성
const binance = new Binance().options({
  APIKEY: process.env.BINANCE_API_KEY,
  APISECRET: process.env.BINANCE_API_SECRET,
  family: 4,
});

// 매수 및 매도 조건 설정
const rsiBuyThreshold = 40; // RSI 과매도 조건
const rsiSellThreshold = 64; // RSI 과매수 조건

let intervalHandler = null;
let monitorIntervalHandler = null;

let telegramBot = null;
let leverage = 20;
let stopLossPercent = -15;
let stopPlusPercent = 15;

let coolDownTime = 0;
let coolDownMilliseconds = 0;

let buyCheck = false;
let sellCheck = false;

// 숫자 소수점 자릿수 잘라내기
function truncateNumber(strNum, digits) {
  let num = Number(strNum);
  let factor = Math.pow(10, digits);
  num = Math.floor(num * factor) / factor;
  return num;
}

// 텔레그램 봇 설정
function setTelegramBot(bot) {
  telegramBot = bot;
}

// 텔레그램 메시지 전송
function sendMessage(message) {
  telegramBot.sendMessage(chatId, message);
}

// 캔들스틱 데이터 가져오기
async function fetchCandlestickData(symbol, interval, limit) {
  try {
    return await binance.futuresCandles(symbol, interval, { limit: limit });
  } catch (error) {
    console.error(`Failed to fetch candlestick data for ${symbol}:`, error);
    throw error;
  }
}

// 기술적 지표 계산 (RSI, 볼린저 밴드)
async function calculateIndicators(candles) {
  try {
    const closes = candles.map((c) => parseFloat(c[4]));
    const highs = candles.map((c) => parseFloat(c[2]));
    const lows = candles.map((c) => parseFloat(c[3]));
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
      lastHigh: highs[closes.length - 1],
      lastLow: lows[closes.length - 1],
    };
  } catch (error) {
    console.error('Failed to calculate indicators:', error);
    throw error;
  }
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
    const { positions } = await getAccountInfo();

    if (positions.length === 0) {
      sendMessage('진행된 포지션이 없습니다.');
      return;
    }

    for (let pos of positions) {
      const { symbol, positionAmt, profitPercent, unrealizedProfit } =
        await getPositionData(pos);

      sendMessage(
        `${symbol} - 
포지션: ${positionAmt > 0 ? '롱' : '숏'}, 
실현손익: ${parseFloat(unrealizedProfit).toFixed(2)}USDT
손익률: ${profitPercent.toFixed(2)}%`
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
async function monitorPositions() {
  try {
    const { positions } = await getAccountInfo();

    if (positions.length === 0) {
      console.log('No open positions to monitor.');
      return;
    }

    for (let pos of positions) {
      const { symbol, positionAmt, profitPercent, unrealizedProfit } =
        await getPositionData(pos);

      // 손절 및 익절 로직
      if (
        profitPercent <= stopLossPercent ||
        profitPercent >= stopPlusPercent
      ) {
        buyCheck = false;
        sellCheck = false;

        await closePosition(symbol, positionAmt);
        sendMessage(
          `${symbol} 포지션 청산
실현손익: ${unrealizedProfit.toFixed(2)}USDT
손익률: ${profitPercent.toFixed(2)}%`
        );

        // 손절시 coolDownTime 설정
        if (profitPercent <= stopLossPercent) {
          coolDownTime = new Date().getTime() + coolDownMilliseconds;
        }
      }
    }
  } catch (error) {
    console.error('Failed to monitor positions:', error);
    throw error;
  }
}

//계좌 정보 가져오기
const getAccountInfo = async () => {
  const accountInfo = await binance.futuresAccount();
  const positions = accountInfo.positions.filter(
    (position) => parseFloat(position.positionAmt) !== 0
  );
  const usdtBalance = accountInfo.assets.find(
    (asset) => asset.asset === 'USDT'
  ).walletBalance;

  return { positions, usdtBalance };
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
  if (positionAmt < 0 && (rsi < rsiBuyThreshold || lastClose < bb.lower)) {
    const { symbol, positionAmt, profitPercent, unrealizedProfit } =
      await getPositionData(position);

    await closePosition(symbol, positionAmt);
    sendMessage(
      `${symbol} 숏 포지션 청산
실현손익: ${unrealizedProfit.toFixed(2)}USDT
손익률: ${profitPercent.toFixed(2)}%`
    );
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
    (rsi < rsiBuyThreshold || lastClose < bb.lower)
  ) {
    if (!buyCheck) {
      buyCheck = true;
      coolDownTime = new Date().getTime() + coolDownMilliseconds / 2;
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
  if (positionAmt > 0 && (rsi > rsiSellThreshold || lastClose > bb.upper)) {
    const { symbol, positionAmt, profitPercent, unrealizedProfit } =
      await getPositionData(position);

    await closePosition(symbol, positionAmt);
    sendMessage(
      `${symbol} 롱 포지션 청산
실현손익: ${unrealizedProfit.toFixed(2)}USDT
손익률: ${profitPercent.toFixed(2)}%`
    );
  }

  if (coolDownTime > new Date().getTime()) {
    return false;
  }

  if (
    sellCheck &&
    positionAmt <= 0 &&
    lastClose < bb.upper &&
    lastHigh < bb.upper
  ) {
    sellCheck = false;
    return true;
  } else if (
    positionAmt <= 0 &&
    (rsi < rsiBuyThreshold || lastClose < bb.lower)
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

trade('BTCUSDT', '5m');

// 트레이딩 함수
async function trade(symbol, interval = '5m') {
  try {
    // 쿨다운 시간 계산 (분봉 간격의 5배)
    const intervalMinutes = parseFloat(interval.replace(/[^0-9\.]+/g, ''));
    coolDownMilliseconds = intervalMinutes * 5 * 60 * 1000;

    // 레버리지 설정
    const setLeverage = 30;
    await binance.futuresLeverage(symbol, setLeverage);

    const candles = await fetchCandlestickData(symbol, interval, 500);
    const { rsi, bb, lastClose, lastHigh, lastLow } = await calculateIndicators(
      candles
    );
    const { positions, usdtBalance } = await getAccountInfo();
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
      rsi,
      lastClose,
      bb,
      positionAmt,
      positions[0],
      lastLow
    );
    const checkSell = await getSellCheck(
      rsi,
      lastClose,
      bb,
      positionAmt,
      positions[0],
      lastHigh
    );

    if (checkBuy) {
      await openPosition(symbol, adjustedQuantity, 'LONG', currentPrice);
      sendMessage(`롱포지션 조건 충족.
${adjustedQuantity} 수량으로 ${currentPrice} ${symbol} 롱포지션 실행.
선물 RSI: ${rsi},
마지막 금액: ${currentPrice},
볼린저 하단: ${bb.lower.toFixed(3)},
볼린저 상단: ${bb.upper.toFixed(3)}
`);
    }
    // 매도 조건 확인
    else if (checkSell) {
      await openPosition(symbol, adjustedQuantity, 'SHORT', currentPrice);
      sendMessage(`숏포지션 조건 충족. 
${adjustedQuantity} 수량으로 ${currentPrice} ${symbol} 숏포지션 실행
선물 RSI: ${rsi},
마지막 금액: ${currentPrice},
볼린저 하단: ${bb.lower.toFixed(3)},
볼린저 상단: ${bb.upper.toFixed(3)}
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
async function startTrade(symbol, interval = '5m') {
  try {
    if (intervalHandler !== null) {
      clearInterval(intervalHandler);
      clearInterval(monitorIntervalHandler);

      intervalHandler = null;
      monitorIntervalHandler = null;
      sendMessage('기존 실행된 선물 트레이딩을 종료합니다.');
    }

    trade(symbol, interval);

    // 1분마다 trade 함수 실행
    intervalHandler = setInterval(() => trade(symbol, interval), 60 * 1000);
    monitorIntervalHandler = setInterval(monitorPositions, 20 * 1000);

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
  monitorPositions,
  sendPositionData,
};
