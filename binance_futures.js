require('dotenv').config();
const Binance = require('node-binance-api');
const coinDB = require('./db').coinDB;

const {
  getFutureAccountInfo,
  fetchCandlestickData,
  getPositionData,
  getCurrentPrice,
  calculateIndicators,
} = require('./binance_common').binance_common;
const { truncateNumber } = require('./utils').utils;
const chatId = process.env.TELEGRAM_FUTURE_BOT_CHAT_ID;

// 바이낸스 API 객체 생성
const binance = new Binance().options({
  APIKEY: process.env.BINANCE_API_KEY,
  APISECRET: process.env.BINANCE_API_SECRET,
  family: 4,
});

// 매수 및 매도 조건 설정
const rsiBuyThreshold = 30; // RSI 과매도 조건
const rsiSellThreshold = 70; // RSI 과매수 조건

// 손절, 손익 조건
let stopLossPrice = 0; // 손절 퍼센트
let takeProfitPrice = 0; // 익절 퍼센트

let intervalHandler = null;
let telegramBot = null;
let leverage = 1;

let buySignal = false;
let sellSignal = false;

let isInitDB = false;

// 텔레그램 봇 설정
function setTelegramBot(bot) {
  telegramBot = bot;
}

// 텔레그램 메시지 전송
function sendMessage(message) {
  telegramBot.sendMessage(chatId, message);
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
      const { symbol, positionAmt, unrealizedProfit } = await getPositionData(
        pos,
        binance
      );

      sendMessage(
        `${symbol} 포지션 정보
포지션: ${positionAmt > 0 ? '롱' : '숏'}, 
실현손익: ${parseFloat(unrealizedProfit).toFixed(2)}USDT
stopLossPrice: ${stopLossPrice},
takeProfitPrice: ${takeProfitPrice}`
      );
    }
  } catch (error) {
    sendMessage(`sendPositionData 실행 중에 에러 발생 ${error.message}`);
  }
};

//잔액 전송하기
const sendUSDTBalance = async () => {
  const { usdtBalance } = await getFutureAccountInfo(binance);
  sendMessage(`현재 USDT 잔액: ${usdtBalance}`);
};

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
      //LONG 포지션 청산
      await binance.futuresMarketSell(symbol, Math.abs(positionAmt));
    } else {
      //SHORT 포지션 청산
      await binance.futuresMarketBuy(symbol, Math.abs(positionAmt));
    }
  } catch (error) {
    console.error(`Failed to close position for ${symbol}:`, error);
    sendMessage(`포지션 청산 실패: ${error.message}`);
    throw error;
  }
}

// 포지션 모니터링 손절,익절 체크
async function checkStopLoss() {
  try {
    const { positions } = await getFutureAccountInfo(binance);

    if (positions.length === 0) {
      console.log('No open positions to monitor.');
      return;
    }

    for (let pos of positions) {
      const { symbol, positionAmt, unrealizedProfit, markPrice } =
        await getPositionData(pos, binance);

      // 손절 로직
      if (markPrice <= stopLossPrice || markPrice >= takeProfitPrice) {
        await closePosition(symbol, positionAmt);
        await sendUSDTBalance();

        sendMessage(
          `${symbol} 포지션 청산
실현손익: ${unrealizedProfit.toFixed(2)}USDT`
        );
      }
    }
  } catch (error) {
    console.error('Failed to monitor positions:', error);
    throw error;
  }
}

//매수 체크 로직
const getBuyCheck = (lastBB, lastClose, lastLow, lastRSI, positionAmt) => {
  if (positionAmt > 0) return false;

  if (buySignal) {
    if (lastClose > lastBB.lower) {
      buySignal;
      return true;
    } else {
      return false;
    }
  }

  if (lastBB.lower > lastLow && lastRSI < rsiBuyThreshold) {
    buySignal = true;
  }

  return false;
};

//매도 체크 로직
const getSellCheck = (lastBB, lastClose, lastHigh, lastRSI, positionAmt) => {
  if (positionAmt < 0) return false;

  if (sellSignal) {
    if (lastClose < lastBB.upper) {
      sellSignal;
      return true;
    } else {
      return false;
    }
  }

  if (lastBB.upper < lastHigh && lastRSI > rsiSellThreshold) {
    sellSignal = true;
  }

  return false;
};

