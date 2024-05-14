const Binance = require('node-binance-api');
const { RSI } = require('technicalindicators');

const binance = new Binance().options({
  APIKEY: process.env.BINANCE_API_KEY,
  APISECRET: process.env.BINANCE_API_SECRET,
  family: 4,
});

async function fetchCandlestickData(symbol, interval, limit) {
  return binance.futuresCandles(symbol, interval, { limit });
}

async function backTest(
  symbol,
  interval,
  rsiBuyThreshold,
  rsiSellThreshold,
  stopLossPercent,
  stopPlusPercent,
  leverage
) {
  const limit = 1500;
  let tradeCount = 0;
  let plusCount = 0;
  let cumulativeProfit = 0;
  let positionOpen = false;
  let entryPrice = 0;

  const candles = await fetchCandlestickData(symbol, interval, limit);
  const closes = candles.map((c) => parseFloat(c[4]));
  const rsiValues = RSI.calculate({ period: 14, values: closes });

  for (let i = 14; i < closes.length; i++) {
    const currentPrice = closes[i];
    const rsi = rsiValues[i - 14]; // RSI 배열은 closes 배열보다 14개 작음

    if (!positionOpen && rsi < rsiBuyThreshold) {
      entryPrice = currentPrice;
      positionOpen = true;
    } else if (positionOpen && rsi > rsiSellThreshold) {
      let profit = ((currentPrice - entryPrice) / entryPrice) * 100 * leverage;
      cumulativeProfit += profit;
      positionOpen = false;
      tradeCount++;
    } else if (positionOpen) {
      let profitPercent =
        ((currentPrice - entryPrice) / entryPrice) * 100 * leverage;
      if (
        profitPercent <= stopLossPercent ||
        profitPercent >= stopPlusPercent
      ) {
        if (profitPercent > 0) {
          plusCount++;
        }

        cumulativeProfit += profitPercent;
        positionOpen = false;
        tradeCount++;
      }
    }
  }

  console.log(
    `거래 횟수: ${tradeCount}, 수익 횟수: ${plusCount} 누적 손익: ${cumulativeProfit.toFixed(
      2
    )}%`
  );
  return { tradeCount, plusCount, cumulativeProfit };
}

const startBackTest = async () => {
  const backTestBoundary = 20;
  const top3 = [];

  for (let i = 5; i < backTestBoundary; i++) {
    for (let j = 5; j < backTestBoundary; j++) {
      const result = await backTest('BTCUSDT', '15m', 30, 70, -i, j, 20);
      top3.push({ ...result, stopLossPercent: j, stopPlusPercent: i });
      console.log(result);
    }
  }

  top3.sort((a, b) => b.cumulativeProfit - a.cumulativeProfit);
  console.log(top3.slice(0, 3));
};

//startBackTest();

//backTest('BTCUSDT', '15m', 30, 70, -5, 17, 20);

exports.backTest = backTest;
