const { Spot } = require('@binance/connector');
const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'data', 'config.json');
const LOG_PATH = path.join(__dirname, 'data', 'trades.json');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function loadTrades() {
  if (!fs.existsSync(LOG_PATH)) return [];
  return JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'));
}

function saveTrade(trade) {
  const trades = loadTrades();
  trades.unshift(trade);
  fs.writeFileSync(LOG_PATH, JSON.stringify(trades.slice(0, 500), null, 2));
}

function sendTelegram(bot, chatId, message) {
  if (!bot || !chatId) return;
  bot.sendMessage(chatId, message, { parse_mode: 'Markdown' }).catch(err =>
    console.error('Telegram error:', err.message)
  );
}

async function getBTCPrice(client) {
  const cfg = loadConfig();
  const symbol = cfg?.symbol || 'BTCUSDC';
  const res = await client.tickerPrice(symbol);
  return parseFloat(res.data.price);
}

async function get24hChange(client) {
  const cfg = loadConfig();
  const symbol = cfg?.symbol || 'BTCUSDC';
  const res = await client.ticker24hr(symbol);
  return parseFloat(res.data.priceChangePercent);
}

async function buyBTC(client, usdtAmount, reason) {
  const cfg = loadConfig();
  const symbol = cfg?.symbol || 'BTCUSDC';
  const order = await client.newOrder(symbol, 'BUY', 'MARKET', {
    quoteOrderQty: usdtAmount.toFixed(2),
  });
  const filled = order.data;
  const btcBought = parseFloat(filled.executedQty);
  const avgPrice = parseFloat(filled.cummulativeQuoteQty) / btcBought;
  const trade = {
    id: filled.orderId,
    date: new Date().toISOString(),
    type: reason,
    usdt: usdtAmount,
    btc: btcBought,
    price: avgPrice,
  };
  saveTrade(trade);
  return trade;
}

function scheduleDCA(client, bot, config) {
  const cronMap = {
    daily:    '0 9 * * *',
    weekly:   '0 9 * * 1',
    biweekly: '0 9 1,15 * *',
    monthly:  '0 9 1 * *',
  };
  const cronExpr = cronMap[config.dca.dcaInterval] || cronMap.weekly;
  cron.schedule(cronExpr, async () => {
    const cfg = loadConfig();
    if (!cfg?.dca?.enabled) return;
    try {
      const trade = await buyBTC(client, cfg.dca.dcaAmount, 'DCA');
      sendTelegram(bot, cfg.telegram?.chatId,
        `✅ *DCA nákup proveden*\n💵 Utraceno: \`${trade.usdt} USDT\`\n₿ Nakoupeno: \`${trade.btc.toFixed(8)} BTC\`\n📈 Cena: \`$${trade.price.toLocaleString('en-US', { maximumFractionDigits: 0 })}\``
      );
    } catch (err) {
      const cfg2 = loadConfig();
      sendTelegram(bot, cfg2?.telegram?.chatId, `❌ *DCA nákup selhal*\n\`${err.message}\``);
    }
  });
  console.log(`[DCA] Scheduled: ${config.dca.dcaInterval} (cron: ${cronExpr})`);
}

let dipBuysThisMonth = 0;
let dipLastMonth = new Date().getMonth();

async function checkDip(client, bot, config) {
  const now = new Date();
  if (now.getMonth() !== dipLastMonth) { dipBuysThisMonth = 0; dipLastMonth = now.getMonth(); }
  const change = await get24hChange(client);
  console.log(`[DIP] 24h change: ${change.toFixed(2)}%`);
  const maxPerMonth = config.dip?.dip1?.maxPerMonth || 3;
  for (const key of ['dip4', 'dip3', 'dip2', 'dip1']) {
    const dip = config.dip?.[key];
    if (!dip?.enabled) continue;
    if (change <= -Math.abs(dip.percent) && dipBuysThisMonth < maxPerMonth) {
      try {
        const trade = await buyBTC(client, dip.amount, `DIP-${key.toUpperCase()} ${change.toFixed(1)}%`);
        dipBuysThisMonth++;
        const emoji = key === 'dip3' ? '🔥🔥' : key === 'dip2' ? '🔥' : '⚡';
        sendTelegram(bot, config.telegram?.chatId,
          `${emoji} *DIP nákup ${key.toUpperCase()}*\n📉 Pokles: \`${change.toFixed(2)}%\`\n💵 Utraceno: \`${trade.usdt} USDT\`\n₿ Nakoupeno: \`${trade.btc.toFixed(8)} BTC\`\n📈 Cena: \`$${trade.price.toLocaleString('en-US', { maximumFractionDigits: 0 })}\`\n🔢 Dip nákupy tento měsíc: ${dipBuysThisMonth}/${maxPerMonth}`
        );
      } catch (err) {
        sendTelegram(bot, config.telegram?.chatId, `❌ *DIP nákup selhal*\n\`${err.message}\``);
      }
      return;
    }
  }
}

