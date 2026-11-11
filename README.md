# Stock IQ

Small, fast app for **intraday shares (Nifty 100)** with **Upstox**. It watches prices, finds patterns, and buys/sells automatically.
**Paper money is the default. Real money is locked** until you open the lock yourself.

This is **step 1** of the plan (base app + paper trading). Built from the project handoff notes.

## What works now
- **Trade screen (TradingView style)**: watchlist of the chosen list (sort A–Z / gainers / losers) with a search box for **any** share, a candle chart (1m, 5m, 15m, 1h, Daily) with EMA 9, EMA 21, VWAP and volume you can switch on and off, your buy / stop / target lines on the chart, an order ticket, and Positions / Waiting orders / Today / Log tabs. Works on phone and laptop.
- **Manual buy and sell of any share** next to auto trading: market or limit buy, stop-loss (default 1%), optional target, one tap Sell. Paper by default; real orders only after the real-money lock is opened. Manual trades obey the same free-cash check, daily loss cap, kill-all and 15:15 square-off.
- **Intraday short selling** (off by default, paper mode only): switch it on in Settings. Then the order ticket gets a **Short** button (sell first, buy back later, market order, stop above and target below) and the auto trader also takes bearish entries: opening range breakdown, VWAP/EMA rejection, tight range breakdown, EMA 9/21 cross down and momentum breakdown. A short has its own profit ladder (the stop comes down as price falls), the same quality checks mirrored (below VWAP, EMA9 under EMA21, RSI 24 to 50, not chasing the fall, market not strong), a news check that skips shorts on good news, and a Cover button. Real-money shorts are blocked until they are tried with real Upstox orders.
- Pick the share list in the app: **Large (Nifty 100), Mid (Midcap 100) or Small (Smallcap 100)**. Always one list of 100 at a time, saved across restarts. Switching needs no open positions and stops auto trading. Mid and small caps swing more, so start with paper.
- Live prices for the chosen 100 shares, updated every second (one Upstox quote call for all 100).
- Top gainers / losers table.
- Candle chart (1 minute and daily) for any share.
- Auto trader (paper): two patterns to start
  - **Opening range breakout** (break of the first 15-minute high with extra volume)
  - **EMA 9/21 cross up** above the day open
  - **VWAP / EMA pullback bounce**: share is up and trending (EMA9 above EMA21), dips to VWAP or EMA21, then a green candle closes back above EMA9. Tight stop under the dip.
  - **Tight range breakout**: 12 quiet minutes (under 0.5% range), then a close above the range on 1.5x volume, above VWAP.
  - **Momentum breakout**: share up 2%+ today, fresh 1-minute break of the last 20 candles' high, volume 2x average (made for mid/small caps that run 5-10%)
- **Entry quality gate** (Settings, on by default): short-term uptrend (EMA9 above EMA21), RSI between 50 and 76, price above VWAP but not more than 1.2% above it, no entries in the first 10 minutes or after 2:30 PM, and no entries on a day when most of the list is falling. The Picks tab uses the same checks.
- **Profit target and stop loss per list** (Settings, each of Large / Mid / Small): starting values are target 1% / widest stop 0.6% for Large, 1.5% / 0.9% for Mid, 2.5% / 1.5% for Small. Every auto entry gets that target (minimum 0.75%). A trade is skipped when its natural stop is wider than the list's limit, or when the target is less than 1.5x the stop (the reward-to-risk setting). Change them any time; switching the share list applies that list's values.
- Size of each entry comes from the **real Upstox MIS margin** (margin API) when logged in, and from your risk per trade.
- Stop loss capped so a loss **including all charges** never goes past `RISK_PER_TRADE`.
- Percent ladder: stop moves to break-even (incl. charges), then locks profit step by step. It never moves down.
- 1-minute entry check: skips shares that already moved more than the day-move limit (3% Large, 6% Mid, 12% Small; change in `.env`); one entry per share per day.
- **Daily loss cap** (counts open losses too): sells everything and stops for the day. The **KILL ALL** button sells everything (buys back shorts) and stops auto trading, but does not lock the day: press Start again whenever you like.
- Auto square-off at `SQUARE_OFF_TIME` (15:15 IST).
- **Settings page** in the app: per share list (Large / Mid / Small) the day-move limit, risk per trade, max open positions, profit target and widest stop, plus daily loss cap. Saved in the database; `.env` values are only the first defaults.
- **Picks tab**: today's ideas from the chosen list (pattern fired now, or a big mover to watch) with a Buy idea / Watch / Avoid label, the reason, and news headlines (Google News, free, no key). The auto trader uses the same checks.
- **Safety filters** (switch on/off in Settings): buy only above today's VWAP; skip shares with bad news or results / board meeting in the last 2 days. If the news service is down, trading carries on.
- **Paper fills at the market price**: a paper buy or sell fills at the last traded price, like a normal broker, with no made-up slippage. Open profit and loss is shown before charges (as brokers do); charges are taken off when the trade closes.
- Daily report: every trade with *why it bought* and *why it sold*, plus charges.
- Paper / real switch and start / stop button. After a restart trading is always **stopped**.
- Phone-installable web app (PWA).

## Best trades now (the Best tab, off by default)
Switch it on in Settings, under "Best trades scanner". Real prices only; when the evidence is weak it says **NO TRADE**.
- **Pre-market list**: before 09:15 the shares are ranked by gap %, the indicated price, yesterday's volume, news today and distance to yesterday's high/low. The top 10 (your setting) become the day's watchlist and are fixed once the market opens.
- **Live scan** (09:20 to 14:30 by default, every minute): each watchlist share is scored out of 100 - trend 30 (VWAP, EMA 9/21, 15-minute trend), volume surge 20, breakout 20 (opening range high, yesterday's high), momentum 15 (RSI, MACD), strength against the market 15. Only 70 or more is shown.
- **Trade plan card**: entry zone, stop-loss (recent low, or 1 to 1.5 times the 5-minute ATR), target 1 at 1R, target 2 at 2R, reward-to-risk, quantity from your risk amount with charges included, the reasons, and "invalid if" conditions. A button buys it in one tap with the stop and target 2.
- **Exit help** (own switch): move the stop to cost and sell half at 1R, trail the rest, and warnings for a VWAP break, volume drying up, a reversal candle, and a square-off warning. It is advice only and places no orders.
- **Blocks**: choppy (flat) market, the first minutes after the open, shares near bad news or results, after your daily loss cap, and no averaging down. Each is a switch.
- **Learns from you**: every pick shown is saved. Your own paper trades from the plan button are matched to them, and results are shown by setup and by time of day. With "Learn from my results" on, a setup that keeps losing is turned off.
- Every limit and time is a setting. The scanner is **long only** (shorts are handled by the trader and the order ticket, not the scanner) and the market reading uses the share list as a stand-in for Nifty.

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

Development: `npm run dev:server` and `npm run dev:client` (Vite on port 5180, proxies `/api`).

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
