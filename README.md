# Stock IQ

Small, fast app for **intraday shares (Nifty 100)** with **Upstox**. It watches prices, finds patterns, and buys/sells automatically.
**Paper money is the default. Real money is locked** until you open the lock yourself.

This is **step 1** of the plan (base app + paper trading). Built from the project handoff notes.

## What works now
- **Trade screen (TradingView style)**: watchlist of the chosen list (sort A–Z / gainers / losers) with a search box for **any** share, a candle chart (1m, 5m, 15m, 1h, Daily) with EMA 9, EMA 21, VWAP and volume you can switch on and off, your buy / stop / target lines on the chart, an order ticket, and Positions / Waiting orders / Today / Log tabs. Works on phone and laptop.
- **Manual buy and sell of any share** next to auto trading: market or limit buy, stop-loss (default 1%), optional target, one tap Sell. Paper by default; real orders only after the real-money lock is opened. Manual trades obey the same free-cash check, daily loss cap, kill-all and 15:15 square-off. Shares only, no short selling.
- Pick the share list in the app: **Large (Nifty 100), Mid (Midcap 100) or Small (Smallcap 100)**. Always one list of 100 at a time, saved across restarts. Switching needs no open positions and stops auto trading. Mid and small caps swing more, so start with paper.
- Live prices for the chosen 100 shares, updated every second (one Upstox quote call for all 100).
- Top gainers / losers table.
- Candle chart (1 minute and daily) for any share.
- Auto trader (paper): two patterns to start
  - **Opening range breakout** (break of the first 15-minute high with extra volume)
  - **EMA 9/21 cross up** above the day open
  - **Momentum breakout**: share up 2%+ today, fresh 1-minute break of the last 20 candles' high, volume 2x average (made for mid/small caps that run 5-10%)
- Size of each entry comes from the **real Upstox MIS margin** (margin API) when logged in, and from your risk per trade.
- Stop loss capped so a loss **including all charges** never goes past `RISK_PER_TRADE`.
- Percent ladder: stop moves to break-even (incl. charges), then locks profit step by step. It never moves down.
- 1-minute entry check: skips shares that already moved more than the day-move limit (3% Large, 6% Mid, 12% Small; change in `.env`); one entry per share per day.
- **Daily loss cap** (counts open losses too) and a **KILL ALL** button. Both sell everything and stop for the day.
- Auto square-off at `SQUARE_OFF_TIME` (15:15 IST).
- **Settings page** in the app: per share list (Large / Mid / Small) the day-move limit, risk per trade, max open positions and paper slippage, plus daily loss cap. Saved in the database; `.env` values are only the first defaults.
- **Picks tab**: today's ideas from the chosen list (pattern fired now, or a big mover to watch) with a Buy idea / Watch / Avoid label, the reason, and news headlines (Google News, free, no key). The auto trader uses the same checks.
- **Safety filters** (switch on/off in Settings): buy only above today's VWAP; skip shares with bad news or results / board meeting in the last 2 days. If the news service is down, trading carries on.
- **Honest paper results**: paper fills slip against you (buy higher, sell lower) by the per-list slippage %.
- Daily report: every trade with *why it bought* and *why it sold*, plus charges.
- Paper / real switch and start / stop button. After a restart trading is always **stopped**.
- Phone-installable web app (PWA).

## Real money lock (3 locks)
1. `.env` must have `REAL_TRADING_ENABLED=true` (default `false`). While false the server cannot place a real order.
2. You must type `I UNDERSTAND THIS USES REAL MONEY` in the app to switch.
3. You must press Start after switching.

Small-cap risk: a share that is up near its daily limit (circuit) can freeze, and then you cannot sell. The day-move limits keep entries away from the extremes. Test Mid and Small on paper first.

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
- `server/src/universe/` the three lists of 100 shares. **Mid and small lists are best-effort: check them against NSE (niftyindices.com) and after each reshuffle (March/September).** Symbols Upstox does not know are skipped and shown in the app.
- `client/` React + Vite + Tailwind web app.

## Next steps (from the plan)
- Step 2: broker order reconciliation (real fills), Entries/Limits page, saved share combos, more patterns.
- Step 3: news + news score, swing picks with margin and expected %, combo finder, best pattern per share + Study tab.
