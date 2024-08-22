require('dotenv').config();
const Binance = require('node-binance-api');
const { calculateIndicators } = require('./binance_common').binance_common;
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const fs = require('fs');
const path = require('path');
const { sma } = require('technicalindicators');

const logMode = false;

// Binance API 객체 생성
const binance = new Binance().options({
  APIKEY: process.env.BINANCE_API_KEY,
  APISECRET: process.env.BINANCE_API_SECRET,
  family: 4,
});

async function backtest(
  symbol,
  interval = '15m',
  start = '2024-01-01',
  end = '2024-06-25',
  saveCSV = false
) {
  let initialCapital = 1000;
  let currentBalance = initialCapital;
  let position = null; // 현재 포지션 ('LONG', 'SHORT', 또는 null)
  let entryPrice = 0;
  let results = [];
  let stopLossPrice = 0;
  let takeProfitPrice = 0;
  let buySignal = false;
  let sellSignal = false;
  const rsiBuyThreshold = 35; // RSI 과매도 조건
  const rsiSellThreshold = 66; // RSI 과매수 조건

  let totalTradeCount = 0;
  let profitTradeCount = 0;

  let closeSignal = false;

  try {
    const dataFilePath = path.resolve(
      __dirname,
      `backData/future_backdata_${symbol}-${start}-${end}-${interval}.json`
    );
    let candles;

    // 캔들 데이터 생성 또는 가져오기
    if (fs.existsSync(dataFilePath)) {
      const data = fs.readFileSync(dataFilePath);
      candles = JSON.parse(data);
    } else {
      console.log('Fetching candlestick data from Binance API...');
      const startTime = new Date(start).getTime();
      const endTime = new Date(end).getTime();
      candles = await fetchCandlestickData(
        symbol,
        interval,
        startTime,
        endTime
      );
      fs.writeFileSync(dataFilePath, JSON.stringify(candles));
    }

    //포지션 종료
    const closePosition = (lastClose, closedDate) => {
      let result = {};
      if (position === 'SHORT') {
        const profit = (entryPrice - lastClose) * (currentBalance / entryPrice);
        const profitPercent = (profit / currentBalance) * 100;

        // 숏 포지션 종료
        currentBalance += profit;
        result = {
          date: closedDate,
          action: 'BUY SHORT position closed-1',
          price: lastClose,
          profit: profit,
          profitPercent: profitPercent,
          totalBalance: currentBalance,
        };
        position = null;
      } else if (position === 'LONG') {
        const profit = (lastClose - entryPrice) * (currentBalance / entryPrice);
        const profitPercent = (profit / currentBalance) * 100;

        // 롱 포지션 종료
        currentBalance += profit;
        result = {
          date: closedDate,
          action: 'SELL LONG position closed-1',
          price: lastClose,
          profit: profit,
          profitPercent: profitPercent,
          totalBalance: currentBalance,
        };
        position = null;
      }

      return result;
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
      const maximumStopLoss =
        entryPrice * (positionType === 'LONG' ? 0.97 : 1.03);

      if (positionType === 'LONG') {
        const lowestLow = Math.min(...recentCandles.map((candle) => candle[3]));
        stopLoss = Math.max(
          Math.min(lowestLow, minimumStopLoss),
          maximumStopLoss
        );
        takeProfit = entryPrice + 3 * (entryPrice - stopLoss);
      } else if (positionType === 'SHORT') {
        const highestHigh = Math.max(
          ...recentCandles.map((candle) => candle[2])
        );
        stopLoss = Math.min(
          Math.max(highestHigh, minimumStopLoss),
          maximumStopLoss
        );
        takeProfit = entryPrice - 3 * (stopLoss - entryPrice);
      }

      return { stopLoss, takeProfit };
    };

    const getBuyCheck = (
      lastBB,
      lastHigh,
      lastLow,
      lastClose,
      curLow,
      curHigh,
      sma160,
      curBB,
      curSma160
    ) => {
      const standardDiff = lastClose * 0.01;
      if (position === 'LONG') return false;

      //curBB의 upper와 lower의 격차가 1% 미만일 경우 return
      if (curBB.upper - curBB.lower < lastClose * 0.01) {
        buySignal = false;
        return false;
      }

      if (curBB.lower - curSma160 < standardDiff) {
        buySignal = false;
        return false;
      }

      //curSma160이 curBB 사이에 있으면 return;
      if (curSma160 > curBB.lower && curSma160 < curBB.upper) {
        buySignal = false;
        return false;
      }

      //캔들 몸통이 모두 벗어났을 경우 롱
      if (lastBB.upper < lastLow && lastClose > sma160 && lastHigh < curHigh) {
        buySignal = false;
        return true;
      }

      if (lastClose < sma160 && buySignal === true) {
        buySignal = false;
      }

      if (buySignal) {
        if (curLow > curBB.lower) {
          buySignal = false;
          return true;
        } else {
          return false;
        }
      }

      if (lastBB.lower > lastLow && lastClose > sma160) {
        buySignal = true;
      }

      return false;
    };

    const getSellCheck = (
      lastBB,
      lastHigh,
      lastLow,
      lastClose,
      curLow,
      curHigh,
      sma160,
      curBB,
      curSma160
    ) => {
      const standardDiff = lastClose * 0.01;
      if (position === 'SHORT') return false;

      if (curBB.upper - curBB.lower < standardDiff) {
        sellSignal = false;
        return false;
      }

      if (curSma160 - curBB.upper < standardDiff) {
        sellSignal = false;
        return false;
      }

      //캔들 몸통이 모두 벗어났을 경우 숏
      if (lastBB.lower > lastHigh && lastClose < sma160 && lastLow > curLow) {
        sellSignal = false;
        return true;
      }

      if (lastClose > sma160 && sellSignal === true) {
        sellSignal = false;
      }

      if (sellSignal) {
        if (curHigh < curBB.upper) {
          sellSignal = false;
          return true;
        } else {
          return false;
        }
      }

      if (lastBB.upper < lastHigh && lastClose < sma160) {
        sellSignal = true;
      }

      return false;
    };

    //손절, 익절을 위한 볼린저 밴드 체크
    const checkBB = (curBB, curHigh, curLow) => {
      // 롱 포지션 일 때, 볼린저 밴드 상단 돌파 했는지 체크
      // 숏 포지션 일 때, 볼린저 밴드 하단 돌파 했는지 체크
      if (
        (position === 'LONG' && curHigh > curBB.upper) ||
        (position === 'SHORT' && curLow < curBB.lower)
      ) {
        closeSignal = true;
      } else {
        closeSignal = false;
      }
    };

    // 포지션 모니터링 손절,익절 체크
    function checkStopLoss(
      curBB,
      curHigh,
      curLow,
      curStart,
      curClose,
      lastBB,
      lastHigh,
      lastLow,
      lastStart,
      lastClose,
      closedDate,
      sma160,
      marketPrice
    ) {
      // 손절, 익절 구간 체크
      let closeCheck = false;
      let stopTakeCheck = false;
      let changedWave = false;
      let bbCheck = false;

      try {
        if (position === 'LONG') {
          const profit =
            (marketPrice - entryPrice) * (currentBalance / entryPrice);
          const profitPercent = (profit / currentBalance) * 100;

          stopTakeCheck =
            Number(marketPrice) <= Number(stopLossPrice) ||
            Number(marketPrice) >= Number(takeProfitPrice);

          //추세 변환 체크
          changedWave = Number(marketPrice) < sma160;
          closeCheck = stopTakeCheck || changedWave;

          checkBB(lastBB, lastHigh, lastLow);

          if (closeSignal) {
            // 볼린저 밴드 상단(롱), 하단(숏) 돌파 신호 받은 상태
            if (
              curHigh < curBB.upper ||
              (lastHigh > curHigh && curStart > curClose)
            ) {
              closeCheck = true;
              closeSignal = false;
              bbCheck = true;
            }
          }

          if (closeCheck) {
            closeSignal = false;

            // 롱 포지션 종료
            const fee = currentBalance * 0.001;
            currentBalance += profit;
            currentBalance -= fee;

            results.push({
              date: closedDate,
              action: 'SELL LONG position closed-2',
              price: marketPrice,
              profit: profit,
              profitPercent: profitPercent,
              fee,
              totalBalance: currentBalance,
              stopTakeCheck,
              changedWave,
              bbCheck,
            });

            bbCheck = false;
            position = null;
            totalTradeCount++;
            if (profit > 0) profitTradeCount++;
          }
        } else if (position === 'SHORT') {
          const profit =
            (entryPrice - marketPrice) * (currentBalance / entryPrice);
          const profitPercent = (profit / currentBalance) * 100;

          stopTakeCheck =
            Number(curStart) >= Number(stopLossPrice) ||
            Number(curStart) <= Number(takeProfitPrice);

          //추세 변환 체크
          changedWave = Number(curStart) > sma160;
          closeCheck = stopTakeCheck || changedWave;

          checkBB(lastBB, lastHigh, lastLow);

          if (closeSignal) {
            // 볼린저 밴드 상단(롱), 하단(숏) 돌파 신호 받은 상태
            if (
              curLow > curBB.lower ||
              (lastLow < curLow && curStart < curClose)
            ) {
              closeCheck = true;
              closeSignal = false;
              bbCheck = true;
            }
          }

          if (closeCheck) {
            closeSignal = false;

            // 숏 포지션 종료
            const fee = currentBalance * 0.001;
            currentBalance += profit;
            currentBalance -= fee;

            results.push({
              date: closedDate,
              action: 'BUY SHORT position closed-2',
              price: marketPrice,
              profit: profit,
              profitPercent: profitPercent,
              fee,
              totalBalance: currentBalance,
              stopTakeCheck,
              changedWave,
              bbCheck,
            });

            bbCheck = false;
            position = null;
            totalTradeCount++;
            if (profit > 0) profitTradeCount++;
          }
        }
      } catch (error) {
        console.error('Failed to monitor positions:', error);
        throw error;
      }
    }

    for (let i = 320; i < candles.length; i++) {
      //console process percent
      if (i % 1000 === 0) {
        console.log(
          `${((i / candles.length) * 100).toFixed(
            2
          )}%, totalBalance : ${currentBalance.toFixed(
            2
          )} date: ${convertToKoreanTimeZone(new Date(candles[i - 1][0]))}`
        );
      }

      const candleSlice = candles.slice(i - 320, i);
      const indicators = calculateIndicators(candleSlice, 20, 1);
      const { rsi, bb, closes, starts, highs, lows, sma60, sma120, sma160 } =
        indicators;

      const buyCheck = getBuyCheck(
        bb.at(-3),
        highs.at(-3),
        lows.at(-3),
        closes.at(-3),
        lows.at(-2),
        highs.at(-2),
        sma160.at(-3),
        bb.at(-2),
        sma160.at(-2)
      );

      const sellCheck = getSellCheck(
        bb.at(-3),
        highs.at(-3),
        lows.at(-3),
        closes.at(-3),
        lows.at(-2),
        highs.at(-2),
        sma160.at(-3),
        bb.at(-2),
        sma160.at(-2)
      );

      if (logMode) {
        console.log(
          ` buyCheck : ${buyCheck}, sellCheck : ${sellCheck},date: ${convertToKoreanTimeZone(
            new Date(candles[i - 1][0])
          )}`
        );
      }

      if (position === null) {
        if (buyCheck) {
          // 롱 포지션 진입
          position = 'LONG';
          entryPrice = starts.at(-1);
          const { stopLoss, takeProfit } = calculateStopLossTakeProfit(
            'LONG',
            candles.slice(i - 20, i),
            entryPrice
          );
          stopLossPrice = stopLoss;
          takeProfitPrice = takeProfit;
          results.push({
            date: convertToKoreanTimeZone(new Date(candles[i - 1][0])),
            action: 'BUY LONG position entered',
            price: entryPrice,
            profit: 0,
            stopLossPrice,
            takeProfitPrice,
            sma160: sma160.at(-1),
            totalBalance: currentBalance,
          });

          if (logMode) {
            console.log(results.at(-1));
          }

          continue;
        } else if (sellCheck) {
          // 숏 포지션 진입
          position = 'SHORT';
          entryPrice = starts.at(-1);
          const { stopLoss, takeProfit } = calculateStopLossTakeProfit(
            'SHORT',
            candles.slice(i - 20, i),
            entryPrice
          );

          stopLossPrice = stopLoss;
          takeProfitPrice = takeProfit;

          results.push({
            date: convertToKoreanTimeZone(new Date(candles[i - 1][0])),
            action: 'SELL SHORT position entered',
            price: entryPrice,
            profit: 0,
            stopLossPrice,
            takeProfitPrice,
            sma160: sma160.at(-1),
            totalBalance: currentBalance,
          });

          if (logMode) {
            console.log(results.at(-1));
          }

          continue;
        }
      } else {
        //손절, 익절 체크
        checkStopLoss(
          bb.at(-2),
          highs.at(-2),
          lows.at(-2),
          starts.at(-2),
          closes.at(-2),
          bb.at(-3),
          highs.at(-3),
          lows.at(-3),
          starts.at(-3),
          closes.at(-3),
          convertToKoreanTimeZone(new Date(candles[i - 1][0])),
          sma160.at(-1),
          starts.at(-1)
        );
      }
    }

    if (results.length > 0 && results[results.length - 1].totalBalance > 1000) {
      console.log(results[results.length - 1].totalBalance);
    }

    if (saveCSV) {
      // 백테스트 결과를 저장할 CSV 작성자 설정
      const csvWriter = createCsvWriter({
        path: `backTestResult/backtest_results_${symbol}-${Date.now().toString()}.csv`,
        header: [
          { id: 'date', title: 'DATE' },
          { id: 'action', title: 'ACTION' },
          { id: 'price', title: 'PRICE' },
          { id: 'profit', title: 'PROFIT' },
          { id: 'profitPercent', title: 'PROFIT_PERCENT' },
          { id: 'fee', title: 'FEE' },
          { id: 'stopTakeCheck', title: 'STOP_TAKE_CHECK' },
          { id: 'changedWave', title: 'CHANGED_WAVE' },
          { id: 'bbCheck', title: 'BB_CHECK' },
          { id: 'sma160', title: 'SMA160' },
          { id: 'totalBalance', title: 'TOTAL_BALANCE' },
        ],
        encoding: 'utf8',
      });

      csvWriter.writeRecords(results).then(() => {
        console.log('Backtest results saved to backtest_results.csv');
      });
    }

    console.log(
      `totalTradeCount : ${totalTradeCount}, profitTradeCount : ${profitTradeCount}, lossTradeCount: ${
        totalTradeCount - profitTradeCount
      }
        `
    );

    return currentBalance; // 현재 잔액을 반환
  } catch (error) {
    console.error('Backtest failed:', error);
    return initialCapital; // 에러 발생 시 초기 자본 반환
  }
}

