# auto-coin

바이낸스 API를 이용한 자동매매 프로그램

Auto trading program using Binance API

## 사용 방법 (Usage)

### .env 생성 (Create .env)

```
PORT=3000
BINANCE_API_KEY={{YOUR_BINANCE_API_KEY}}
BINANCE_API_SECRET={{YOUR_BINANCE_API_SECRET}}
TELEGRAM_BOT_TOKEN={{YOUR_TELEGRAM_BOT_TOKEN}}
TELEGRAM_BOT_CHAT_ID={{YOUR_TELEGRAM_BOT_CHAT_ID}}
TELEGRAM_FUTURE_BOT_TOKEN={{YOUR_TELEGRAM_BOT_TOKEN_FOR_FUTURE}}
TELEGRAM_FUTURE_BOT_CHAT_ID={{YOUR_TELEGRAM_BOT_CHAT_ID_FOR_FUTURE}}
```

### 실행

```bash
npm install
npm start
```

### pm2로 실행 (Run with pm2)

```bash
npm install -g pm2
cd auto-coin
pm2 start index.js
```
