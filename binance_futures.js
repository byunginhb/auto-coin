require('dotenv').config();
const phase = process.env.ENV_PHASE || 'production';
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
const rsiBuyThreshold = 40; // RSI 과매도 조건
const rsiSellThreshold = 60; // RSI 과매수 조건

// 손절, 손익 조건
let stopLossPrice = 0; // 손절 퍼센트
let takeProfitPrice = 0; // 익절 퍼센트

let intervalHandler = null;
let telegramBot = null;
let leverage = 1;

let buySignal = false;
let sellSignal = false;
let closeSignal = false;

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
    if (type === 'LONG') {
      await binance.futuresMarketBuy(symbol, quantity);
    } else if (type === 'SHORT') {
      await binance.futuresMarketSell(symbol, quantity);
    }
  } catch (error) {
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
    sendMessage(`포지션 청산 실패: ${error.message}`);
    console.error(`Failed to close position for ${symbol}:`, error);
    throw error;
  }
}

//손절, 익절을 위한 볼린저 밴드 체크
const checkBB = (positionAmt, lastBB, curHigh, curLow) => {
  // 롱 포지션 일 때, 볼린저 밴드 상단 돌파 했는지 체크
  // 숏 포지션 일 때, 볼린저 밴드 하단 돌파 했는지 체크
  if (
    (positionAmt > 0 && curHigh > lastBB.upper) ||
    (positionAmt < 0 && curLow < lastBB.lower)
  ) {
    sendMessage('볼린저 밴드 돌파 신호 발생');
    closeSignal = true;
  }
};

// 포지션 모니터링 손절,익절 체크
async function checkStopLoss(lastBB, curHigh, curLow, sma160) {
  try {
    const { positions } = await getFutureAccountInfo(binance);

    if (positions.length === 0) {
      return;
    }

    for (let pos of positions) {
      const { symbol, positionAmt, unrealizedProfit, markPrice } =
        await getPositionData(pos, binance);

      // 손절, 익절 구간 체크
      let closeCheck = false;
      let stopTakeCheck = false;
      let changedWave = false;

      if (positionAmt > 0) {
        //롱 포지션
        stopTakeCheck =
          Number(markPrice) <= Number(stopLossPrice) ||
          Number(markPrice) >= Number(takeProfitPrice);

        changedWave = Number(markPrice) < sma160;
      } else if (positionAmt < 0) {
        //숏 포지션
        stopTakeCheck =
          Number(markPrice) >= Number(stopLossPrice) ||
          Number(markPrice) <= Number(takeProfitPrice);

        changedWave = Number(markPrice) > sma160;
      }
      closeCheck = stopTakeCheck || changedWave;

      //추세 변환 체크
      if (closeSignal) {
        // 볼린저 밴드 상단(롱), 하단(숏) 돌파 신호 받은 상태
        if (
          (positionAmt > 0 && curHigh < lastBB.upper) ||
          (positionAmt < 0 && curLow > lastBB.lower)
        ) {
          closeCheck = true;
          closeSignal = false;
        }
      } else {
        // 볼린저 밴드 상단(롱), 하단(숏) 돌파 체크
        checkBB(positionAmt, lastBB, curHigh, curLow);
      }

      if (closeCheck) {
        closeSignal = false;

        sendMessage(`손절, 익절 조건 충족
포지션 : ${positionAmt > 0 ? '롱' : '숏'},
curHigh: ${curHigh},
curLow: ${curLow},
lastBB.upper: ${lastBB.upper},
lastBB.lower: ${lastBB.lower},
현재가 : ${markPrice},
stopLossPrice: ${stopLossPrice},
takeProfitPrice: ${takeProfitPrice},
추세 변환: ${changedWave},
손절, 손익 : ${stopTakeCheck},
볼린저 밴드 : ${
          (positionAmt > 0 && curHigh < lastBB.upper) ||
          (positionAmt < 0 && curLow > lastBB.lower)
        }`);

        await closePosition(symbol, positionAmt);
        await sendUSDTBalance();

        sendMessage(
          `${symbol} 포지션 청산
실현손익: ${unrealizedProfit.toFixed(2)}USDT`
        );
        await currentCheck(symbol);
      }
    }
  } catch (error) {
    sendMessage(`checkStopLoss 에러 발생: ${error?.message}`);
    console.error('Failed to monitor positions:', error);
    throw error;
  }
}

//매수 체크 로직
const getBuyCheck = (
  lastBB,
  lastLow,
  lastRSI,
  positionAmt,
  lastClose,
  sma160
) => {
  if (positionAmt > 0) return false;

  if (buySignal) {
    if (lastLow > lastBB.lower) {
      buySignal = false;
      return true;
    } else {
      return false;
    }
  }

  if (lastBB.lower > lastLow && lastClose > sma160) {
    sendMessage(`LONG 포지션 진입 신호 발생`);
    buySignal = true;
  }

  if (lastClose < sma160 && buySignal === true) {
    sendMessage(`이평선 아래로 가격이 떨어져서 buySignal 초기화`);
    buySignal = false;
  }

  return false;
};