const convertToKoreanTimeZone = (date) => {
  return new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString();
};

// 캔들스틱 데이터 가져오기
async function fetchCandlestickData(symbol, interval, startTime, endTime) {
  try {
    let candles = [];
    let start = startTime;

    while (start < endTime) {
      const newCandles = await binance.futuresCandles(symbol, interval, {
        startTime: start,
        endTime,
      });
      candles = candles.concat(newCandles);
      if (newCandles.length < 500) break; // 더 이상 데이터가 없으면 루프 종료
      start =
        newCandles[newCandles.length - 1][0] + intervalToMilliseconds(interval); // 마지막 캔들의 끝 시간을 새로운 시작 시간으로 설정
    }

    return candles;
  } catch (error) {
    console.error(`Failed to fetch candlestick data for ${symbol}:`, error);
    throw error;
  }
}

// 시간 간격을 밀리초로 변환
function intervalToMilliseconds(interval) {
  const units = {
    m: 60000,
    h: 3600000,
    d: 86400000,
  };
  const unit = interval[interval.length - 1];
  const value = parseInt(interval.slice(0, -1), 10);

  return units[unit] * value;
}

async function onceBacktest() {
  const finalBalance = await backtest(
    'BTCUSDT',
    // 'ETHUSDT',
    //'XRPUSDT',
    '15m',
    '2021-01-01',
    '2021-03-01',
    true
  );
  console.log(finalBalance);
}

