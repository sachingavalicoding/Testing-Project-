# Stock IQ

Small, fast app for **intraday shares (Nifty 100)** with **Upstox**. It watches prices, finds patterns, and buys/sells automatically.
**Paper money is the default. Real money is locked** until you open the lock yourself.

This is **step 1** of the plan (base app + paper trading). Built from the project handoff notes.

## What works now
- Live prices for all Nifty 100 shares, updated every second (one Upstox quote call for all 100).
- Top gainers / losers table.
- Candle chart (1 minute and daily) for any share.
- Auto trader (paper): two patterns to start
  - **Opening range breakout** (break of the first 15-minute high with extra volume)
  - **EMA 9/21 cross up** above the day open
- Size of each entry comes from the **real Upstox MIS margin** (margin API) when logged in, and from your risk per trade.
- Stop loss capped so a loss **including all charges** never goes past `RISK_PER_TRADE`.
- Percent ladder: stop moves to break-even (incl. charges), then locks profit step by step. It never moves down.
- 1-minute entry check: skips shares that already moved more than `MAX_DAY_MOVE_PCT` today; one entry per share per day.
- **Daily loss cap** (counts open losses too) and a **KILL ALL** button. Both sell everything and stop for the day.
- Auto square-off at `SQUARE_OFF_TIME` (15:15 IST).
- Daily report: every trade with *why it bought* and *why it sold*, plus charges.
- Paper / real switch and start / stop button. After a restart trading is always **stopped**.
- Phone-installable web app (PWA).

## Real money lock (3 locks)
1. `.env` must have `REAL_TRADING_ENABLED=true` (default `false`). While false the server cannot place a real order.
2. You must type `I UNDERSTAND THIS USES REAL MONEY` in the app to switch.
3. You must press Start after switching.

Real orders also need a **fixed IP registered with Upstox** (SEBI/NSE rule), so they will only work from a small cloud server, not from the phone.

## Run it (phone with Termux, or any computer)
Needs **Node 22.13 or newer** (uses Node's built-in SQLite, nothing to compile).

```bash
cp .env.example .env        # fill your brother's Upstox API key/secret
npm install
npm run build               # builds the web app
npm start                   # server + app on http://localhost:8080
```
- With `FEED=mock` you get fake prices: good for trying the app any time.
- With `FEED=upstox`, open the app and tap **Login to Upstox** (once per day; Upstox tokens expire every night).
  In the Upstox developer app, set the redirect URL to the same value as `UPSTOX_REDIRECT_URI`.

Development: `npm run dev:server` and `npm run dev:client` (Vite on port 5173, proxies `/api`).

## Tests
```bash
npm test
```
Covers charges, position size, stops/ladder, auto trader (entries, exits, loss cap, kill-all, real-money lock), gainers/losers, candles, Upstox retry on 429.

## Code map
- `server/src/broker/` Upstox client (paced, retries 429), Upstox broker, paper broker. Same interface, so paper and real use the same code.
- `server/src/market/` price feeds (Upstox / mock), live price + candle store, India time helpers.
- `server/src/trading/` charges, sizing, stops/ladder, patterns, auto trader.
- `server/src/universe/nifty100.ts` the 100 shares. **Check it after each NSE reshuffle (March/September).**
- `client/` React + Vite + Tailwind web app.

## Next steps (from the plan)
- Step 2: broker order reconciliation (real fills), Entries/Limits page, saved share combos, more patterns.
- Step 3: news + news score, swing picks with margin and expected %, combo finder, best pattern per share + Study tab.
