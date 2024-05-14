require('dotenv').config();
const Binance = require('node-binance-api');
const { BollingerBands, RSI } = require('technicalindicators');
const chatId = process.env.TELEGRAM_BOT_CHAT_ID;

const binance = new Binance().options({
  APIKEY: process.env.BINANCE_API_KEY,
  APISECRET: process.env.BINANCE_API_SECRET,
  family: 4,
});

// 숫자 소수점 자릿수 잘라내기
function truncateNumber(strNum, digits) {
  let num = Number(strNum);
  let factor = Math.pow(10, digits);
  num = Math.floor(num * factor) / factor;
  return num;
}

async function adjustQuantity(symbol, quantity) {
  if (quantity === 0) return 0;

  try {
    // 심볼 정보 가져오기
    const exchangeInfo = await binance.exchangeInfo();
    const symbolInfo = exchangeInfo.symbols.find((s) => s.symbol === symbol);
    const lotSizeFilter = symbolInfo.filters.find(
      (f) => f.filterType === 'LOT_SIZE'
    );

    // 필터 정보 확인
    const minQty = parseFloat(lotSizeFilter.minQty);
    const maxQty = parseFloat(lotSizeFilter.maxQty);
    const stepSize = parseFloat(lotSizeFilter.stepSize);

    // 주문 수량 조정
    quantity = Math.max(minQty, Math.min(quantity, maxQty));
    quantity = Math.floor(quantity / stepSize) * stepSize;
    let fixedResult = Number(quantity.toFixed(10));

    return fixedResult;
  } catch (error) {
    console.error('Failed to adjust quantity:', error);
    throw error;
  }
}

// 매수 및 매도 조건 설정
const rsiBuyThreshold = 40; // RSI 과매도 조건
const rsiSellThreshold = 65; // RSI 과매수 조건

// 손절, 손익 조건
const stopLossPercent = -5; // 손절 조건
const stopPlusPercent = 5; // 손익 조건
let buyPrice = null;
let position = null; // 포지션 상태 변경
let buyUsdtAmount = 0;

let intervalHandler = null;
let telegramBot = null;

function sendMessage(message) {
  telegramBot.sendMessage(chatId, message);
}

function setTelegramBot(bot) {
  telegramBot = bot;
}

// 거래 데이터 가져오기
const getTradeData = async (symbol = 'BTCUSDT', interval = '15m') => {
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
  const accountInfo = await binance.account();
  const usdtBalance = accountInfo.balances.find(
    (asset) => asset.asset === 'USDT'
  ).free;
  const baseBalance = accountInfo.balances.find(
    (asset) => asset.asset === baseAsset
  ).free;

  // 현재 가격 조회
  const currentPrices = await binance.prices();
  const currentPrice = currentPrices[symbol];
  const qt = usdtBalance > 1 ? (usdtBalance / currentPrice).toFixed(6) : 0;

  const quantity = await adjustQuantity(symbol, qt);

  return {
    usdtBalance,
    baseBalance: parseFloat(baseBalance),
    lastRSI,
    lastClose,
    lastBB,
    currentPrice,
    quantity,
  };
};

//trade('BTCUSDT', '15m');

// 트레이밍 함수
async function trade(symbol, interval = '15m') {
  try {
    const {
      usdtBalance,
      baseBalance,
      lastRSI,
      lastClose,
      lastBB,
      currentPrice,
      quantity,
    } = await getTradeData(symbol, interval).catch((error) => {
      console.error('Failed to get trade data:', error);
    });

    if (baseBalance > 0.0001) {
      position = 'buy';
      //구매한 가격을 가져와서 buyPrice에 저장
      const trades = await binance.trades(symbol);
      buyPrice = parseFloat(trades[trades.length - 1].price);
      buyUsdtAmount = parseFloat(trades[trades.length - 1].quoteQty);
    }

    // 손절 조건 확인
    if (position === 'buy' && buyUsdtAmount > 0) {
      checkStopLoss(symbol, parseFloat(currentPrice), parseFloat(baseBalance));
    }

    // 매수 조건 확인
    if (
      quantity > 0.001 &&
      lastRSI <= rsiBuyThreshold &&
      lastClose <= lastBB.lower
    ) {
      const orderResult = await binance.marketBuy(symbol, quantity);
      console.log(orderResult);

      position = 'buy';
      buyPrice = orderResult?.fills[0]?.price;
      buyUsdtAmount = parseFloat(usdtBalance);

      sendMessage(
        `매수 조건 충족. 
RSI : ${lastRSI},
Close : ${lastClose},
BB.lower : ${lastBB.lower},
BB.upper : ${lastBB.upper}        
${usdtBalance}USDT 수량으로 ${symbol} ${buyPrice}가격으로 ${quantity}개 매수 실행.`
      );
    }
    // 매도 조건 확인
    else if (
      baseBalance > 0.00001 &&
      lastRSI >= rsiSellThreshold &&
      lastClose >= lastBB.upper
    ) {
      const adjustBalance = await adjustQuantity(symbol, baseBalance);
      const orderResult = await binance.marketSell(symbol, adjustBalance);
      console.log(orderResult);

      sendMessage(
        `매도 조건 충족. 
RSI : ${lastRSI},
Close : ${lastClose},
BB.lower : ${lastBB.lower},
BB.upper : ${lastBB.upper},
산가격 : ${buyPrice}, 판가격: ${currentPrice}
${baseBalance} 수량으로 ${currentPrice} ${symbol} 매도 실행.`
      );

      position = 'none';
      buyPrice = 0;
      buyUsdtAmount = 0;

      getBalance(symbol);
    } else {
      console.log('조건에 해당하지 않음. 대기합니다.');
    }
  } catch (error) {
    console.error('Trade execution failed:', error);
    sendMessage('트레이딩 실행 중 오류가 발생했습니다.', error);
  }
}

