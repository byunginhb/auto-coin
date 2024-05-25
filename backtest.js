const Binance = require('node-binance-api');
const { RSI, BollingerBands } = require('technicalindicators');

const binance = new Binance().options({
  APIKEY: process.env.BINANCE_API_KEY,
  APISECRET: process.env.BINANCE_API_SECRET,
  family: 4,
});

let buyCheck = false;
let sellCheck = false;

let symbol = 'BTCUSDT';
let rsiBuyThreshold = 33;
let rsiSellThreshold = 60;
let stopLossPercent = -3;
let stopPlusPercent = 45;
let interval = '15m';

// backTest();

async function backTest() {
  try {
    const candles = await binance.futuresCandles(symbol, interval, {
      limit: 1500,
    });
    const closes = candles.map((c) => parseFloat(c[4]));
    const highs = candles.map((c) => parseFloat(c[2]));
    const lows = candles.map((c) => parseFloat(c[3]));
    const rsiValues = RSI.calculate({ period: 14, values: closes });
    const bbValues = BollingerBands.calculate({
      period: 20,
      stdDev: 2,
      values: closes,
    });

    let tradeCount = 0;
    let totalProfitLoss = 0;
    let position = null;
    let buyPrice = 0;
    let buyAmount = 0;
    let coolDownIndex = -1;
    const coolDownPeriod = 2; // 2개 캔들 뛰어넘기 위해

    for (let i = 20; i < closes.length; i++) {
      const lastClose = closes[i];
      const lastHigh = highs[i];
      const lastLow = lows[i];
      const lastRSI = rsiValues[i - 14];
      const lastBB = bbValues[i - 20];

      if (position === 'buy') {
        const currentProfitLoss = (lastClose - buyPrice) * buyAmount;
        const lossThreshold = 1000 * (1 + stopLossPercent / 100);
        const profitThreshold = 1000 * (1 + stopPlusPercent / 100);
        const currentUSDTAmount = lastClose * buyAmount;
        const profitLossPercent = (currentProfitLoss / 1000) * 100;

        if (currentProfitLoss <= lossThreshold) {
          totalProfitLoss += currentProfitLoss;
          position = null;
          console.log(
            `손절: 산가격 ${buyPrice.toFixed(2)}, 판가격 ${lastClose.toFixed(
              2
            )}, 손익 ${currentProfitLoss.toFixed(
              2
            )} USDT, 수익률 ${profitLossPercent.toFixed(2)}%`
          );
          coolDownIndex = i + coolDownPeriod;
        } else if (currentProfitLoss >= profitThreshold) {
          totalProfitLoss += currentProfitLoss;
          position = null;
          console.log(
            `익절: 산가격 ${buyPrice.toFixed(2)}, 판가격 ${lastClose.toFixed(
              2
            )}, 손익 ${currentProfitLoss.toFixed(
              2
            )} USDT, 수익률 ${profitLossPercent.toFixed(2)}%`
          );
          coolDownIndex = i + coolDownPeriod;
        }
      }

      if (
        position === null &&
        (await getBuyCheck(
          lastRSI,
          lastClose,
          lastBB,
          lastLow,
          i,
          coolDownIndex,
          coolDownPeriod
        ))
      ) {
        position = 'buy';
        buyPrice = lastClose;
        buyAmount = 1000 / buyPrice; // 예를 들어 1000 USDT로 구매한다고 가정
        tradeCount++;
        console.log(
          `매수: 가격 ${buyPrice.toFixed(2)}, 수량 ${buyAmount.toFixed(2)}`
        );
        coolDownIndex = i + coolDownPeriod;
      } else if (
        position === 'buy' &&
        (await getSellCheck(
          lastRSI,
          lastClose,
          lastBB,
          lastHigh,
          i,
          coolDownIndex,
          coolDownPeriod
        ))
      ) {
        const currentProfitLoss = (lastClose - buyPrice) * buyAmount;
        totalProfitLoss += currentProfitLoss;
        const profitLossPercent = (currentProfitLoss / 1000) * 100;
        position = null;
        console.log(
          `매도: 산가격 ${buyPrice.toFixed(2)}, 판가격 ${lastClose.toFixed(
            2
          )}, 손익 ${currentProfitLoss.toFixed(
            2
          )} USDT, 수익률 ${profitLossPercent.toFixed(2)}%`
        );
        coolDownIndex = i + coolDownPeriod;
      }
    }

    const totalProfitLossPercent = (totalProfitLoss / 1000) * 100;
    console.log(`거래 횟수: ${tradeCount}`);
    console.log(`누적 손익 USDT 금액: ${totalProfitLoss.toFixed(2)} USDT`);
    console.log(`손익률: ${totalProfitLossPercent.toFixed(2)}%`);
  } catch (error) {
    console.error('백테스트 실행 중 오류가 발생했습니다:', error);
  }
}

async function getBuyCheck(
  rsi,
  lastClose,
  bb,
  lastLow,
  currentIndex,
  coolDownIndex,
  coolDownPeriod
) {
  if (coolDownIndex > currentIndex) {
    return false;
  }

  if (buyCheck && lastClose > bb.lower && lastLow > bb.lower) {
    buyCheck = false;
    return true;
  } else if (rsi < rsiBuyThreshold && lastClose < bb.lower) {
    if (!buyCheck) {
      buyCheck = true;
      coolDownIndex = currentIndex + coolDownPeriod;
      return false;
    } else {
      buyCheck = false;
    }
    return true;
  }
  return false;
}

async function getSellCheck(
  rsi,
  lastClose,
  bb,
  lastHigh,
  currentIndex,
  coolDownIndex,
  coolDownPeriod
) {
  if (coolDownIndex > currentIndex) {
    return false;
  }

  if (sellCheck && lastClose < bb.upper && lastHigh < bb.upper) {
    sellCheck = false;
    return true;
  } else if (rsi > rsiSellThreshold && lastClose > bb.upper) {
    if (!sellCheck) {
      sellCheck = true;
      coolDownIndex = currentIndex + coolDownPeriod;
      return false;
    } else {
      sellCheck = false;
    }
    return true;
  }
  return false;
}

exports.backTest = backTest;
