require('dotenv').config();
const phase = process.env.ENV_PHASE || 'production';
const dayjs = require('dayjs');
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

let longEntryPrice = null;
let shortEntryPrice = null;

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
  return usdtBalance;
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
async function checkStopLoss(marketPrice, sma10, sma50, sma100) {
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
      let checkWave = true;

      if (positionAmt > 0) {
        //롱 포지션
        stopTakeCheck =
          Number(markPrice) <= Number(stopLossPrice) ||
          Number(markPrice) >= Number(takeProfitPrice);

        checkWave =
          sma10.at(-1) > sma50.at(-1) &&
          sma10.at(-1) > sma100.at(-1) &&
          sma50.at(-1) > sma100.at(-1);
      } else if (positionAmt < 0) {
        //숏 포지션
        stopTakeCheck =
          Number(markPrice) >= Number(stopLossPrice) ||
          Number(markPrice) <= Number(takeProfitPrice);

        checkWave =
          sma10.at(-1) < sma50.at(-1) &&
          sma10.at(-1) < sma100.at(-1) &&
          sma50.at(-1) < sma100.at(-1);
      }
      closeCheck = stopTakeCheck || !checkWave;

      if (closeCheck) {
        await closePosition(symbol, positionAmt);
        const curBalance = await sendUSDTBalance();
        const fee = curBalance * 0.001;
        await coinDB.upsertTradeData(
          unrealizedProfit - fee,
          dayjs().format('YYYY-MM-DD')
        );

        sendMessage(`손절, 익절 조건 충족되어 포지션 Closed
          포지션 : ${positionAmt > 0 ? '롱' : '숏'},
          현재가 : ${markPrice},
          stopLossPrice: ${stopLossPrice},
          takeProfitPrice: ${takeProfitPrice},
          추세 변환: ${checkWave},
          손절, 손익 : ${stopTakeCheck},
          실현손익: ${(unrealizedProfit - fee).toFixed(2)}USDT`);
      }
    }
  } catch (error) {
    sendMessage(`checkStopLoss 에러 발생: ${error?.message}`);
    console.error('Failed to monitor positions:', error);
    throw error;
  }
}

//매수 체크 로직
const getBuyCheck = async (
  bb,
  highs,
  lows,
  starts,
  closes,
  sma10,
  sma50,
  sma100,
  positionAmt,
  currentPrice
) => {
  if (positionAmt > 0) {
    const candlePlus3Check =
      starts.at(-4) < closes.at(-4) &&
      starts.at(-3) < closes.at(-3) &&
      starts.at(-2) < closes.at(-2);

    const candlePlus3WaveCheck =
      highs.at(-4) > highs.at(-5) &&
      highs.at(-3) > highs.at(-4) &&
      highs.at(-2) > highs.at(-3);

    if (
      candlePlus3Check &&
      candlePlus3WaveCheck &&
      lows.at(-3) > stopLossPrice
    ) {
      sendMessage(
        `롱 포지션 진입 중에 양봉 연속 나와 손절가 수정 ${stopLossPrice} -> ${lows.at(
          -3
        )}`
      );
      stopLossPrice = lows.at(-3);
      await coinDB.upsertCoinData(stopLossPrice, takeProfitPrice);
    }

    return false;
  }

  const calculateStopTakePrice = (currentPrice, lows, lossPosition) => {
    const minimumStopLoss = currentPrice * 0.995;
    const maximumStopLoss = currentPrice * 0.98;

    stopLossPrice = Math.max(
      Math.min(lows.at(lossPosition), minimumStopLoss),
      maximumStopLoss
    );
    takeProfitPrice = currentPrice + (currentPrice - stopLossPrice) * 1.5;
  };

  //정배열 확인
  const plusWave =
    sma10.at(-6) > sma50.at(-6) &&
    sma10.at(-6) > sma100.at(-6) &&
    sma50.at(-6) > sma100.at(-6) &&
    sma10.at(-1) > sma50.at(-1) &&
    sma10.at(-1) > sma100.at(-1) &&
    sma50.at(-1) > sma100.at(-1);

  //다섯개 연속 양봉이면 진입
  const candlePlus5rows =
    starts.at(-6) < closes.at(-6) &&
    starts.at(-5) < closes.at(-5) &&
    starts.at(-4) < closes.at(-4) &&
    starts.at(-3) < closes.at(-3) &&
    starts.at(-2) < closes.at(-2);

  //다섯개 연속 high가 높아지는지 확인
  const candlePlus5Wave =
    highs.at(-6) > highs.at(-7) &&
    highs.at(-5) > highs.at(-6) &&
    highs.at(-4) > highs.at(-5) &&
    highs.at(-3) > highs.at(-4) &&
    highs.at(-2) > highs.at(-3);

  if (plusWave && candlePlus5rows && candlePlus5Wave) {
    calculateStopTakePrice(currentPrice, lows, -2);
    longEntryPrice = currentPrice;
    buySignal = false;
    sendMessage(`정배열, 5개 연속 양봉, 5개 연속 최상단이라 진입`);

    return true;
  }

  if (buySignal && longEntryPrice <= currentPrice) {
    calculateStopTakePrice(currentPrice, lows, -3);
    buySignal = false;
    sendMessage(`진입 신호 이후 진입가격보다 현재가가 높아져서 포지션 진입`);

    return true;
  }

  //정배열인지 확인
  if (plusWave) {
    //3개 음봉 이후 3개 양봉 나왔는지 확인
    const candleMinus3rows =
      starts.at(-6) > closes.at(-6) && starts.at(-5) > closes.at(-5);

    const candlePlus3rows =
      starts.at(-3) < closes.at(-3) && starts.at(-2) < closes.at(-2);

    if (candleMinus3rows && candlePlus3rows && buySignal === false) {
      longEntryPrice = highs.at(-6);
      buySignal = true;
      sendMessage(`3개 음봉 이후 3개 양봉 나와 롱포지션 진입 신호`);

      return false;
    }
  } else {
    buySignal = false;
    longEntryPrice = null;
  }

  return false;
};

