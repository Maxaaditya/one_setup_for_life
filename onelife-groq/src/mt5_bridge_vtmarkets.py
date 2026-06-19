"""
ONE LIFE BOT v4.0 — MT5 Bridge (VT Markets Edition)
=====================================================
Pre-configured for VT Markets MetaTrader 5.

SETUP:
  1. pip install MetaTrader5 flask flask-cors
  2. Open MetaTrader 5 and log into your account
  3. Fill in YOUR_ACCOUNT_NUMBER, YOUR_PASSWORD, YOUR_SERVER below
  4. Run: python mt5_bridge_vtmarkets.py

FIND YOUR DETAILS IN MT5:
  Account number → top-left corner of MT5
  Server name    → File → Login → server dropdown
  Symbol name    → right-click Market Watch → Symbols → search NAS

ENDPOINTS:
  GET  /ping        — connection health check
  POST /trade       — place a trade
  POST /close_all   — close all bot positions
  GET  /positions   — list open positions
  GET  /history     — recent closed trades
  GET  /symbols     — list available NAS symbols on your account
"""

import MetaTrader5 as mt5
from flask import Flask, request, jsonify
from flask_cors import CORS
import logging
from datetime import datetime, timedelta

# ══════════════════════════════════════════════════════
#  ✏️  FILL THESE IN  —  your VT Markets details
# ══════════════════════════════════════════════════════
ACCOUNT  = 1142752             # ← your VT Markets account number (integer)
PASSWORD = "OUe&y6N0"             # ← your MT5 password
SERVER   = "VTMarkets-Demo"             # ← e.g. "VTMarkets-Live" or "VTMarkets-Demo"

# Symbol — the bot will auto-detect if you leave this blank
# Common VT Markets NAS100 names: "NAS100", "NAS100+", "NASDAQ", "US100"
SYMBOL   = "NAS100"             # ← leave blank to auto-detect, or paste exact name

DEFAULT_LOT  = 0.01       # minimum lot — keep this until strategy is proven
MAGIC        = 20250619   # unique ID for this bot's trades
SLIPPAGE     = 20         # VT Markets can have higher slippage during news

# ══════════════════════════════════════════════════════
#  VT Markets symbol candidates (tried in order)
# ══════════════════════════════════════════════════════
VT_NAS_CANDIDATES = ["NAS100", "NAS100+", "NASDAQ", "US100", "NAS100.cash",
                     "NASUSDm", "USTEC", "NDX", "NAS100m"]

app = Flask(__name__)
CORS(app)
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("VTMarkets-Bridge")

# ══════════════════════════════════════════════════════
#  AUTO-DETECT SYMBOL
# ══════════════════════════════════════════════════════
def detect_symbol():
    """Try all known VT Markets NAS100 symbol names until one works."""
    global SYMBOL
    if SYMBOL:
        return SYMBOL
    log.info("Auto-detecting NAS100 symbol on your VT Markets account...")
    for candidate in VT_NAS_CANDIDATES:
        if mt5.symbol_select(candidate, True):
            info = mt5.symbol_info(candidate)
            if info and info.visible:
                log.info(f"✅ Symbol found: {candidate}")
                SYMBOL = candidate
                return candidate
    log.warning("Could not auto-detect symbol. Check Market Watch manually.")
    return None

# ══════════════════════════════════════════════════════
#  FILLING MODE — VT Markets compatible
# ══════════════════════════════════════════════════════
def get_filling_mode(symbol):
    """Get the correct order filling mode for VT Markets."""
    info = mt5.symbol_info(symbol)
    if not info:
        return mt5.ORDER_FILLING_FOK
    filling = info.filling_mode
    # Try modes in order of VT Markets compatibility
    if filling & mt5.ORDER_FILLING_FOK:
        return mt5.ORDER_FILLING_FOK
    if filling & mt5.ORDER_FILLING_IOC:
        return mt5.ORDER_FILLING_IOC
    return mt5.ORDER_FILLING_RETURN

