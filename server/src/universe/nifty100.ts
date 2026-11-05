// Nifty 100 = Nifty 50 + Nifty Next 50 (NSE trading symbols).
// NSE reshuffles this list twice a year (March and September). Check it against
// https://www.niftyindices.com/indices/equity/broad-based-indices/nifty-100 and edit here.
// Upstox instrument keys (NSE_EQ|<ISIN>) are looked up at runtime from the Upstox
// instrument file, so only symbols are kept here.
export const NIFTY_100: readonly string[] = [
  // Nifty 50
  'ADANIENT', 'ADANIPORTS', 'APOLLOHOSP', 'ASIANPAINT', 'AXISBANK', 'BAJAJ-AUTO', 'BAJFINANCE',
  'BAJAJFINSV', 'BEL', 'BHARTIARTL', 'CIPLA', 'COALINDIA', 'DRREDDY', 'EICHERMOT', 'ETERNAL',
  'GRASIM', 'HCLTECH', 'HDFCBANK', 'HDFCLIFE', 'HEROMOTOCO', 'HINDALCO', 'HINDUNILVR', 'ICICIBANK',
  'INDUSINDBK', 'INFY', 'ITC', 'JIOFIN', 'JSWSTEEL', 'KOTAKBANK', 'LT', 'M&M', 'MARUTI', 'NESTLEIND',
  'NTPC', 'ONGC', 'POWERGRID', 'RELIANCE', 'SBILIFE', 'SBIN', 'SHRIRAMFIN', 'SUNPHARMA', 'TATACONSUM',
  'TATAMOTORS', 'TATASTEEL', 'TCS', 'TECHM', 'TITAN', 'TRENT', 'ULTRACEMCO', 'WIPRO',
  // Nifty Next 50
  'ABB', 'ADANIENSOL', 'ADANIGREEN', 'ADANIPOWER', 'AMBUJACEM', 'BAJAJHLDNG', 'BANKBARODA', 'BOSCHLTD',
  'BPCL', 'BRITANNIA', 'CANBK', 'CGPOWER', 'CHOLAFIN', 'DABUR', 'DIVISLAB', 'DLF', 'DMART', 'GAIL',
  'GODREJCP', 'HAVELLS', 'HAL', 'HINDZINC', 'HYUNDAI', 'ICICIGI', 'ICICIPRULI', 'INDHOTEL', 'IOC',
  'IRFC', 'JINDALSTEL', 'JSWENERGY', 'LICI', 'LODHA', 'LTIM', 'NAUKRI', 'PFC', 'PIDILITIND', 'PNB',
  'RECLTD', 'SHREECEM', 'SIEMENS', 'SWIGGY', 'TATAPOWER', 'TORNTPHARM', 'TVSMOTOR', 'UNITDSPR',
  'VBL', 'VEDL', 'ZYDUSLIFE', 'MOTHERSON', 'BAJAJHFL',
];
