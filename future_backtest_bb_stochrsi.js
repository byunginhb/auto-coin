require('dotenv').config();
const Binance = require('node-binance-api');
const { calculateIndicators } = require('./binance_common').binance_common;
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const fs = require('fs');
const path = require('path');

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
  let stopLossPercent = 0;
  let takeProfitPercent = 0;

  try {
    const dataFilePath = path.resolve(
      __dirname,
      `future_backdata_${symbol}-${start}-${end}-${interval}.json`
    );
    let candles;

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

    const getBuyCheck = (
      position,
      lastClose,
      lastLow,
      lastBB,
      stochasticRSI
    ) => {
      if (position === 'LONG') return false;

      if (
        lastBB.lower > lastClose &&
        lastBB.lower > lastLow &&
        stochasticRSI.stochRSI < 20
      ) {
        return true;
      }

      return false;
    };

    const getSellCheck = (
      position,
      lastClose,
      lastHigh,
      lastBB,
      stochasticRSI
    ) => {
      if (position === 'SHORT') return false;

      if (
        lastBB.upper < lastClose &&
        lastBB.upper < lastHigh &&
        stochasticRSI.stochRSI > 80
      ) {
        return true;
      }

      return false;
    };

    for (let i = 50; i < candles.length; i++) {
      const candleSlice = candles.slice(i - 50, i);
      const indicators = calculateIndicators(candleSlice, 20, 3);
      const { lastBB, stochasticRSI, lastClose, lastLow, lastHigh } =
        indicators;

      const buyCheck = getBuyCheck(
        position,
        lastClose,
        lastLow,
        lastBB,
        stochasticRSI
      );
      const sellCheck = getSellCheck(
        position,
        lastClose,
        lastHigh,
        lastBB,
        stochasticRSI
      );

      if (buyCheck) {
        if (position === 'SHORT') {
          results.push(
            closePosition(
              lastClose,
              convertToKoreanTimeZone(new Date(candles[i][0]))
            )
          );
        }

        // 롱 포지션 진입
        position = 'LONG';
        entryPrice = lastClose;
        results.push({
          date: convertToKoreanTimeZone(new Date(candles[i][0])),
          action: 'BUY LONG position entered',
          price: entryPrice,
          profit: 0,
          totalBalance: currentBalance,
        });

        stopLossPercent = (lastBB.middle - lastBB.lower) / lastClose;
        takeProfitPercent = stopLossPercent * 2;

        continue;
      } else if (sellCheck) {
        if (position === 'LONG') {
          results.push(
            closePosition(
              lastClose,
              convertToKoreanTimeZone(new Date(candles[i][0]))
            )
          );
        }

        // 숏 포지션 진입
        position = 'SHORT';
        entryPrice = lastClose;
        results.push({
          date: convertToKoreanTimeZone(new Date(candles[i][0])),
          action: 'SELL SHORT position entered',
          price: entryPrice,
          profit: 0,
          totalBalance: currentBalance,
        });

        stopLossPercent = (lastBB.upper - lastBB.middle) / lastClose;
        takeProfitPercent = stopLossPercent * 2;

        continue;
      }

      //손절,익절 체크
      if (position === 'LONG') {
        const profit = (lastClose - entryPrice) * (currentBalance / entryPrice);
        const profitPercent = (profit / currentBalance) * 100;

        if (
          profit >= (takeProfitPercent / 100) * currentBalance ||
          profit <= -(stopLossPercent / 100) * currentBalance
        ) {
          // 롱 포지션 종료
          currentBalance += profit;
          results.push({
            date: convertToKoreanTimeZone(new Date(candles[i][0])),
            action: 'SELL LONG position closed-2',
            price: lastClose,
            profit: profit,
            profitPercent: profitPercent,
            totalBalance: currentBalance,
          });
          position = null;
        }
      } else if (position === 'SHORT') {
        const profit = (entryPrice - lastClose) * (currentBalance / entryPrice);
        const profitPercent = (profit / currentBalance) * 100;

        if (
          profit >= (takeProfitPercent / 100) * currentBalance ||
          profit <= -(stopLossPercent / 100) * currentBalance
        ) {
          // 숏 포지션 종료
          currentBalance += profit;
          results.push({
            date: convertToKoreanTimeZone(new Date(candles[i][0])),
            action: 'BUY SHORT position closed-2',
            price: lastClose,
            profit: profit,
            profitPercent: profitPercent,
            totalBalance: currentBalance,
          });
          position = null;
        }
      }
    }

    // if (results.length > 0 && results[results.length - 1].totalBalance > 1000) {
    console.log(results[results.length - 1].totalBalance);
    // }

    if (saveCSV) {
      // 백테스트 결과를 저장할 CSV 작성자 설정
      const csvWriter = createCsvWriter({
        path: `future_backtest_results_${symbol}-${Date.now().toString()}.csv`,
        header: [
          { id: 'date', title: 'DATE' },
          { id: 'action', title: 'ACTION' },
          { id: 'price', title: 'PRICE' },
          { id: 'profit', title: 'PROFIT' },
          { id: 'profitPercent', title: 'PROFIT_PERCENT' },
          { id: 'totalBalance', title: 'TOTAL_BALANCE' },
        ],
        encoding: 'utf8',
      });

      csvWriter.writeRecords(results).then(() => {
        console.log('Backtest results saved to backtest_results.csv');
      });
    }

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
    //'ETHUSDT',
    //'XRPUSDT',
    '15m',
    '2024-06-01',
    '2024-07-25',
    true
  );
  console.log(finalBalance);
}

