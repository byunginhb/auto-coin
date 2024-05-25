const { BollingerBands, RSI } = require('technicalindicators');
const axios = require('axios');

//선물 계좌 정보 가져오기
const getFutureAccountInfo = async (binance) => {
  const accountInfo = await binance.futuresAccount();
  const positions = accountInfo.positions.filter(
    (position) => parseFloat(position.positionAmt) !== 0
  );
  const usdtBalance = accountInfo.assets.find(
    (asset) => asset.asset === 'USDT'
  ).walletBalance;

  return { positions, usdtBalance };
};

// 캔들스틱 데이터 가져오기
const fetchCandlestickData = async (binance, symbol, interval, limit) => {
  try {
    const candles = await binance.futuresCandles(symbol, interval, {
      limit: limit,
    });
    return await calculateIndicators(candles);
  } catch (error) {
    console.error(`Failed to fetch candlestick data for ${symbol}:`, error);
    throw error;
  }
};

// 기술적 지표 계산 (RSI, 볼린저 밴드)
const calculateIndicators = async (candles) => {
  try {
    const closes = candles.map((c) => parseFloat(c[4]));
    const highs = candles.map((c) => parseFloat(c[2]));
    const lows = candles.map((c) => parseFloat(c[3]));
    const rsiValues = RSI.calculate({ period: 14, values: closes });
    const bbValues = BollingerBands.calculate({
      period: 25,
      stdDev: 2,
      values: closes,
    });
    return {
      lastRSI: rsiValues[rsiValues.length - 1],
      lastBB: bbValues[bbValues.length - 1],
      lastClose: closes[closes.length - 1],
      lastHigh: highs[closes.length - 1],
      lastLow: lows[closes.length - 1],
    };
  } catch (error) {
    console.error('Failed to calculate indicators:', error);
    throw error;
  }
};

//현재 계좌를 firestore로 전송
const sendUSDTBalance = async (binance, save = false) => {
  try {
    // 현물 계좌 정보 가져오기
    const spotAccountInfo = await binance.balance();

    // 현물 자산 목록 가져오기
    const spotAssets = Object.keys(spotAccountInfo).filter(
      (asset) => parseFloat(spotAccountInfo[asset].available) > 0
    );

    // 선물 계좌 정보 가져오기
    const futuresAccountInfo = await binance.futuresAccount();
    const futuresAssets = futuresAccountInfo.assets.filter(
      (asset) => parseFloat(asset.walletBalance) > 0
    );

    // USDT로 환산한 현물 자산 가치 계산
    let totalValueInUSDT = 0;
    for (let asset of spotAssets) {
      const amount = parseFloat(spotAccountInfo[asset].available);
      if (asset === 'USDT') {
        totalValueInUSDT += amount;
      } else {
        const ticker = await binance.prices(`${asset}USDT`);
        const priceInUSDT = parseFloat(ticker[`${asset}USDT`]);
        if (priceInUSDT) {
          totalValueInUSDT += amount * priceInUSDT;
        }
      }
    }

    // USDT로 환산한 선물 자산 가치 계산
    for (let asset of futuresAssets) {
      const amount = parseFloat(asset.walletBalance);
      if (asset.asset === 'USDT') {
        totalValueInUSDT += amount;
      } else {
        const ticker = await binance.prices(`${asset.asset}USDT`);
        const priceInUSDT = parseFloat(ticker[`${asset.asset}USDT`]);
        if (priceInUSDT) {
          totalValueInUSDT += amount * priceInUSDT;
        }
      }
    }

    console.log(
      `Total asset value in USDT (Spot + Futures): ${totalValueInUSDT.toFixed(
        2
      )} USDT`
    );

    if (save) {
      const response = await axios.get(
        'https://addautocoindata-z27h2wdzna-uc.a.run.app/',
        {
          params: {
            currentPrice: totalValueInUSDT.toFixed(2),
          },
        }
      );
      console.log('API 호출 성공:', response.data);
    }

    return totalValueInUSDT.toFixed(2);
  } catch (error) {
    console.error('USDT balance check failed:', error);
  }
};

exports.binance_common = {
  getFutureAccountInfo,
  fetchCandlestickData,
  sendUSDTBalance,
};