// ─── Balance watcher ─────────────────────────────────────────────────────────

let lastBalanceAlert = null; // 'warning' | 'critical' | null

async function checkBalance(client, bot, config) {
  try {
    const cfg = loadConfig();
    const quote = (cfg?.symbol || 'BTCUSDC').replace('BTC', '');
    const res = await client.account();
    const balances = res.data.balances;
    const asset = balances.find(b => b.asset === quote);
    const free = asset ? parseFloat(asset.free) : 0;

    console.log(`[BALANCE] ${quote} zůstatek: $${free.toFixed(2)}`);

    if (free < 50 && lastBalanceAlert !== 'critical') {
      lastBalanceAlert = 'critical';
      sendTelegram(bot, config.telegram?.chatId,
        `🚨 *URGENTNÍ — Kriticky nízký zůstatek!*\n\n` +
        `💸 Zbývá pouze: \`$${free.toFixed(2)} ${quote}\`\n\n` +
        `Bot nemůže nakupovat. Ihned doplň prostředky na Binance účet!`
      );
    } else if (free < 100 && free >= 50 && lastBalanceAlert !== 'warning') {
      lastBalanceAlert = 'warning';
      sendTelegram(bot, config.telegram?.chatId,
        `⚠️ *Nízký zůstatek*\n\n` +
        `💵 Zbývá: \`$${free.toFixed(2)} ${quote}\`\n\n` +
        `Doporučujeme doplnit prostředky na Binance účet.`
      );
    } else if (free >= 100) {
      lastBalanceAlert = null; // reset po doplnění
    }

    return free;
  } catch (err) {
    console.error('[BALANCE] Chyba:', err.message);
    return null;
  }
}