//손절, 손익 체크
const checkStopLoss = async (symbol, currentPrice, baseBalance) => {
  try {
    const lossThreshold = buyUsdtAmount * (1 + stopLossPercent / 100);
    const profitThreshold = buyUsdtAmount * (1 + stopPlusPercent / 100);
    const currentUSDTAmount = currentPrice * baseBalance;

    const quantity = truncateNumber(baseBalance, 4);

    // 손절 조건 확인
    if (currentUSDTAmount <= lossThreshold) {
      //전액 손절
      await binance.marketSell(symbol, quantity);
      sendMessage(
        `손절 조건 충족. ${baseBalance} 수량으로 ${currentPrice} ${symbol} 매도 실행.
      손해 USDT: ${(currentUSDTAmount - buyUsdtAmount).toFixed(2)}, 손해율 : ${(
          ((currentUSDTAmount - buyUsdtAmount) / buyUsdtAmount) *
          100
        ).toFixed(2)}%
      `
      );
      position = 'none'; // 포지션 초기화
      buyUsdtAmount = 0;
      getBalance(symbol);
    }
    // 수익 실현 조건 확인
    else if (currentUSDTAmount >= profitThreshold) {
      await binance.marketSell(symbol, quantity);
      sendMessage(
        `수익 실현 조건 충족. ${baseBalance} 수량으로 ${currentPrice} ${symbol} 매도 실행.
      수익 USDT: ${(currentUSDTAmount - buyUsdtAmount).toFixed(2)}, 수익율 : ${(
          ((currentUSDTAmount - buyUsdtAmount) / buyUsdtAmount) *
          100
        ).toFixed(2)}%
      `
      );
      position = 'none'; // 포지션 초기화
      buyUsdtAmount = 0;
      getBalance(symbol);
    }
  } catch (error) {
    console.error('Stop loss check failed:', error);
    if (error?.body?.code) {
      sendMessage(
        `손절 및 수익 실현 체크 중 오류가 발생했습니다. 
${error.body.code}, 
${error.body.msg}`
      );
    } else {
      sendMessage(
        `손절 및 수익 실현 체크 중 오류가 발생했습니다. 
${JSON.stringify(error)}`
      );
    }
  }
};

// 현재 지표 데이터 전송
const sendTradeData = async (symbol = 'BTCUSDT', interval = '15m') => {
  try {
    const {
      usdtBalance,
      baseBalance,
      lastRSI,
      lastClose,
      lastBB,
      currentPrice,
      quantity,
    } = await getTradeData(symbol, interval);

    sendMessage(
      `현재 상태
USDT: ${usdtBalance},
BTC: ${baseBalance},
RSI: ${lastRSI},
Close: ${lastClose},
BB.lower: ${lastBB.lower},
BB.upper: ${lastBB.upper},
Price: ${currentPrice},
Quantity: ${quantity}`
    );
  } catch (error) {
    console.error('Send trade data failed:', error);
  }
};

//트레이딩 시작
async function startTrade(symbol = 'BTCUSDT', interval = '15m') {
  try {
    if (intervalHandler !== null) {
      clearInterval(intervalHandler);
      intervalHandler = null;
      console.log('실행중인 트레이딩을 종료합니다.');
    }

    trade(symbol, interval);

    // 15초마다 trade 함수 실행
    intervalHandler = setInterval(() => trade(symbol, interval), 15 * 1000);
    console.log('트레이딩을 실행합니다.');
  } catch (error) {
    console.error('Trade execution start failed:', error);
  }
}

//트레이딩 종료
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

//현재 계좌 상태 전송
const getBalance = async (symbol = 'BTCUSDT') => {
  try {
    const baseSysmbol = symbol.replace('USDT', '');
    const accountInfo = await binance.account();
    const usdtBalance = accountInfo.balances.find(
      (asset) => asset.asset === 'USDT'
    ).free;
    const baseBalance = accountInfo.balances.find(
      (asset) => asset.asset === baseSysmbol
    ).free;

    const btcTOusdt = await binance.futuresPrices(symbol);
    const totalUSDTBalance =
      parseFloat(usdtBalance) + parseFloat(baseBalance * btcTOusdt.BTCUSDT);

    console.log(`USDT: ${usdtBalance}, BTC: ${baseBalance}`);
    sendMessage(`USDT: ${totalUSDTBalance.toFixed(2)}`);

    //현재 투자된 손해, 수익 계산
    if (position === 'buy') {
      const currentPrices = await binance.prices();
      const currentPrice = parseFloat(currentPrices[symbol]);

      sendMessage(
        `${currentPrice <= buyPrice ? '손해' : '수익'} 
USDT ${((currentPrice - buyPrice) * baseBalance).toFixed(2)}, 
${currentPrice <= buyPrice ? '손실률' : '수익률'}
${(((currentPrice - buyPrice) / buyPrice) * 100).toFixed(2)}%`
      );
    }
  } catch (error) {
    console.error('Balance check failed:', error);
  }
};

exports.binance = {
  startTrade,
  endTrade,
  setTelegramBot,
  getBalance,
  sendTradeData,
};
