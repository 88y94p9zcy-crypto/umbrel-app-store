const express = require('express');
const fs = require('fs');
const path = require('path');
const { Spot } = require('@binance/connector');
const { execSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const CONFIG_PATH = path.join(__dirname, 'data', 'config.json');
const LOG_PATH = path.join(__dirname, 'data', 'trades.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── API routes ───────────────────────────────────────────────────────────────

app.get('/api/config', (req, res) => {
  if (!fs.existsSync(CONFIG_PATH)) return res.json(null);
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  // Mask secrets for frontend
  if (cfg.binance?.apiSecret) cfg.binance.apiSecret = '••••••••';
  res.json(cfg);
});

app.post('/api/config', (req, res) => {
  const newCfg = req.body;
  let existing = {};
  if (fs.existsSync(CONFIG_PATH)) {
    existing = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  }
  // Don't overwrite secret if masked
  if (newCfg.binance?.apiSecret === '••••••••') {
    newCfg.binance.apiSecret = existing.binance?.apiSecret || '';
  }
  if (!fs.existsSync(path.dirname(CONFIG_PATH))) {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(newCfg, null, 2));
  res.json({ ok: true });
});

app.get('/api/trades', (req, res) => {
  if (!fs.existsSync(LOG_PATH)) return res.json([]);
  res.json(JSON.parse(fs.readFileSync(LOG_PATH, 'utf8')));
});

app.post('/api/test-connection', async (req, res) => {
  const { apiKey, apiSecret } = req.body;
  if (!apiKey || !apiSecret) return res.status(400).json({ error: 'Missing keys' });
  try {
    const client = new Spot(apiKey, apiSecret);
    const price = await client.tickerPrice('BTCUSDT');
    res.json({ ok: true, price: parseFloat(price.data.price) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/price', async (req, res) => {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const client = new Spot(cfg.binance.apiKey, cfg.binance.apiSecret);
    const [priceRes, changeRes] = await Promise.all([
      client.tickerPrice('BTCUSDT'),
      client.ticker24hr('BTCUSDT'),
    ]);
    res.json({
      price: parseFloat(priceRes.data.price),
      change24h: parseFloat(changeRes.data.priceChangePercent),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/stats', (req, res) => {
  if (!fs.existsSync(LOG_PATH)) return res.json({ totalBtc: 0, totalUsdt: 0, avgPrice: 0, count: 0 });
  const trades = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'));
  const totalBtc = trades.reduce((s, t) => s + t.btc, 0);
  const totalUsdt = trades.reduce((s, t) => s + t.usdt, 0);
  const avgPrice = totalUsdt / totalBtc || 0;
  res.json({ totalBtc, totalUsdt, avgPrice, count: trades.length });
});

app.listen(PORT, () => console.log(`UI server running on http://localhost:${PORT}`));