function setupTelegramCommands(bot, client, chatId) {
  bot.setMyCommands([
    { command: 'stav',     description: 'Aktuální cena BTC a stav portfolia' },
    { command: 'koupit',   description: 'Ručně nakoupit — /koupit 50' },
    { command: 'historie', description: 'Posledních 5 nákupů' },
    { command: 'help',     description: 'Seznam příkazů' },
  ]);

  bot.on('message', async (msg) => {
    if (String(msg.chat.id) !== String(chatId)) return;
    const text = msg.text || '';

    if (text.startsWith('/stav')) {
      try {
        const price = await getBTCPrice(client);
        const change = await get24hChange(client);
        const cfg = loadConfig();
        const trades = loadTrades();
        const totalBtc = trades.reduce((s, t) => s + t.btc, 0);
        const totalUsdt = trades.reduce((s, t) => s + t.usdt, 0);
        const avgPrice = totalUsdt / totalBtc || 0;
        sendTelegram(bot, chatId,
          `📊 *Stav bota*\n\n` +
          `₿ BTC cena: \`$${price.toLocaleString('en-US', { maximumFractionDigits: 0 })}\`\n` +
          `${change >= 0 ? '▲' : '▼'} 24h změna: \`${change.toFixed(2)}%\`\n\n` +
          `💼 Nakoupeno celkem: \`${totalBtc.toFixed(8)} BTC\`\n` +
          `💵 Investováno: \`$${totalUsdt.toFixed(2)}\`\n` +
          `📊 Průměrná cena: \`$${avgPrice.toLocaleString('en-US', { maximumFractionDigits: 0 })}\`\n\n` +
          `DCA: ${cfg?.dca?.enabled ? '✅' : '❌'} | Dip: ${cfg?.dip?.dip1?.enabled ? '✅' : '❌'}`
        );
      } catch (err) { sendTelegram(bot, chatId, `❌ Chyba: ${err.message}`); }
    }

    else if (text.startsWith('/koupit')) {
      const amount = parseFloat(text.split(' ')[1]);
      if (!amount || amount < 10) {
        sendTelegram(bot, chatId, `⚠️ Zadej částku v USDT, min. 10\nPříklad: \`/koupit 50\``);
        return;
      }
      sendTelegram(bot, chatId, `⏳ Nakupuji BTC za ${amount} USDT...`);
      try {
        const trade = await buyBTC(client, amount, 'MANUÁLNÍ');
        sendTelegram(bot, chatId,
          `✅ *Manuální nákup proveden*\n💵 Utraceno: \`${trade.usdt} USDT\`\n₿ Nakoupeno: \`${trade.btc.toFixed(8)} BTC\`\n📈 Cena: \`$${trade.price.toLocaleString('en-US', { maximumFractionDigits: 0 })}\``
        );
      } catch (err) { sendTelegram(bot, chatId, `❌ Nákup selhal: ${err.message}`); }
    }

    else if (text.startsWith('/historie')) {
      const trades = loadTrades().slice(0, 5);
      if (!trades.length) { sendTelegram(bot, chatId, 'Zatím žádné nákupy.'); return; }
      const lines = trades.map(t =>
        `• ${new Date(t.date).toLocaleDateString('cs-CZ')} — ${t.type} — ${t.btc.toFixed(8)} BTC @ $${Math.round(t.price).toLocaleString()}`
      );
      sendTelegram(bot, chatId, `📋 *Posledních ${trades.length} nákupů*\n\n` + lines.join('\n'));
    }

    else if (text.startsWith('/zustatek')) {
      try {
        const cfgZ = loadConfig();
        const quoteZ = (cfgZ?.symbol || 'BTCUSDC').replace('BTC', '');
        const resZ = await client.account();
        const usdcB = resZ.data.balances.find(b => b.asset === quoteZ);
        const btcB = resZ.data.balances.find(b => b.asset === 'BTC');
        const freeZ = usdcB ? parseFloat(usdcB.free) : 0;
        const btcFreeZ = btcB ? parseFloat(btcB.free) : 0;
        const priceZ = await getBTCPrice(client);
        const emojiZ = freeZ < 50 ? '🚨' : freeZ < 100 ? '⚠️' : '✅';
        sendTelegram(bot, chatId, emojiZ + ' *Zustatek*\n\n$' + freeZ.toFixed(2) + ' ' + quoteZ + '\n' + btcFreeZ.toFixed(8) + ' BTC (~$' + Math.round(btcFreeZ * priceZ).toLocaleString() + ')');
      } catch (err) { sendTelegram(bot, chatId, 'Chyba: ' + err.message); }
    }

    else if (text.startsWith('/help')) {
      sendTelegram(bot, chatId,
        '🤖 *Prikazy bota*\n\n/stav\n/koupit 50\n/zustatek\n/historie\n/help'
      );
    }
  });

  console.log('[Telegram] Commands registered.');
}

async function start() {
  console.log('=== BTC DCA Bot starting ===');
  const config = loadConfig();
  if (!config) { console.log('No config found. Waiting for setup via UI...'); return; }
  const { apiKey, apiSecret } = config.binance;
  if (!apiKey || !apiSecret) { console.log('Missing Binance API keys.'); return; }

  const client = new Spot(apiKey, apiSecret);
  try {
    const price = await getBTCPrice(client);
    console.log(`Connected to Binance. BTC price: $${price.toLocaleString()}`);
  } catch (err) { console.error('Binance connection failed:', err.message); return; }

  let tgBot = null;
  if (config.telegram?.token) {
    tgBot = new TelegramBot(config.telegram.token, { polling: true });
    setupTelegramCommands(tgBot, client, config.telegram.chatId);
    sendTelegram(tgBot, config.telegram.chatId,
      `🤖 *BTC DCA Bot spuštěn*\nDCA: ${config.dca?.enabled ? '✅' : '❌'} | Dip: ${config.dip?.dip1?.enabled ? '✅' : '❌'}\n\nNapiš /help pro příkazy.`
    );
    console.log('Telegram active.');
  }

  if (config.dca?.enabled) scheduleDCA(client, tgBot, config);

  const dipActive = ['dip1','dip2','dip3','dip4'].some(k => config.dip?.[k]?.enabled);
  if (dipActive) {
    cron.schedule('*/15 * * * *', async () => {
      const cfg = loadConfig();
      await checkDip(client, tgBot, cfg);
    });
    console.log('[DIP] Watcher active.');
  }

  // Balance watcher — check every hour
  cron.schedule('0 * * * *', async () => {
    const cfg = loadConfig();
    await checkBalance(client, tgBot, cfg);
  });
  await checkBalance(client, tgBot, config);
  console.log('[BALANCE] Watcher active.');

  console.log('Bot is running.');
}

start().catch(console.error);

fs.watch(path.dirname(CONFIG_PATH), (event, filename) => {
  if (filename === 'config.json') {
    console.log('Config changed, restarting...');
    process.exit(0);
  }
});