# ══════════════════════════════════════════════════════
#  CONNECT
# ══════════════════════════════════════════════════════
def connect():
    """Initialize MT5 connection with VT Markets credentials."""
    # If credentials are filled in, use them
    if ACCOUNT and PASSWORD and SERVER:
        log.info(f"Connecting to VT Markets: account={ACCOUNT} server={SERVER}")
        if not mt5.initialize(login=ACCOUNT, password=PASSWORD, server=SERVER):
            log.error(f"MT5 initialize failed: {mt5.last_error()}")
            return False
    else:
        # Try connecting to already-open MT5 terminal
        log.info("Connecting to already-open MT5 terminal...")
        if not mt5.initialize():
            log.error(f"MT5 initialize failed: {mt5.last_error()}")
            log.error("Either fill in ACCOUNT/PASSWORD/SERVER above, or open MT5 and log in manually first.")
            return False

    acc = mt5.account_info()
    if not acc:
        log.error("No account info returned. Is MT5 logged in?")
        return False

    log.info(f"✅ Connected!")
    log.info(f"   Account:  {acc.login} ({acc.name})")
    log.info(f"   Balance:  {acc.balance} {acc.currency}")
    log.info(f"   Server:   {acc.server}")
    log.info(f"   Leverage: 1:{acc.leverage}")
    log.info(f"   Type:     {'DEMO' if 'demo' in acc.server.lower() else 'LIVE'}")

    # Warn if live account
    if 'live' in acc.server.lower() or 'real' in acc.server.lower():
        log.warning("⚠️  LIVE ACCOUNT DETECTED — make sure you know what you're doing!")

    # Auto-detect symbol
    sym = detect_symbol()
    if sym:
        tick = mt5.symbol_info_tick(sym)
        if tick:
            log.info(f"   Symbol:   {sym} | Ask: {tick.ask} | Bid: {tick.bid}")
    return True

# ══════════════════════════════════════════════════════
#  HELPERS
# ══════════════════════════════════════════════════════
def get_price(symbol, order_type):
    tick = mt5.symbol_info_tick(symbol)
    if not tick:
        return None
    return tick.ask if order_type == mt5.ORDER_TYPE_BUY else tick.bid

def norm(symbol, price):
    info = mt5.symbol_info(symbol)
    return round(price, info.digits) if info else round(price, 2)

def resolve_symbol(requested):
    """Use requested symbol, fall back to auto-detected."""
    s = requested or SYMBOL or detect_symbol()
    if not s:
        return None
    if not mt5.symbol_select(s, True):
        return None
    return s

# ══════════════════════════════════════════════════════
#  ROUTES
# ══════════════════════════════════════════════════════
@app.route("/ping")
def ping():
    if not mt5.terminal_info():
        return jsonify({"status": "disconnected", "error": str(mt5.last_error())}), 503
    acc = mt5.account_info()
    sym = SYMBOL or detect_symbol()
    tick = mt5.symbol_info_tick(sym) if sym else None
    return jsonify({
        "status":        "connected",
        "account":       acc.login if acc else None,
        "name":          acc.name if acc else None,
        "balance":       acc.balance if acc else None,
        "equity":        acc.equity if acc else None,
        "free_margin":   acc.margin_free if acc else None,
        "currency":      acc.currency if acc else None,
        "server":        acc.server if acc else None,
        "leverage":      acc.leverage if acc else None,
        "account_type":  "DEMO" if acc and "demo" in acc.server.lower() else "LIVE",
        "symbol":        sym,
        "ask":           tick.ask if tick else None,
        "bid":           tick.bid if tick else None,
        "spread":        round((tick.ask - tick.bid), 2) if tick else None,
        "time":          datetime.utcnow().isoformat()
    })

@app.route("/symbols")
def symbols():
    """List all NAS-related symbols available on this account."""
    all_symbols = mt5.symbols_get() or []
    nas = [s.name for s in all_symbols if any(k in s.name.upper() for k in ["NAS","NDX","US100","USTEC","NASDAQ"])]
    return jsonify({"nas_symbols": nas, "total_symbols": len(all_symbols)})

