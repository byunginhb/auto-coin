const sqlite = require('sqlite');
const sqlite3 = require('sqlite3');

let db = null;

// 데이터베이스 연결 함수
const connectToDatabase = async () => {
  db = await sqlite.open({
    filename: 'auto-coin.db',
    driver: sqlite3.Database,
  });
};

// 테이블 생성 함수 (IF NOT EXISTS 포함)
const createTable = async () => {
  await db.exec(
    'CREATE TABLE IF NOT EXISTS coin (id INTEGER PRIMARY KEY, stopLossPrice NUMERIC, takeProfitPrice NUMERIC)'
  );
};

// 데이터 삽입/수정 함수
const upsertCoinData = async (stopLossPrice, takeProfitPrice) => {
  await db.run(
    'INSERT INTO coin (id, stopLossPrice, takeProfitPrice) VALUES (1, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET stopLossPrice = excluded.stopLossPrice, takeProfitPrice = excluded.takeProfitPrice',
    [stopLossPrice, takeProfitPrice]
  );
};

// 데이터 조회 함수
const getCurrentCoin = async () => {
  const row = await db.get(
    'SELECT stopLossPrice, takeProfitPrice FROM coin WHERE id = 1'
  );
  if (row) {
    return {
      stopLossPrice: row.stopLossPrice,
      takeProfitPrice: row.takeProfitPrice,
    };
  } else {
    return null; // 데이터가 없을 경우 null 반환
  }
};

// 메인 함수
const setup = async () => {
  await connectToDatabase();

  await createTable();

  const coinData = await getCurrentCoin();
  if (coinData) {
    console.log(
      `Stop Loss Price: ${coinData.stopLossPrice}, Take Profit Price: ${coinData.takeProfitPrice}`
    );
  } else {
    console.log('No data found.');
  }
};

const close = async () => {
  await db.close();
};

exports.coinDB = {
  setup,
  getCurrentCoin,
  upsertCoinData,
  close,
};
