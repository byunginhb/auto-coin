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

  let longEntryPrice = null;
  let shortEntryPrice = null;

  let totalTradeCount = 0;
  let profitTradeCount = 0;

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

    const getBuyCheck = (
      bb,
      highs,
      lows,
      starts,
      closes,
      sma10,
      sma50,
      sma100
    ) => {
      //정배열 확인
      const plusWave =
        // sma10.at(-6) > sma50.at(-6) &&
        // sma10.at(-6) > sma100.at(-6) &&
        // sma50.at(-6) > sma100.at(-6) &&
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
        longEntryPrice = starts.at(-1);
        buySignal = false;
        return true;
      }

      if (buySignal && longEntryPrice < highs.at(-1)) {
        buySignal = false;

        if (starts.at(-1) > longEntryPrice) {
          longEntryPrice = starts.at(-1);
        }

        return false;
      }

      //정배열인지 확인
      if (plusWave) {
        // 연속 음봉
        const candleMinus3rows =
          starts.at(-6) > closes.at(-6) && starts.at(-5) > closes.at(-5);

        // 연속 양봉
        const candlePlus3rows =
          starts.at(-3) < closes.at(-3) && starts.at(-2) < closes.at(-2);

        if (candleMinus3rows && candlePlus3rows) {
          longEntryPrice = highs.at(-6);
          buySignal = true;
          return false;
        }
      } else {
        buySignal = false;
        longEntryPrice = null;
      }

      return false;
    };

    const getSellCheck = (
      bb,
      highs,
      lows,
      starts,
      closes,
      sma10,
      sma50,
      sma100
    ) => {
      if (position === 'SHORT') {
        const candleMinus3Check =
          starts.at(-4) > closes.at(-4) &&
          starts.at(-3) > closes.at(-3) &&
          starts.at(-2) > closes.at(-2);

        const candleMinus3WaveCheck =
          lows.at(-4) < lows.at(-5) &&
          lows.at(-3) < lows.at(-4) &&
          lows.at(-2) < lows.at(-3);

        if (candleMinus3Check && candleMinus3WaveCheck) {
          stopLossPrice = highs.at(-3);
        }

        return false;
      }

      const minusWave =
        // sma10.at(-6) < sma50.at(-6) &&
        // sma10.at(-6) < sma100.at(-6) &&
        // sma50.at(-6) < sma100.at(-6) &&
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
        shortEntryPrice = starts.at(-1);
        sellSignal = false;
        return true;
      }

      if (sellSignal && shortEntryPrice > lows.at(-1)) {
        if (shortEntryPrice > starts.at(-1)) {
          shortEntryPrice = starts.at(-1);
        }

        sellSignal = false;
        return false;
      }

      //역배열인지 확인
      if (minusWave) {
        const candlePlus3rows =
          starts.at(-6) < closes.at(-6) && starts.at(-5) < closes.at(-5);

        const candleMinus3rows =
          starts.at(-3) > closes.at(-3) && starts.at(-2) > closes.at(-2);

        if (candlePlus3rows && candleMinus3rows) {
          shortEntryPrice = lows.at(-6);
          sellSignal = true;
          return false;
        }
      } else {
        sellSignal = false;
        shortEntryPrice = null;
      }

      return false;
    };

    // 포지션 모니터링 손절,익절 체크
    function checkStopLoss(closedDate, curLow, curHigh, curSma100) {
      try {
        // 손절, 익절 구간 체크
        let closeCheck = false;
        let stopTakeCheck = false;
        let checkWave = false;

        if (position === 'LONG') {
          const profit =
            (curSma100 - entryPrice) * (currentBalance / entryPrice);
          const profitPercent = (profit / currentBalance) * 100;

          stopTakeCheck =
            Number(curLow) <= Number(curSma100) &&
            Number(curSma100) <= Number(curHigh);

          if (stopTakeCheck) {
            // 롱 포지션 종료
            const fee = currentBalance * 0.001;
            currentBalance += profit;
            currentBalance -= fee;

            results.push({
              date: closedDate,
              action: 'SELL LONG position closed-2',
              price: curSma100,
              profit: profit,
              profitPercent: profitPercent,
              fee,
              totalBalance: currentBalance,
            });

            position = null;
            totalTradeCount++;

            if (logMode) {
              console.log(results.at(-1));
            }

            if (profit > 0) profitTradeCount++;
          }
        } else if (position === 'SHORT') {
          const profit =
            (entryPrice - curSma100) * (currentBalance / entryPrice);
          const profitPercent = (profit / currentBalance) * 100;

          stopTakeCheck =
            Number(curLow) <= Number(curSma100) &&
            Number(curSma100) <= Number(curHigh);

          if (stopTakeCheck) {
            // 숏 포지션 종료
            const fee = currentBalance * 0.001;
            currentBalance += profit;
            currentBalance -= fee;

            results.push({
              date: closedDate,
              action: 'BUY SHORT position closed-2',
              price: curSma100,
              profit: profit,
              profitPercent: profitPercent,
              fee,
              totalBalance: currentBalance,
            });

            position = null;
            totalTradeCount++;

            if (logMode) {
              console.log(results.at(-1));
            }

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
      const indicators = calculateIndicators(candleSlice, 20, 2);
      const { bb, closes, starts, highs, lows, sma10, sma50, sma100 } =
        indicators;

      const buyCheck = getBuyCheck(
        bb,
        highs,
        lows,
        starts,
        closes,
        sma10,
        sma50,
        sma100
      );

      const sellCheck = getSellCheck(
        bb,
        highs,
        lows,
        starts,
        closes,
        sma10,
        sma50,
        sma100
      );

      if (logMode) {
        console.log(
          ` buyCheck : ${buyCheck}, sellCheck : ${sellCheck},date: ${convertToKoreanTimeZone(
            new Date(candles[i - 1][0])
          )}, position: ${position}`
        );
      }

      if (position === null) {
        if (buyCheck) {
          // 롱 포지션 진입
          position = 'LONG';
          entryPrice = longEntryPrice;
          results.push({
            date: convertToKoreanTimeZone(new Date(candles[i - 1][0])),
            action: 'BUY LONG position entered',
            price: entryPrice,
            profit: 0,
            totalBalance: currentBalance,
          });

          if (logMode) {
            console.log(results.at(-1));
          }

          continue;
        } else if (sellCheck) {
          // 숏 포지션 진입
          position = 'SHORT';
          entryPrice = shortEntryPrice;
          results.push({
            date: convertToKoreanTimeZone(new Date(candles[i - 1][0])),
            action: 'SELL SHORT position entered',
            price: entryPrice,
            profit: 0,
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
          convertToKoreanTimeZone(new Date(candles[i - 1][0])),
          lows.at(-1),
          highs.at(-1),
          sma100.at(-1)
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
    '30m',
    '2021-01-01',
    '2024-08-20 ',
    true
  );
  console.log(finalBalance);
}

// 백테스트 실행
// onceBacktest();

exports.backtest = {
  backtest,
};