async function optimizeParameters() {
  const results = [];
  const symbol = 'BTCUSDT';
  const interval = '15m';
  const start = '2021-01-01';
  const end = '2024-06-25';

  // 범위와 간격 설정
  const stopLossRange = { min: 1, max: 5, step: 0.5 }; // 2% ~ 10%
  const takeProfitRange = { min: 2, max: 5, step: 0.5 }; // 5% ~ 20%
  const rsiBuyThresholdRange = { min: 30, max: 40, step: 2 };
  const rsiSellThresholdRange = { min: 60, max: 80, step: 2 };

  let bestResult = {
    stopLossPercent: null,
    takeProfitPercent: null,
    rsiBuyThreshold: null,
    rsiSellThreshold: null,
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
  const rsiBuyThresholdOptions = generateRange(rsiBuyThresholdRange);
  const rsiSellThresholdOptions = generateRange(rsiSellThresholdRange);

  for (let stopLoss of stopLossOptions) {
    for (let takeProfit of takeProfitOptions) {
      for (let rsiBuy of rsiBuyThresholdOptions) {
        for (let rsiSell of rsiSellThresholdOptions) {
          const finalBalance = await backtest(
            symbol,
            interval,
            start,
            end,
            stopLoss,
            takeProfit,
            rsiBuy,
            rsiSell
          );

          console.log(
            `Testing with stopLoss: ${stopLoss}%, takeProfit: ${takeProfit}%, rsiBuy: ${rsiBuy}, rsiSell: ${rsiSell}, finalBalance: ${finalBalance}`
          );

          results.push({
            stopLossPercent: stopLoss,
            takeProfitPercent: takeProfit,
            rsiBuyThreshold: rsiBuy,
            rsiSellThreshold: rsiSell,
            finalBalance: finalBalance,
          });

          if (finalBalance > bestResult.finalBalance) {
            bestResult = {
              stopLossPercent: stopLoss,
              takeProfitPercent: takeProfit,
              rsiBuyThreshold: rsiBuy,
              rsiSellThreshold: rsiSell,
              finalBalance: finalBalance,
            };
          }
        }
      }
    }
  }

  const csvWriter = createCsvWriter({
    path: `future_backtest_optimizeParameters_${Date.now().toString()}.csv`,
    header: [
      { id: 'stopLossPercent', title: 'STOP_LOSS' },
      { id: 'takeProfitPercent', title: 'TAKE_PROFIT' },
      { id: 'rsiBuyThreshold', title: 'RSI_BUY' },
      { id: 'rsiSellThreshold', title: 'RSI_SELL' },
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
// onceBacktest();

exports.backtest = {
  backtest,
};
