import MetaTrader5 as mt5

mt5.initialize(login=1142752, password="OUe&y6N0", server="VTMarkets-Demo")
symbol = "NAS100."

# Try order without specifying filling mode
tick = mt5.symbol_info_tick(symbol)
print(f"Current price Ask={tick.ask}, Bid={tick.bid}")

req = {
    "action": mt5.TRADE_ACTION_DEAL,
    "symbol": symbol,
    "volume": 0.1,  # Try larger volume
    "type": mt5.ORDER_TYPE_BUY,
    "price": tick.ask,
    "deviation": 20,
    "magic": 20250619,
    "comment": "Test",
    "type_filling": mt5.ORDER_FILLING_IOC  # IOC mode works!
}

print(f"Sending order without filling mode...")
result = mt5.order_send(req)
print(f"Result: {result}")
if result:
    print(f"Retcode: {result.retcode}")
    print(f"Comment: {result.comment}")
    print(f"Order: {result.order}")
else:
    print(f"Last error: {mt5.last_error()}")

mt5.shutdown()
