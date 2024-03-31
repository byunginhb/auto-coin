require('dotenv').config();
const Binance = require('node-binance-api');
const { BollingerBands, RSI } = require('technicalindicators');
const chatId = process.env.TELEGRAM_BOT_CHAT_ID;

const binance = new Binance().options({
  APIKEY: process.env.BINANCE_API_KEY,
  APISECRET: process.env.BINANCE_API_SECRET,
  family: 4,
});

// 매수 및 매도 조건 설정
const rsiBuyThreshold = 30; // RSI 과매도 조건
const rsiSellThreshold = 70; // RSI 과매수 조건

let intervalHandler = null;
let telegramBot = null;

function sendMessage(message) {
  telegramBot.sendMessage(chatId, message);
}

function setTelegramBot(bot) {
  telegramBot = bot;
}

async function fetchCandlestickData(symbol, interval = '5m') {
  const limit = 2500; // 데이터 개수 제한

  return new Promise((resolve, reject) => {
    binance.candlesticks(
      symbol,
      interval,
      (error, ticks, symbol) => {
        if (error) {
          reject(error);
        } else {
          resolve(ticks);
        }
      },
      { limit: limit, endTime: Date.now() }
    );
  });
}

async function backtest(symbol, interval = '5m') {
  try {
    const ticks = await fetchCandlestickData(symbol, interval);
    const closes = ticks.map((tick) => parseFloat(tick[4])); // 종가 데이터

    // 지표 계산
    const rsiValues = RSI.calculate({ period: 14, values: closes });
    const bbValues = BollingerBands.calculate({
      period: 20,
      stdDev: 2,
      values: closes,
    });

    let position = 'none'; // 현재 포지션 상태: none, buy
    let buyPrice = 0;
    let sellPrice = 0;
    let profits = [];

    for (let i = 20; i < closes.length; i++) {
      const currentClose = closes[i];
      const currentRSI = rsiValues[i - 14]; // RSI 계산을 위해 시작 인덱스 조정
      const currentBB = bbValues[i - 20]; // BB 계산을 위해 시작 인덱스 조정

      if (
        position === 'none' &&
        (currentRSI < rsiBuyThreshold || currentClose < currentBB.lower)
      ) {
        position = 'buy';
        buyPrice = currentClose;
        console.log(`Buy at ${buyPrice}`);
      } else if (
        position === 'buy' &&
        (currentRSI > rsiSellThreshold || currentClose > currentBB.upper)
      ) {
        position = 'none';
        sellPrice = currentClose;
        profits.push(sellPrice - buyPrice);
        console.log(`Sell at ${sellPrice}, Profit: ${sellPrice - buyPrice}`);
      }
    }

    const totalProfit = profits.reduce((acc, profit) => acc + profit, 0);
    console.log(`Total Profit: ${totalProfit}, Trade Count: ${profits.length}`);
    sendMessage(`Total Profit: ${totalProfit}, Trade Count: ${profits.length}`);
  } catch (error) {
    console.error('Backtesting failed:', error);
  }
}

async function trade(symbol, interval = '5m') {
  try {
    // 마지막 500개의 캔들 데이터를 가져옵니다.
    const candles = await binance.futuresCandles(symbol, interval, {
      limit: 500,
    });
    const closes = candles.map((c) => parseFloat(c[4]));
    const baseAsset = symbol.replace('USDT', '');

    // RSI 및 볼린저 밴드 지표 계산
    const rsiValues = RSI.calculate({ period: 14, values: closes });
    const bbValues = BollingerBands.calculate({
      period: 20,
      stdDev: 2,
      values: closes,
    });
    const lastClose = closes[closes.length - 1];
    const lastRSI = rsiValues[rsiValues.length - 1];
    const lastBB = bbValues[bbValues.length - 1];

    // 계정 잔액 조회
    const accountInfo = await binance.futuresAccount();
    const usdtBalance = accountInfo.assets.find(
      (asset) => asset.asset === 'USDT'
    ).walletBalance;
    const baseBalance = accountInfo.assets.find(
      (asset) => asset.asset === baseAsset
    ).walletBalance;

    // 현재 가격 조회
    const currentPrices = await binance.futuresPrices();
    const currentPrice = currentPrices[symbol];
    const quantity = (usdtBalance / currentPrice).toFixed(3);

    console.log(
      `usdtBalance=${usdtBalance}, baseBalance=${baseBalance}, lastRSI=${lastRSI}, lastClose=${lastClose}, lastBB.lower=${lastBB.lower}, lastBB.upper=${lastBB.upper}`
    );

    sendMessage(
      `usdtBalance=${usdtBalance}, baseBalance=${baseBalance}, lastRSI=${lastRSI}, lastClose=${lastClose}, lastBB.lower=${lastBB.lower}, lastBB.upper=${lastBB.upper}`
    );

    // 매수 조건 확인
    if (lastRSI < rsiBuyThreshold || lastClose < lastBB.lower) {
      console.log(
        `매수 조건 충족. ${usdtBalance} 수량으로 ${symbol} 매수 실행.`
      );
      const orderResult = await binance.futuresMarketBuy(symbol, usdtBalance);
      sendMessage(
        `매수 조건 충족. ${usdtBalance} 수량으로 ${symbol} 매수 실행.`
      );
      console.log(orderResult);
    }
    // 매도 조건 확인
    else if (lastRSI > rsiSellThreshold || lastClose > lastBB.upper) {
      console.log(
        `매도 조건 충족. ${baseBalance} 수량으로 ${symbol} 매도 실행.`
      );
      const orderResult = await binance.futuresMarketSell(symbol, baseBalance);
      console.log(orderResult);
      sendMessage(
        `매도 조건 충족. ${baseBalance} 수량으로 ${symbol} 매도 실행.`
      );
    } else {
      console.log('조건에 해당하지 않음. 대기합니다.');
    }
  } catch (error) {
    console.error('Trade execution failed:', error);
  }
}

async function startTrade(symbol, interval = '5m') {
  try {
    if (intervalHandler !== null) {
      clearInterval(intervalHandler);
      intervalHandler = null;
      console.log('실행중인 트레이딩을 종료합니다.');
    }

    trade(symbol, interval);

    // 1분마다 trade 함수 실행
    intervalHandler = setInterval(() => trade(symbol, interval), 60 * 1000);
    console.log('트레이딩을 실행합니다.');
  } catch (error) {
    console.error('Trade execution start failed:', error);
  }
}

async function endTrade() {
  try {
    if (intervalHandler !== null) {
      clearInterval(intervalHandler);
      intervalHandler = null;
      console.log('트레이딩을 종료합니다.');
    }
  } catch (error) {
    console.error('Trade execution end failed:', error);
  }
}

exports.binance = { backtest, startTrade, endTrade, setTelegramBot };