//매도 체크 로직
const getSellCheck = (
  lastBB,
  lastHigh,
  lastRSI,
  positionAmt,
  lastClose,
  sma160
) => {
  if (positionAmt < 0) return false;

  if (sellSignal) {
    if (lastHigh < lastBB.upper) {
      sellSignal = false;
      return true;
    } else {
      return false;
    }
  }

  if (lastBB.upper < lastHigh && lastClose < sma160) {
    sendMessage(`SHORT 포지션 진입 신호 발생`);
    sellSignal = true;
  }

  if (lastClose > sma160 && sellSignal === true) {
    sendMessage(`이평선 위로 가격이 올라가서 sellSignal 초기화`);
    sellSignal = false;
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

  const minimumStopLoss =
    entryPrice * (positionType === 'LONG' ? 0.985 : 1.015);
  const maximumStopLoss = entryPrice * (positionType === 'LONG' ? 0.97 : 1.03);

  if (positionType === 'LONG') {
    const lowestLow = Math.min(...recentCandles.map((candle) => candle[3]));
    stopLoss = Math.max(Math.min(lowestLow, minimumStopLoss), maximumStopLoss);
    takeProfit = entryPrice + 2 * (entryPrice - stopLoss);
  } else if (positionType === 'SHORT') {
    const highestHigh = Math.max(...recentCandles.map((candle) => candle[2]));
    stopLoss = Math.min(
      Math.max(highestHigh, minimumStopLoss),
      maximumStopLoss
    );
    takeProfit = entryPrice - 2 * (stopLoss - entryPrice);
  }

  return { stopLoss, takeProfit };
};

const currentCheck = async (symbol = 'BTCUSDT', interval = '15m') => {
  const candles = await fetchCandlestickData(binance, symbol, interval, 240);
  const { lastBB, lastClose, lastLow, lastHigh, lastRSI, sma160 } =
    await calculateIndicators(candles, 20, 1.5);

  sendMessage(`현재 상태
lastBB.lower: ${lastBB.lower},
lastBB.upper: ${lastBB.upper},
lastClose: ${lastClose},
lastLow: ${lastLow},
lastHigh: ${lastHigh},
lastRSI: ${lastRSI},
sma160: ${sma160}
`);
};

// trade('BTCUSDT', '15m');

// 트레이딩 함수
async function trade(symbol, interval = '15m') {
  try {
    if (!isInitDB) {
      await coinDB.setup();
      isInitDB = true;
    }

    const setLeverage = 1;
    await binance.futuresLeverage(symbol, setLeverage);

    const candles = await fetchCandlestickData(binance, symbol, interval, 240);
    const {
      lastBB,
      lastClose,
      lastLow,
      lastHigh,
      lastRSI,
      sma160,
      curBB,
      curHigh,
      curLow,
    } = await calculateIndicators(candles);

    const { positions, usdtBalance } = await getFutureAccountInfo(binance);
    const currentPrice = await getCurrentPrice(symbol, binance);

    const quantity = (parseFloat(usdtBalance) / currentPrice) * leverage;
    const adjustedQuantity = truncateNumber(quantity, 3);

    let positionAmt = 0;
    if (positions.length > 0) {
      const pos = positions[0];
      positionAmt = parseFloat(pos.positionAmt); // 0 보다 크면 LONG, 0보다 작으면 SHORT

      const savedCoinData = await coinDB.getCurrentCoin();
      if (savedCoinData) {
        stopLossPrice = savedCoinData.stopLossPrice;
        takeProfitPrice = savedCoinData.takeProfitPrice;
      }
    }

    const buyCheck = getBuyCheck(
      lastBB,
      lastLow,
      lastRSI,
      positionAmt,
      lastClose,
      sma160
    );

    const sellCheck = getSellCheck(
      lastBB,
      lastHigh,
      lastRSI,
      positionAmt,
      lastClose,
      sma160
    );

    try {
      if (positions.length === 0) {
        if (buyCheck) {
          // 롱 포지션 진입
          sendMessage(`롱포지션 조건 충족`);
          const { stopLoss, takeProfit } = calculateStopLossTakeProfit(
            'LONG',
            candles.slice(-20),
            currentPrice
          );
          stopLossPrice = stopLoss;
          takeProfitPrice = takeProfit;

          await openPosition(symbol, adjustedQuantity, 'LONG', currentPrice);
          sendMessage(`${adjustedQuantity} 수량으로 ${currentPrice} ${symbol} 롱포지션 실행.
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
          sendMessage(`숏포지션 조건 충족.`);
          const { stopLoss, takeProfit } = calculateStopLossTakeProfit(
            'SHORT',
            candles.slice(-20),
            currentPrice
          );
          stopLossPrice = stopLoss;
          takeProfitPrice = takeProfit;

          await openPosition(symbol, adjustedQuantity, 'LONG', currentPrice);
          sendMessage(`${adjustedQuantity} 수량으로 ${currentPrice} ${symbol} 숏포지션 실행.
선물 RSI: ${lastRSI},
마지막 금액: ${currentPrice},
볼린저 하단: ${lastBB.lower.toFixed(3)},
볼린저 상단: ${lastBB.upper.toFixed(3)},
stopLossPrice : ${stopLossPrice},
takeProfitPrice : ${takeProfitPrice}
          `);

          await coinDB.upsertCoinData(stopLossPrice, takeProfitPrice);
        }
      } else {
        await checkStopLoss(curBB, curHigh, curLow, sma160);
      }
    } catch (error) {
      sendMessage(`포지션 진입시 에러 발생: ${error.message}`);
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

    // 300초마다 trade 함수 실행
    intervalHandler = setInterval(() => trade(symbol, interval), 240 * 1000);
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
    }
  } catch (error) {
    sendMessage('Trade execution end failed:', error);
    console.error('Trade execution end failed:', error);
  }
}

exports.binance = {
  startTrade,
  endTrade,
  setTelegramBot,
  sendPositionData,
  sendUSDTBalance,
  currentCheck,
};