async function optimizeParameters() {
  const results = [];
  const symbol = 'BTCUSDT';
  const interval = '15m';
  const start = '2021-01-01';
  const end = '2024-07-25';

  // 범위와 간격 설정
  const stopLossRange = { min: 1, max: 3, step: 0.2 };
  const takeProfitRange = { min: 1.5, max: 4.5, step: 0.2 };

  let bestResult = {
    stopLossPercent: null,
    finalBalance: 0,
  };

  // 범위 내에서 일정한 간격으로 값 생성
  const generateRange = (range) => {
    const values = [];
    for (let value = range.min; value <= range.max; value += range.step) {
      values.push(value);
    }
    return values;
  };

  const stopLossOptions = generateRange(stopLossRange);
  const takeProfitOptions = generateRange(takeProfitRange);

  for (let stopLoss of stopLossOptions) {
    for (let takeProfit of takeProfitOptions) {
      const finalBalance = await backtest(
        symbol,
        interval,
        start,
        end,
        stopLoss,
        takeProfit
      );

      console.log(
        `Testing with stopLoss: ${stopLoss}%, takeProfit: ${takeProfit}, finalBalance: ${finalBalance}`
      );

      results.push({
        stopLossPercent: stopLoss,
        takeProfitPercent: takeProfit,
        finalBalance: finalBalance,
      });

      if (finalBalance > bestResult.finalBalance) {
        bestResult = {
          stopLossPercent: stopLoss,
          takeProfitPercent: takeProfit,
          finalBalance: finalBalance,
        };
      }
    }
  }

  const csvWriter = createCsvWriter({
    path: `future_backtest_optimizeParameters_${Date.now().toString()}.csv`,
    header: [
      { id: 'stopLossPercent', title: 'STOP_LOSS' },
      { id: 'takeProfitPercent', title: 'TAKE_PROFIT' },
      { id: 'finalBalance', title: 'FINAL_BALANCE' },
    ],
  });

  csvWriter.writeRecords(results).then(() => {
    console.log('Backtest results saved to backtest_results.csv');
  });

  console.log('Best parameters found:', bestResult);
}

// 백테스트 실행
// optimizeParameters();
onceBacktest();

exports.backtest = {
  backtest,
};