//매도 체크 로직
const getSellCheck = async (
  bb,
  highs,
  lows,
  starts,
  closes,
  sma10,
  sma50,
  sma100,
  positionAmt,
  currentPrice
) => {
  if (positionAmt < 0) {
    const candleMinus3Check =
      starts.at(-4) > closes.at(-4) &&
      starts.at(-3) > closes.at(-3) &&
      starts.at(-2) > closes.at(-2);

    const candleMinus3WaveCheck =
      lows.at(-4) < lows.at(-5) &&
      lows.at(-3) < lows.at(-4) &&
      lows.at(-2) < lows.at(-3);

    if (
      candleMinus3Check &&
      candleMinus3WaveCheck &&
      highs.at(-3) < stopLossPrice
    ) {
      sendMessage(
        `숏 포지션 진입 중에 음봉 연속 나와 손절가 수정 ${stopLossPrice} -> ${highs.at(
          -3
        )}`
      );
      stopLossPrice = highs.at(-3);
      await coinDB.upsertCoinData(stopLossPrice, takeProfitPrice);
    }

    return false;
  }

  const calculateStopTakePrice = (starts, highs, lossPosition) => {
    const minimumStopLoss = currentPrice * 1.005;
    const maximumStopLoss = currentPrice * 1.02;

    stopLossPrice = Math.min(
      Math.max(highs.at(lossPosition), minimumStopLoss),
      maximumStopLoss
    );
    takeProfitPrice = currentPrice - (stopLossPrice - currentPrice) * 1.5;
  };

  const minusWave =
    sma10.at(-6) < sma50.at(-6) &&
    sma10.at(-6) < sma100.at(-6) &&
    sma50.at(-6) < sma100.at(-6) &&
    sma10.at(-1) < sma50.at(-1) &&
    sma10.at(-1) < sma100.at(-1) &&
    sma50.at(-1) < sma100.at(-1);

  //다섯개 연속 음봉이면 진입
  const candleMinus5rows =
    starts.at(-6) > closes.at(-6) &&
    starts.at(-5) > closes.at(-5) &&
    starts.at(-4) > closes.at(-4) &&
    starts.at(-3) > closes.at(-3) &&
    starts.at(-2) > closes.at(-2);

  //다섯개 연속 low가 낮아지는지 확인
  const candleMinus5Wave =
    lows.at(-6) < lows.at(-7) &&
    lows.at(-5) < lows.at(-6) &&
    lows.at(-4) < lows.at(-5) &&
    lows.at(-3) < lows.at(-4) &&
    lows.at(-2) < lows.at(-3);

  if (minusWave && candleMinus5rows && candleMinus5Wave) {
    calculateStopTakePrice(currentPrice, highs, -2);
    shortEntryPrice = currentPrice;
    sellSignal = false;

    sendMessage(`역배열, 5개 연속 음봉, 5개 연속 최하단이라 진입`);

    return true;
  }

  if (sellSignal && shortEntryPrice > currentPrice) {
    calculateStopTakePrice(currentPrice, highs, -3);
    sellSignal = false;
    sendMessage(`진입 신호 이후 진입가격보다 현재가가 낮아져서 포지션 진입`);

    return true;
  }

  //역배열인지 확인
  if (minusWave) {
    //3개 양봉 이후 3개 음봉 나왔는지 확인
    const candlePlus3rows =
      starts.at(-6) < closes.at(-6) && starts.at(-5) < closes.at(-5);

    const candleMinus3rows =
      starts.at(-3) > closes.at(-3) && starts.at(-2) > closes.at(-2);

    if (candlePlus3rows && candleMinus3rows && sellSignal === false) {
      shortEntryPrice = lows.at(-6);
      sellSignal = true;

      sendMessage(`3개 양봉 이후 3개 음봉 나와 숏포지션 진입 신호`);

      return false;
    }
  } else {
    sellSignal = false;
    shortEntryPrice = null;
  }

  return false;
};