@app.route("/trade", methods=["POST"])
def trade():
    d = request.json or {}
    symbol    = resolve_symbol(d.get("symbol", ""))
    direction = d.get("direction", "SELL").upper()
    lot       = float(d.get("lot",  DEFAULT_LOT))
    sl        = float(d.get("sl",   0))
    tp        = float(d.get("tp",   0))
    comment   = d.get("comment",    "OneLife_VTM")

    if not symbol:
        return jsonify({"error": f"Symbol not found. Check Market Watch. Tried: {VT_NAS_CANDIDATES}"}), 400
    if direction not in ("BUY", "SELL"):
        return jsonify({"error": "direction must be BUY or SELL"}), 400

    order_type   = mt5.ORDER_TYPE_SELL if direction == "SELL" else mt5.ORDER_TYPE_BUY
    filling_mode = get_filling_mode(symbol)
    price        = get_price(symbol, order_type)

    if not price:
        return jsonify({"error": f"Could not get price for {symbol}"}), 500

    # Validate SL/TP distances against broker minimum
    info = mt5.symbol_info(symbol)
    min_stop = info.trade_stops_level * info.point if info else 0
    if sl and abs(price - sl) < min_stop:
        return jsonify({"error": f"SL too close. Min distance: {min_stop:.2f}pts"}), 400

    req = {
        "action":       mt5.TRADE_ACTION_DEAL,
        "symbol":       symbol,
        "volume":       lot,
        "type":         order_type,
        "price":        price,
        "sl":           norm(symbol, sl) if sl else 0.0,
        "tp":           norm(symbol, tp) if tp else 0.0,
        "deviation":    SLIPPAGE,
        "magic":        MAGIC,
        "comment":      comment,
        "type_time":    mt5.ORDER_TIME_GTC,
        "type_filling": filling_mode,
    }

    log.info(f"Sending order: {direction} {lot}lot {symbol} @ {price} SL={sl} TP={tp} filling={filling_mode}")
    result = mt5.order_send(req)

    if not result:
        err = mt5.last_error()
        log.error(f"order_send returned None: {err}")
        return jsonify({"error": str(err)}), 500

    if result.retcode != mt5.TRADE_RETCODE_DONE:
        log.error(f"Order rejected: {result.retcode} — {result.comment}")
        # Give helpful hints for common VT Markets error codes
        hints = {
            10006: "Rejected — check if algo trading is enabled in MT5",
            10014: "Invalid volume — check lot size (min 0.01)",
            10015: "Invalid price — market may be closed",
            10016: "Invalid stops — SL/TP too close to price",
            10019: "Not enough money — check account balance",
            10020: "Price changed — try again",
        }
        hint = hints.get(result.retcode, "")
        return jsonify({"error": result.comment, "retcode": result.retcode, "hint": hint}), 400

    log.info(f"✅ Order filled! Ticket={result.order} Price={result.price}")
    return jsonify({
        "success": True,
        "ticket":  result.order,
        "deal":    result.deal,
        "price":   result.price,
        "volume":  result.volume,
        "symbol":  symbol,
    })

