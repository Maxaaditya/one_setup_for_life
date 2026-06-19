# ◈ ONE LIFE BOT v4.0 — Groq Edition
## Complete Setup Guide (Free AI — No Paid Key Needed)

---

## FILES IN THIS FOLDER
```
onelife-groq/
├── src/
│   ├── App.js         ← Full bot (Groq AI wired in)
│   └── index.js       ← React entry point
├── public/
│   └── index.html     ← HTML shell
├── mt5_bridge.py      ← MetaTrader 5 connector (Python)
├── .env.example       ← Rename to .env and add your keys
├── .gitignore         ← Protects your keys from GitHub
├── package.json       ← Node dependencies
└── SETUP.md           ← This file
```

---

## WHY GROQ?
- ✅ Completely FREE (14,400 requests/day)
- ✅ Faster than Anthropic or OpenAI
- ✅ Uses Llama 3.1 70B — excellent for strategy analysis
- ✅ No credit card required

---

## STEP 1 — GET YOUR FREE GROQ API KEY

1. Go to **https://console.groq.com**
2. Click **"Sign Up"** — use Google or GitHub to sign in
3. Click **"API Keys"** in the left sidebar
4. Click **"Create API Key"**
5. Give it a name like "onelife-bot"
6. Copy the key — it starts with **`gsk_`**

---

## STEP 2 — INSTALL NODE.JS

1. Go to **https://nodejs.org**
2. Download the **LTS** version (big green button)
3. Run the installer → Next → Next → Install → Finish
4. Verify in Command Prompt:
   ```
   node --version
   ```
   Should show something like `v20.11.0`

---

## STEP 3 — SET UP YOUR .env FILE

1. In the `onelife-groq` folder, find `.env.example`
2. Make a copy of it
3. Rename the copy to just `.env` (delete the `.example` part)
4. Open `.env` with Notepad
5. Fill in your keys:

```
REACT_APP_GROQ_KEY=gsk_paste-your-groq-key-here
REACT_APP_POLYGON_KEY=paste-polygon-key-here
REACT_APP_TG_TOKEN=paste-telegram-token-here
REACT_APP_TG_CHAT=paste-your-chat-id-here
```

6. Save the file

> Only the GROQ key is required for the bot to work.
> Polygon = live NAS100 data (optional, has free tier)
> Telegram = phone alerts (optional, completely free)

---

## STEP 4 — GET POLYGON KEY (OPTIONAL — for live data)

1. Go to **https://polygon.io**
2. Click **"Get API Key"** → sign up free
3. Go to Dashboard → API Keys → copy your key
4. Paste it in `.env` as `REACT_APP_POLYGON_KEY`

Free tier gives you 5 API calls/min with 15-min delay.

---

## STEP 5 — SET UP TELEGRAM ALERTS (OPTIONAL)

**Create your bot:**
1. Open Telegram → search **@BotFather** → Start
2. Send: `/newbot`
3. Give it a name, e.g. "One Life Signals"
4. Give it a username, e.g. "onelife_signals_bot"
5. Copy the **token** it gives you

**Get your Chat ID:**
1. Search **@userinfobot** on Telegram → Start
2. It replies instantly with your Chat ID
3. Copy the number (may be negative for groups)

Paste both into `.env`

---

## STEP 6 — INSTALL AND RUN

Open **Command Prompt** (Windows) or **Terminal** (Mac):

```bash
# Go to the folder
cd Desktop\onelife-groq

# Install dependencies (only needed once)
npm install

# Start the bot
npm start
```

Your browser opens automatically at **http://localhost:3000** ✅

---

## STEP 7 — USING THE BOT

### First thing to do
1. Click **🧬 Run Gen** — evaluates all 20 organisms
2. Groq AI analyzes results and recommends mutations
3. Click **Run Gen** again → strategy improves
4. Repeat 5–10 times to see real evolution

### Auto mode
Toggle **Auto-evolve** ON → it runs generations automatically without you clicking

### Live candles
Click **▶ Live** → streams new price action, runs champion strategy in real time

### Check results in tabs:
- **🎯 Kill Zones** — which macro windows make money
- **🕐 Sessions** — London vs NY performance
- **📋 Journal** — every trade with full detail
- **🎲 Monte Carlo** — stress test your strategy
- **💰 Risk** — position size calculator

---

## STEP 8 — CONNECT MT5 (OPTIONAL)

⚠️ Demo account ONLY until strategy is proven profitable

**Install Python + packages:**
```bash
# Install Python from python.org first, then:
pip install MetaTrader5 flask flask-cors
```

**Configure MT5:**
1. Open MetaTrader 5
2. Tools → Options → Expert Advisors → ✅ Allow algorithmic trading
3. Make sure you're on a DEMO account

**Edit `mt5_bridge.py` line 28:**
```python
DEFAULT_SYMBOL = "NAS100"  # your broker's exact symbol name
```

**Run the bridge** (while MT5 is open):
```bash
python mt5_bridge.py
```

Should say: `✅ MT5 connected. Bridge at http://localhost:5000`

---

## STEP 9 — DEPLOY TO PHONE (OPTIONAL)

Access your bot from anywhere without your laptop on:

```bash
# Install Vercel (one time)
npm install -g vercel

# Deploy (from your project folder)
vercel
```

Follow prompts → get a URL like `https://onelife-groq.vercel.app`

Add your env variables in Vercel Dashboard → Project → Settings → Environment Variables

---

## TROUBLESHOOTING

| Problem | Fix |
|---------|-----|
| `npm not found` | Reinstall Node.js, check "Add to PATH" |
| `npm install` fails | Delete `node_modules` folder and try again |
| AI advice not working | Check GROQ_KEY in `.env`, restart `npm start` |
| White screen | Press F12 → Console → read the red error |
| Port 3000 busy | Type Y when it asks to use port 3001 |
| Groq rate limit | Free tier = 14,400 req/day, you won't hit this normally |
| MT5 symbol not found | Check exact name in MT5 Market Watch |
| Telegram not working | Make sure you messaged your bot first |

---

## GROQ RATE LIMITS (FREE TIER)

| Model | Requests/min | Tokens/min | Requests/day |
|-------|-------------|------------|--------------|
| llama-3.1-70b | 30 | 131,072 | 14,400 |

The bot uses ~1 Groq call per generation. You'd need to run 14,400 generations in a day to hit the limit — not possible.

---

## SECURITY

- ✅ Never share your `.env` file
- ✅ `.gitignore` prevents it being uploaded to GitHub
- ✅ Always use DEMO account for at least 2 weeks
- ✅ Start with 0.01 lots minimum
- ✅ Risk max 1% per trade
- ✅ Kill switch auto-stops after 5 consecutive losses

---

⚠️ DISCLAIMER: Educational purposes only. Not financial advice.
Always use a demo account first. Past results don't guarantee future performance.