// 포지션 진입 시 손절가와 익절가 설정 로직 추가
const calculateStopLossTakeProfit = (
  positionType,
  recentCandles,
  entryPrice
) => {
  let stopLoss = 0;
  let takeProfit = 0;

  if (positionType === 'LONG') {
    const lowestLow = Math.min(...recentCandles.map((candle) => candle[3])); // 최근 5개 중 가장 낮은 값
    stopLoss = lowestLow;
    takeProfit = entryPrice + 2.5 * (entryPrice - stopLoss);
  } else if (positionType === 'SHORT') {
    const highestHigh = Math.max(...recentCandles.map((candle) => candle[2])); // 최근 5개 중 가장 높은 값
    stopLoss = highestHigh;
    takeProfit = entryPrice - 2.5 * (stopLoss - entryPrice);
  }

  return { stopLoss, takeProfit };
};

// trade('BTCUSDT', '15m');

// 트레이딩 함수
async function trade(symbol, interval = '15m') {
  try {
    if (!isInitDB) {
      await coinDB.setup();
      isInitDB = true;
    }

    const savedCoinData = await coinDB.getCurrentCoin();
    if (savedCoinData) {
      stopLossPrice = savedCoinData.stopLossPrice;
      takeProfitPrice = savedCoinData.takeProfitPrice;
    }

    const setLeverage = 1;
    await binance.futuresLeverage(symbol, setLeverage);

    const candles = await fetchCandlestickData(binance, symbol, interval, 1000);
    const { lastBB, lastClose, lastLow, lastHigh, lastRSI } =
      await calculateIndicators(candles);

    const { positions, usdtBalance } = await getFutureAccountInfo(binance);
    const currentPrice = await getCurrentPrice(symbol, binance);

    const quantity = (parseFloat(usdtBalance) / currentPrice) * leverage;
    const adjustedQuantity = truncateNumber(quantity, 3);

    let positionAmt = 0;
    if (positions.length > 0) {
      const pos = positions[0];
      positionAmt = parseFloat(pos.positionAmt); // 0 보다 크면 LONG, 0보다 작으면 SHORT
    }

    const buyCheck = getBuyCheck(
      lastBB,
      lastClose,
      lastLow,
      lastRSI,
      positionAmt
    );

    const sellCheck = getSellCheck(
      lastBB,
      lastClose,
      lastHigh,
      lastRSI,
      positionAmt
    );

    try {
      if (positions.length === 0) {
        if (buyCheck) {
          // 롱 포지션 진입
          const { stopLoss, takeProfit } = calculateStopLossTakeProfit(
            'LONG',
            candles.slice(-20),
            currentPrice
          );
          stopLossPrice = stopLoss;
          takeProfitPrice = takeProfit;

          await openPosition(symbol, adjustedQuantity, 'LONG', currentPrice);
          sendMessage(`롱포지션 조건 충족.
${adjustedQuantity} 수량으로 ${currentPrice} ${symbol} 롱포지션 실행.
선물 RSI: ${lastRSI},
마지막 금액: ${currentPrice},
볼린저 하단: ${lastBB.lower.toFixed(3)},
볼린저 상단: ${lastBB.upper.toFixed(3)},
stopLossPrice : ${stopLossPrice},
takeProfitPrice : ${takeProfitPrice}
          `);

          await coinDB.upsertCoinData(stopLossPrice, takeProfitPrice);
        } else if (sellCheck) {
          // 숏 포지션 진입
          const { stopLoss, takeProfit } = calculateStopLossTakeProfit(
            'SHORT',
            candles.slice(-20),
            currentPrice
          );
          stopLossPrice = stopLoss;
          takeProfitPrice = takeProfit;

          await openPosition(symbol, adjustedQuantity, 'LONG', currentPrice);
          sendMessage(`숏포지션 조건 충족.
${adjustedQuantity} 수량으로 ${currentPrice} ${symbol} 숏포지션 실행.
선물 RSI: ${lastRSI},
마지막 금액: ${currentPrice},
볼린저 하단: ${lastBB.lower.toFixed(3)},
볼린저 상단: ${lastBB.upper.toFixed(3)},
stopLossPrice : ${stopLossPrice},
takeProfitPrice : ${takeProfitPrice}
          `);

          await coinDB.upsertCoinData(stopLossPrice, takeProfitPrice);
        }
      }
    } catch (error) {
      sendMessage(`포지션 진입시 에러 발생: ${error.message}`);
    }

    await checkStopLoss();
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
