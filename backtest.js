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
  priceChangePercent,
  leverage
) {
  const limit = 1000;
  let tradeCount = 0;
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
      if (profitPercent <= priceChangePercent) {
        cumulativeProfit += profitPercent;
        positionOpen = false;
        tradeCount++;
      }
    }
  }

  console.log(
    `거래 횟수: ${tradeCount}, 누적 손익: ${cumulativeProfit.toFixed(2)}%`
  );
  return { tradeCount, cumulativeProfit };
}

// 함수 실행 예시
// backTest('ETHUSDT', '1m', 40, 60, -7, 21).then((result) => {
//   console.log(result);
// });

exports.backTest = backTest;