const currentCheck = async (symbol = 'BTCUSDT', interval = '15m') => {
  const candleSlice = await fetchCandlestickData(
    binance,
    symbol,
    interval,
    120
  );
  const { closes, starts, highs, lows, sma10, sma50, sma100 } =
    await calculateIndicators(candleSlice, 20, 2);

  sendMessage(`현재 상태
starts: ${starts.at(-1)},
closes: ${closes.at(-1)},
highs: ${highs.at(-1)},
lows: ${lows.at(-1)},
sma10: ${sma10.at(-1)},
sma50: ${sma50.at(-1)},
sma100: ${sma100.at(-1)}
`);
};

// trade('BTCUSDT', '15m');

// 트레이딩 함수
async function trade(symbol, interval = '30m') {
  try {
    if (!isInitDB) {
      await coinDB.setup();
      isInitDB = true;
    }

    const setLeverage = 1;
    await binance.futuresLeverage(symbol, setLeverage);

    const candleSlice = await fetchCandlestickData(
      binance,
      symbol,
      interval,
      120
    );
    const { bb, closes, starts, highs, lows, sma10, sma50, sma100 } =
      await calculateIndicators(candleSlice, 20, 2);

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

    const buyCheck = await getBuyCheck(
      bb,
      highs,
      lows,
      starts,
      closes,
      sma10,
      sma50,
      sma100,
      positionAmt,
      currentPrice
    );

    const sellCheck = await getSellCheck(
      bb,
      highs,
      lows,
      starts,
      closes,
      sma10,
      sma50,
      sma100,
      positionAmt,
      currentPrice
    );

    try {
      if (positions.length === 0) {
        if (buyCheck === true) {
          // 롱 포지션 진입
          await openPosition(symbol, adjustedQuantity, 'LONG', currentPrice);
          sendMessage(`롱포지션 조건 충족!,
${adjustedQuantity} 수량으로 ${currentPrice} ${symbol} 롱포지션 실행.
진입 금액: ${currentPrice},
stopLossPrice : ${stopLossPrice},
takeProfitPrice : ${takeProfitPrice}
          `);

          await coinDB.upsertCoinData(stopLossPrice, takeProfitPrice);
        } else if (sellCheck === true) {
          // 숏 포지션 진입
          await openPosition(symbol, adjustedQuantity, 'SHORT', currentPrice);
          sendMessage(`숏포지션 조건 충족!
${adjustedQuantity} 수량으로 ${currentPrice} ${symbol} 숏포지션 실행.
진입 금액: ${currentPrice},
stopLossPrice : ${stopLossPrice},
takeProfitPrice : ${takeProfitPrice}
          `);

          await coinDB.upsertCoinData(stopLossPrice, takeProfitPrice);
        }
      } else {
        await checkStopLoss(currentPrice, sma10, sma50, sma100);
      }
    } catch (error) {
      sendMessage(`포지션 진입시 에러 발생: ${error.message}`);
    }
  } catch (error) {
    console.error('Trade execution start failed:', error);
    sendMessage(`선물 트레이딩 실패 : ${JSON.stringify(error)}`);
  }
}

// 트레이딩 시작
async function startTrade(symbol = 'BTCUSDT', interval = '30m') {
  try {
    if (intervalHandler !== null) {
      clearInterval(intervalHandler);

      intervalHandler = null;
      sendMessage('기존 실행된 선물 트레이딩을 종료합니다.');
    }

    trade(symbol, interval);

    intervalHandler = setInterval(() => trade(symbol, interval), 3 * 1000);
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