@app.route("/close_all", methods=["POST"])
def close_all():
    positions = mt5.positions_get(magic=MAGIC) or []
    if not positions:
        return jsonify({"message": "No open positions to close", "closed": 0})

    closed, errors = 0, []
    for pos in positions:
        close_type   = mt5.ORDER_TYPE_BUY if pos.type == mt5.ORDER_TYPE_SELL else mt5.ORDER_TYPE_SELL
        filling_mode = get_filling_mode(pos.symbol)
        price        = get_price(pos.symbol, close_type)
        req = {
            "action":       mt5.TRADE_ACTION_DEAL,
            "symbol":       pos.symbol,
            "volume":       pos.volume,
            "type":         close_type,
            "position":     pos.ticket,
            "price":        price,
            "deviation":    SLIPPAGE,
            "magic":        MAGIC,
            "comment":      "OneLife_Close",
            "type_time":    mt5.ORDER_TIME_GTC,
            "type_filling": filling_mode,
        }
        r = mt5.order_send(req)
        if r and r.retcode == mt5.TRADE_RETCODE_DONE:
            closed += 1
            log.info(f"Closed #{pos.ticket} profit={pos.profit}")
        else:
            msg = r.comment if r else "no response"
            errors.append(f"#{pos.ticket}: {msg}")
            log.error(f"Failed to close #{pos.ticket}: {msg}")

    return jsonify({"closed": closed, "errors": errors})

@app.route("/positions")
def positions():
    pos = mt5.positions_get(magic=MAGIC) or []
    return jsonify({"positions": [{
        "ticket":  p.ticket,
        "symbol":  p.symbol,
        "type":    "SELL" if p.type == mt5.ORDER_TYPE_SELL else "BUY",
        "volume":  p.volume,
        "price":   p.price_open,
        "current": p.price_current,
        "sl":      p.sl,
        "tp":      p.tp,
        "profit":  p.profit,
        "swap":    p.swap,
        "comment": p.comment,
        "time":    str(datetime.fromtimestamp(p.time)),
    } for p in pos]})

@app.route("/history")
def history():
    from_date = datetime.now() - timedelta(days=30)
    deals = mt5.history_deals_get(from_date, datetime.now()) or []
    my_deals = [d for d in deals if d.magic == MAGIC and d.entry == 1]
    total_profit = sum(d.profit for d in my_deals)
    wins   = [d for d in my_deals if d.profit > 0]
    losses = [d for d in my_deals if d.profit < 0]
    return jsonify({
        "summary": {
            "total_trades": len(my_deals),
            "wins":         len(wins),
            "losses":       len(losses),
            "total_profit": round(total_profit, 2),
            "win_rate":     round(len(wins)/len(my_deals)*100, 1) if my_deals else 0,
        },
        "deals": [{
            "ticket": d.ticket,
            "symbol": d.symbol,
            "type":   "SELL" if d.type == 1 else "BUY",
            "volume": d.volume,
            "price":  d.price,
            "profit": d.profit,
            "time":   str(datetime.fromtimestamp(d.time)),
        } for d in my_deals[-50:]]
    })

# ══════════════════════════════════════════════════════
#  MAIN
# ══════════════════════════════════════════════════════
if __name__ == "__main__":
    print("=" * 60)
    print("  ONE LIFE BOT v4.0 — VT Markets MT5 Bridge")
    print("=" * 60)

    if not ACCOUNT or not PASSWORD or not SERVER:
        print("\n⚠️  Credentials not filled in.")
        print("   Edit this file and set ACCOUNT, PASSWORD, SERVER")
        print("   OR open MT5 manually and log in before running this.\n")

    if not connect():
        print("\n❌ Could not connect to MT5.")
        print("   1. Make sure MetaTrader 5 is installed and open")
        print("   2. Make sure you are logged in")p
        print("   3. Fill in ACCOUNT / PASSWORD / SERVER at top of file\n")
        exit(1)

    print(f"\n✅ Bridge running at http://localhost:5000")
    print(f"   Magic number: {MAGIC}")
    print(f"   Default lot:  {DEFAULT_LOT}")
    print("\n   Endpoints:")
    print("   GET  /ping       — connection status + live price")
    print("   GET  /symbols    — find your exact NAS100 symbol name")
    print("   POST /trade      — place a trade")
    print("   POST /close_all  — close all bot positions")
    print("   GET  /positions  — open positions")
    print("   GET  /history    — last 30 days trade history")
    print("\n⚠️  USE DEMO ACCOUNT UNTIL STRATEGY IS PROVEN PROFITABLE!\n")

    app.run(host="127.0.0.1", port=5000, debug=False)
