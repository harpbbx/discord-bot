const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  PermissionFlagsBits,
  ChannelType,
  Events
} = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// ─────────────────────────────────────────
// DATABASE PERSISTENTE (JSON)
// ─────────────────────────────────────────
const DB_PATH = process.env.DATA_DIR ? `${process.env.DATA_DIR}/database.json` : path.join(__dirname, 'database.json');

function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    const defaultDB = {
      blacklist: [],
      ticketLimits: {},       // userId -> numero max ticket personalizzato
      ticketHistory: {},      // userId -> [{ date: 'YYYY-MM-DD', count: N }]
      payments: [],
      reviews: [],
      counters: { ticketCounter: 0, openTickets: 0, closedToday: 0, allRatings: [], purchasesPerUser: {} },
      dashboardMessageId: null,
      topReviewsMessageId: null,
      blacklistMessageId: null,
      lastDashboardReset: new Date().toDateString()
    };
    fs.writeFileSync(DB_PATH, JSON.stringify(defaultDB, null, 2));
    return defaultDB;
  }
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
  } catch {
    console.error('DB read error, resetting...');
    return loadDB();
  }
}

function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// ─────────────────────────────────────────
// CLIENT
// ─────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

// ─────────────────────────────────────────
// COSTANTI
// ─────────────────────────────────────────
const OWNER_ROLE_NAME = '👑 Owner';
const VERIFIED_BUYER_ROLE_NAME = '✅ Verified Buyer';
const CATEGORY_ID = '1504236815802957824';
const LOGS_CHANNEL_ID = '1504236878885425404';
const DASHBOARD_CHANNEL_ID = '1505284543521882162';
const RATING_VOICE_CHANNEL_ID = '1505285184776568982';
const TOP_REVIEWS_CHANNEL_ID = '1505284352907415622';
const BLACKLIST_CHANNEL_ID = '1505289205478330450';
const RECEIPT_CHANNEL_ID = '1505328728262049852';
const DEFAULT_TICKET_LIMIT = 10; // max ticket per 24h di default

// ─────────────────────────────────────────
// CRYPTO DATA
// ─────────────────────────────────────────
const cryptoData = {
  USDC: {
    emoji: '💵',
    networks: [
      { name: 'Ethereum', address: '0xe3cED10d8057381bd52306158F28ba500ba1F98b', time: '~5 min' },
      { name: 'Base', address: '0xe3cED10d8057381bd52306158F28ba500ba1F98b', time: '~14 sec' },
      { name: 'Solana', address: 'ENvunazAeVLzZbbYJGaCkHan9kxk4ruNKgGVLdNCHKEM', time: '~15 sec' },
    ]
  },
  SOL: {
    emoji: '◎',
    networks: [{ name: 'Solana', address: 'DQX1x5ZveBZdRcHp8q2ieWLfQ2MZUaSPm7YKm7MBqyL9', time: '~15 sec' }]
  },
  BTC: {
    emoji: '₿',
    networks: [
      { name: 'Bitcoin', address: '38hsgY5qWUHh6LbBjLmBwRz98vqjGrgy4Z', time: '~27 min' },
      { name: 'Base', address: '0x788FD69bF6Dbcd5b59Da7C1e78C196e2c50f315d', time: '~14 sec' },
    ]
  },
  ETH: {
    emoji: '⟠',
    networks: [
      { name: 'Ethereum', address: '0x6542b90Da021Ae66f8d16E0639210A4c833f8910', time: '~5 min' },
      { name: 'Base', address: '0x6542b90Da021Ae66f8d16E0639210A4c833f8910', time: '~14 sec' },
    ]
  },
};

// ─────────────────────────────────────────
// STATO GLOBALE (caricato dal DB)
// ─────────────────────────────────────────
const userSessions = new Map();
const paymentTimers = new Map(); // userId -> timeoutId

let db = loadDB();
const blacklist = new Set(db.blacklist || []);
let ticketCounter = db.counters?.ticketCounter || 0;
let openTickets = db.counters?.openTickets || 0;
let closedToday = db.counters?.closedToday || 0;
let allRatings = db.counters?.allRatings || [];
let purchasesPerUser = new Map(Object.entries(db.counters?.purchasesPerUser || {}));
let dashboardMessageId = db.dashboardMessageId || null;
let topReviewsMessageId = db.topReviewsMessageId || null;
let blacklistMessageId = db.blacklistMessageId || null;
let lastDashboardReset = db.lastDashboardReset || new Date().toDateString();

function persistState() {
  db = loadDB();
  db.blacklist = [...blacklist];
  db.counters = {
    ticketCounter,
    openTickets,
    closedToday,
    allRatings,
    purchasesPerUser: Object.fromEntries(purchasesPerUser)
  };
  db.dashboardMessageId = dashboardMessageId;
  db.topReviewsMessageId = topReviewsMessageId;
  db.blacklistMessageId = blacklistMessageId;
  db.lastDashboardReset = lastDashboardReset;
  saveDB(db);
}

// ─────────────────────────────────────────
// ANTI-SPAM: controlla limite ticket
// ─────────────────────────────────────────
function getTicketLimit(userId) {
  const db = loadDB();
  return db.ticketLimits?.[userId] || DEFAULT_TICKET_LIMIT;
}

function setTicketLimit(userId, limit) {
  const db = loadDB();
  if (!db.ticketLimits) db.ticketLimits = {};
  db.ticketLimits[userId] = limit;
  saveDB(db);
}

function getTicketsOpenedToday(userId) {
  const db = loadDB();
  const today = new Date().toISOString().split('T')[0];
  const history = db.ticketHistory?.[userId] || [];
  const todayEntry = history.find(e => e.date === today);
  return todayEntry?.count || 0;
}

function incrementTicketsToday(userId) {
  const db = loadDB();
  const today = new Date().toISOString().split('T')[0];
  if (!db.ticketHistory) db.ticketHistory = {};
  if (!db.ticketHistory[userId]) db.ticketHistory[userId] = [];
  const existing = db.ticketHistory[userId].find(e => e.date === today);
  if (existing) existing.count++;
  else db.ticketHistory[userId].push({ date: today, count: 1 });
  saveDB(db);
}

function savePayment(data) {
  const db = loadDB();
  if (!db.payments) db.payments = [];
  db.payments.push({ ...data, date: new Date().toISOString() });
  saveDB(db);
}

function saveReview(data) {
  const db = loadDB();
  if (!db.reviews) db.reviews = [];
  db.reviews.push({ ...data, date: new Date().toISOString() });
  saveDB(db);
}

// ─────────────────────────────────────────
// TIMER SCADENZA PAGAMENTO (30 min)
// ─────────────────────────────────────────
function startPaymentTimer(guild, userId, channelId, session) {
  if (paymentTimers.has(userId)) clearTimeout(paymentTimers.get(userId));

  const timer = setTimeout(async () => {
    try {
      const channel = guild.channels.cache.get(channelId);
      const currentSession = userSessions.get(userId);

      if (!channel || !currentSession) return;
      if (currentSession.paymentStatus === 'completed') return;

      await channel.send({
        embeds: [
          new EmbedBuilder()
            .setTitle('⏰ Payment Time Expired')
            .setDescription(
              `${`<@${userId}>`} Your payment window of **30 minutes** has expired.\n\n` +
              `The ticket will be automatically closed in **60 seconds**.\n` +
              `If you still want to purchase, please open a new ticket.`
            )
            .setColor(0xED4245)
            .setTimestamp()
        ]
      });

      await new Promise(r => setTimeout(r, 60000));

      const ch = guild.channels.cache.get(channelId);
      if (ch) {
        openTickets = Math.max(0, openTickets - 1);
        closedToday++;
        persistState();
        await ch.delete().catch(() => {});
      }
      userSessions.delete(userId);
      paymentTimers.delete(userId);
    } catch (err) {
      console.error('Payment timer error:', err.message);
    }
  }, 30 * 60 * 1000); // 30 minuti

  paymentTimers.set(userId, timer);
}

function clearPaymentTimer(userId) {
  if (paymentTimers.has(userId)) {
    clearTimeout(paymentTimers.get(userId));
    paymentTimers.delete(userId);
  }
}

// ─────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────
function formatTicketNumber(n) { return String(n).padStart(4, '0'); }

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function getAverageRating() {
  if (allRatings.length === 0) return '—';
  const avg = allRatings.reduce((a, b) => a + b, 0) / allRatings.length;
  return avg.toFixed(1);
}

function checkDailyReset() {
  const today = new Date().toDateString();
  if (today !== lastDashboardReset) {
    closedToday = 0;
    lastDashboardReset = today;
    persistState();
  }
}

// ─────────────────────────────────────────
// EXCHANGE RATES (EUR + USD)
// ─────────────────────────────────────────
async function getExchangeRates() {
  try {
    const res = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,usd-coin&vs_currencies=usd,eur',
      { timeout: 10000 }
    );
    const d = res.data;
    return {
      BTC: { usd: d.bitcoin.usd, eur: d.bitcoin.eur },
      ETH: { usd: d.ethereum.usd, eur: d.ethereum.eur },
      SOL: { usd: d.solana.usd, eur: d.solana.eur },
      USDC: { usd: 1, eur: d['usd-coin'].eur }
    };
  } catch (err) {
    console.error('CoinGecko error:', err.message);
    return null;
  }
}

async function convertEurToCrypto(eurAmount) {
  const rates = await getExchangeRates();
  if (!rates) return null;
  const usdAmount = (eurAmount / rates.USDC.eur).toFixed(2);
  return {
    usdAmount,
    USDC: (eurAmount / rates.USDC.eur).toFixed(2),
    BTC: (eurAmount / rates.BTC.eur).toFixed(8),
    ETH: (eurAmount / rates.ETH.eur).toFixed(6),
    SOL: (eurAmount / rates.SOL.eur).toFixed(4)
  };
}

// ─────────────────────────────────────────
// ROLE ASSIGNMENT
// ─────────────────────────────────────────
async function assignVerifiedBuyerRole(guild, member) {
  try {
    const botMember = guild.members.cache.get(client.user.id);
    if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) return false;
    let role = guild.roles.cache.find(r => r.name === VERIFIED_BUYER_ROLE_NAME);
    if (!role) {
      role = await guild.roles.create({ name: VERIFIED_BUYER_ROLE_NAME, color: 0x57F287, reason: 'Auto-created Verified Buyer role' });
    }
    await member.roles.add(role);
    return true;
  } catch (err) {
    console.error('Role assign error:', err.message);
    return false;
  }
}

// ─────────────────────────────────────────
// DM AL CLIENTE (senza credenziali)
// ─────────────────────────────────────────
async function sendDMReceipt(user, session, method, confirmedBy) {
  try {
    const embed = new EmbedBuilder()
      .setTitle('✅ Payment Confirmed — Receipt')
      .setDescription('Thank you for your purchase! Here is your receipt.')
      .addFields(
        { name: '🎫 Ticket', value: `#${session.number || 'N/A'}`, inline: true },
        { name: '💳 Payment Method', value: method, inline: true },
        { name: '🎮 Game(s) Ordered', value: session.requestedGames || 'N/A', inline: false },
        { name: '💶 Amount Paid', value: `${session.priceEur} EUR`, inline: true },
        { name: '✅ Confirmed by', value: `<@${confirmedBy}>`, inline: true },
        { name: '🕐 Date', value: new Date().toLocaleString('en-US'), inline: true },
      )
      .setColor(0x57F287)
      .setTimestamp()
      .setFooter({ text: 'Keep this receipt for your records.' });

    await user.send({ embeds: [embed] });
  } catch (err) {
    console.error('DM error:', err.message);
  }
}

// ─────────────────────────────────────────
// IGDB COVER
// ─────────────────────────────────────────
async function getTwitchToken() {
  const res = await axios.post(`https://id.twitch.tv/oauth2/token?client_id=${process.env.TWITCH_CLIENT_ID}&client_secret=${process.env.TWITCH_CLIENT_SECRET}&grant_type=client_credentials`);
  return res.data.access_token;
}

async function getCoverImage(gameName) {
  try {
    const token = await getTwitchToken();
    const response = await axios.post('https://api.igdb.com/v4/games', `search "${gameName}"; fields name, cover.url; limit 1;`, {
      headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID, 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' }
    });
    const game = response.data[0];
    if (game?.cover) return 'https:' + game.cover.url.replace('t_thumb', 't_cover_big');
    return null;
  } catch (err) { console.error('IGDB Error:', err.message); return null; }
}

// ─────────────────────────────────────────
// DASHBOARD, TOP BUYERS, BLACKLIST, RATING VOICE
// ─────────────────────────────────────────
async function updateDashboard(guild) {
  try {
    checkDailyReset();
    const channel = guild.channels.cache.get(DASHBOARD_CHANNEL_ID);
    if (!channel) return;
    const embed = new EmbedBuilder()
      .setTitle('📊 Ticket Dashboard')
      .addFields(
        { name: '🟢 Open Tickets', value: `${openTickets}`, inline: true },
        { name: '🔴 Closed Today', value: `${closedToday}`, inline: true },
        { name: '⭐ Average Rating', value: `${getAverageRating()} / 5`, inline: true },
        { name: '📋 Total Reviews', value: `${allRatings.length}`, inline: true },
        { name: '🎫 Total Tickets', value: `${ticketCounter}`, inline: true },
      )
      .setColor(0x5865F2).setFooter({ text: 'Last updated' }).setTimestamp();
    if (dashboardMessageId) {
      try { const msg = await channel.messages.fetch(dashboardMessageId); await msg.edit({ embeds: [embed] }); persistState(); return; }
      catch { dashboardMessageId = null; }
    }
    const msg = await channel.send({ embeds: [embed] });
    dashboardMessageId = msg.id;
    persistState();
  } catch (err) { console.error('Dashboard error:', err.message); }
}

async function updateTopBuyers(guild) {
  try {
    const channel = guild.channels.cache.get(TOP_REVIEWS_CHANNEL_ID);
    if (!channel) return;
    const sorted = [...purchasesPerUser.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 10);
    const medals = ['🥇', '🥈', '🥉'];
    const list = sorted.length > 0
      ? sorted.map(([, data], i) => `${medals[i] || `**${i + 1}.**`} <@${data.userId}> — **${data.count}** purchase${data.count > 1 ? 's' : ''}`).join('\n')
      : 'No purchases yet.';
    const embed = new EmbedBuilder().setTitle('🏆 Top 10 Buyers').setDescription(list).setColor(0xFEE75C).setFooter({ text: 'Last updated' }).setTimestamp();

    // 1) Prova a editare il messaggio già salvato nel DB
    if (topReviewsMessageId) {
      try {
        const msg = await channel.messages.fetch(topReviewsMessageId);
        await msg.edit({ embeds: [embed] });
        persistState();
        return;
      } catch {
        topReviewsMessageId = null;
      }
    }

    // 2) Fallback: cerca nel canale un messaggio precedente del bot con lo stesso embed
    try {
      const recent = await channel.messages.fetch({ limit: 50 });
      const existing = recent.find(
        m => m.author.id === client.user.id &&
             m.embeds.length > 0 &&
             m.embeds[0]?.title === '🏆 Top 10 Buyers'
      );
      if (existing) {
        topReviewsMessageId = existing.id;
        await existing.edit({ embeds: [embed] });
        persistState();
        return;
      }
    } catch (err) {
      console.error('Top buyers scan error:', err.message);
    }

    // 3) Solo se non esiste ancora nessun messaggio, ne manda uno nuovo e lo pinna
    const msg = await channel.send({ embeds: [embed] });
    topReviewsMessageId = msg.id;
    persistState();
    try { await msg.pin(); } catch { /* pin opzionale */ }
  } catch (err) { console.error('Top buyers error:', err.message); }
}

async function updateRatingVoice(guild) {
  try {
    const channel = guild.channels.cache.get(RATING_VOICE_CHANNEL_ID);
    if (!channel) return;
    const average = getAverageRating();
    await channel.setName(`Rating: ${average === '—' ? '—' : `${average} ⭐`}`);
  } catch (err) { console.error('Voice channel error:', err.message); }
}

async function updateBlacklist(guild) {
  try {
    const channel = guild.channels.cache.get(BLACKLIST_CHANNEL_ID);
    if (!channel) return;
    const list = blacklist.size > 0 ? [...blacklist].map((id, i) => `**${i + 1}.** <@${id}> (${id})`).join('\n') : 'No users blacklisted.';
    const embed = new EmbedBuilder().setTitle('🚫 Blacklisted Users').setDescription(list).setColor(0xED4245)
      .addFields({ name: '📊 Total', value: `${blacklist.size} user${blacklist.size !== 1 ? 's' : ''}`, inline: true })
      .setFooter({ text: 'Last updated' }).setTimestamp();
    if (blacklistMessageId) {
      try { const msg = await channel.messages.fetch(blacklistMessageId); await msg.edit({ embeds: [embed] }); persistState(); return; }
      catch { blacklistMessageId = null; }
    }
    const msg = await channel.send({ embeds: [embed] });
    blacklistMessageId = msg.id;
    persistState();
  } catch (err) { console.error('Blacklist error:', err.message); }
}

// ─────────────────────────────────────────
// CREA CANALE TICKET
// ─────────────────────────────────────────
async function createTicketChannel(guild, user, reason, number) {
  const ownerRole = guild.roles.cache.find(r => r.name === OWNER_ROLE_NAME);
  const permissions = [
    { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
    { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels] },
  ];
  if (ownerRole) permissions.push({ id: ownerRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });

  // MODIFICA 1: support ticket ha nome diverso
  const channelName = reason === 'reason_support' ? `support-ticket-${number}` : `ticket-${number}`;

  const channel = await guild.channels.create({ name: channelName, type: ChannelType.GuildText, parent: CATEGORY_ID, permissionOverwrites: permissions });
  const reasonLabels = { reason_purchase: '🎮 Purchase', reason_support: '❓ Support' };
  const openTime = new Date();

  const ticketDescription = reason === 'reason_purchase'
    ? `Welcome ${user}! 👋\n\n**Thanks for opening a ticket!**\n\nBefore proceeding, please read the rules and click the button below to confirm your agreement.\n\n*Our team will be with you shortly after you agree.*`
    : `Welcome ${user}! 👋\n\n**Thanks for opening a support ticket!**\n\nPlease read the rules and click the button below to continue.\n\n*Our team will be with you shortly after you agree.*`;

  const embedTicket = new EmbedBuilder()
    .setTitle(`🎫 Ticket #${number} — ${reasonLabels[reason] || 'Support'}`)
    .setDescription(ticketDescription)
    .setColor(reason === 'reason_support' ? 0xE67E22 : 0x5865F2)
    .setFooter({ text: `Opened at: ${openTime.toLocaleString('en-US')}` })
    .setTimestamp();

  const rulesEmbed = new EmbedBuilder()
    .setTitle('📜 Server Rules & Guidelines')
    .setDescription(
      '• Be respectful to staff and other users.\n' +
      '• Provide accurate information when purchasing.\n' +
      '• Refunds are handled directly via Steam.\n' +
      '• Do not share payment proofs in public channels.\n\n' +
      'By clicking **"I Agree"** below, you confirm that you have read and agree to the rules.'
    )
    .setColor(0x5865F2)
    .setFooter({ text: 'Support System' });

  const agreeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`agree_rules_${user.id}`).setLabel('✅ I Agree').setStyle(ButtonStyle.Success)
  );

  await channel.send({ content: `${user} ${ownerRole ? ownerRole : ''}`, embeds: [embedTicket] });
  const rulesMsg = await channel.send({ embeds: [rulesEmbed], components: [agreeRow] });

  return { channel, openTime, rulesMsgId: rulesMsg.id };
}

// ─────────────────────────────────────────
// MENU NAVIGABILE — STEP DEFINITIONS
// ─────────────────────────────────────────

// Builds the main menu embed+components for a given step
function buildMenuStep(step, session, extra = {}) {
  const backBtn = new ButtonBuilder().setCustomId('menu_back').setLabel('⬅️ Back').setStyle(ButtonStyle.Secondary);

  switch (step) {

    case 'main_purchase': {
      const embed = new EmbedBuilder()
        .setTitle('🎮 Purchase Menu')
        .setDescription('✅ Rules accepted! Use the buttons below to proceed with your purchase.\n\n**Steps:**\n1️⃣ Fill in the purchase form\n2️⃣ Provide login method\n3️⃣ Owner sets the price\n4️⃣ Choose payment method')
        .setColor(0x5865F2)
        .setFooter({ text: 'Use the buttons below to navigate' });
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('menu_open_purchase_form').setLabel('🎮 Fill Purchase Form').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('menu_refund_info').setLabel('ℹ️ Refund Info').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('close_ticket').setLabel('🔒 Close Ticket').setStyle(ButtonStyle.Danger)
      );
      return { embeds: [embed], components: [row] };
    }

    case 'main_support': {
      const embed = new EmbedBuilder()
        .setTitle('❓ Support Menu')
        .setDescription('✅ Rules accepted! Please describe your issue using the form below.\n\nOur team will get back to you as soon as possible!')
        .setColor(0xE67E22)
        .setFooter({ text: 'Use the buttons below to navigate' });
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('menu_open_support_form').setLabel('📝 Describe your Issue').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('menu_refund_info').setLabel('ℹ️ Refund Info').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('close_ticket').setLabel('🔒 Close Ticket').setStyle(ButtonStyle.Danger)
      );
      return { embeds: [embed], components: [row] };
    }

    case 'refund_info': {
      const embed = new EmbedBuilder()
        .setTitle('💰 Steam Refund Policy')
        .setDescription(
          'You can request a refund for any game within **14 days of purchase** and played for **less than 2 hours**.\n\n' +
          'Refunds will be credited to your **Steam wallet**.\n\n' +
          'To request a refund:\n1. Go to **Steam Support** → **Purchases**\n2. Select the game and click **"I would like a refund"**\n\n' +
          '*Our shop does not process refunds manually.*'
        )
        .setColor(0x5865F2);
      const mainStep = session?.reason === 'reason_support' ? 'main_support' : 'main_purchase';
      const row = new ActionRowBuilder().addComponents(
        backBtn.setCustomId(`menu_goto_${mainStep}`)
      );
      return { embeds: [embed], components: [row] };
    }

    case 'choose_login': {
      const embed = new EmbedBuilder()
        .setTitle('🔐 Login Method')
        .setDescription(`✅ Payment confirmed!\n\n**Games:** ${session?.requestedGames || 'N/A'}\n\nPlease choose how you want to provide your login information so we can process your order:`)
        .setColor(0x57F287);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('menu_choose_credentials').setLabel('🔐 Use Credentials').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('menu_choose_qr').setLabel('📱 Use QR Code').setStyle(ButtonStyle.Secondary)
      );
      return { embeds: [embed], components: [row] };
    }

    case 'qr_waiting': {
      const embed = new EmbedBuilder()
        .setTitle('📱 QR Code Login')
        .setDescription('Please wait while the owner sends you the QR code.\n\nOnce you have scanned it and successfully logged in, click the button below to confirm.')
        .setColor(0x5865F2);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('menu_confirm_qr').setLabel('✅ Confirmed').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('menu_goto_choose_login').setLabel('⬅️ Back').setStyle(ButtonStyle.Secondary)
      );
      return { embeds: [embed], components: [row] };
    }

    case 'awaiting_price': {
      const embed = new EmbedBuilder()
        .setTitle('⏳ Waiting for Price')
        .setDescription('✅ Order received!\n\nThe owner is reviewing your request and will set the price shortly.\n\nPlease wait — you will be notified when the price is ready.')
        .setColor(0xFEE75C)
        .setFooter({ text: 'Do not close this ticket' });
      return { embeds: [embed], components: [] };
    }

    case 'choose_payment': {
      const crypto = extra?.cryptoAmounts;
      let desc = `💶 **Total: ${session?.priceEur} EUR**\n\n`;
      if (crypto) {
        desc += `**Crypto equivalents:**\n💵 USDC: **${crypto.USDC}**\n₿ BTC: **${crypto.BTC}**\n⟠ ETH: **${crypto.ETH}**\n◎ SOL: **${crypto.SOL}**\n\n`;
      }
      desc += `Please select how you would like to pay:\n💳 **PayPal** — Instant\n🪙 **Crypto** — Multiple coins available\n\n⏰ You have **30 minutes** to complete the payment.`;
      const embed = new EmbedBuilder()
        .setTitle('💳 Choose Payment Method')
        .setDescription(desc)
        .setColor(0x5865F2);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('menu_payment_paypal').setLabel('💳 PayPal').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('menu_payment_crypto').setLabel('🪙 Crypto').setStyle(ButtonStyle.Secondary)
      );
      return { embeds: [embed], components: [row] };
    }

    case 'paypal_pay': {
      const embed = new EmbedBuilder()
        .setTitle('💳 PayPal Payment')
        .setDescription(`**Amount: ${session?.priceEur} EUR**\n\nScan the QR code below to pay via PayPal.\n\n📌 After completing the payment, click the button below to notify staff.`)
        .setColor(0x003087)
        .setFooter({ text: 'PayPal • Instant Payment' });
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('menu_customer_paid_paypal').setLabel('✅ I have paid').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('menu_goto_choose_payment').setLabel('⬅️ Back').setStyle(ButtonStyle.Secondary)
      );
      return { embeds: [embed], components: [row], files: [{ attachment: './paypal-qr.png', name: 'paypal-qr.png' }] };
    }

    case 'crypto_select_coin': {
      const embed = new EmbedBuilder().setTitle('🪙 Crypto Payment').setDescription('Select cryptocurrency:').setColor(0xF7931A);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('menu_crypto_USDC').setLabel('💵 USDC').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('menu_crypto_SOL').setLabel('◎ Solana').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('menu_crypto_BTC').setLabel('₿ Bitcoin').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('menu_crypto_ETH').setLabel('⟠ Ethereum').setStyle(ButtonStyle.Secondary)
      );
      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('menu_goto_choose_payment').setLabel('⬅️ Back').setStyle(ButtonStyle.Secondary)
      );
      return { embeds: [embed], components: [row, row2] };
    }

    case 'crypto_select_network': {
      const coin = extra.coin;
      const data = cryptoData[coin];
      const cryptoAmounts = extra.cryptoAmounts;
      const amount = cryptoAmounts?.[coin] || '?';
      const embed = new EmbedBuilder()
        .setTitle(`${data.emoji} ${coin} — Select Network`)
        .setDescription(`Amount: **${amount} ${coin}**`)
        .addFields(data.networks.map(n => ({ name: `🌐 ${n.name}`, value: `⏱️ ${n.time}`, inline: true })))
        .setColor(0xF7931A);
      const row = new ActionRowBuilder().addComponents(
        data.networks.map((n, i) => new ButtonBuilder().setCustomId(`menu_network_${coin}_${i}`).setLabel(`🌐 ${n.name} — ${n.time}`).setStyle(ButtonStyle.Secondary))
      );
      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('menu_goto_crypto_select_coin').setLabel('⬅️ Back').setStyle(ButtonStyle.Secondary)
      );
      return { embeds: [embed], components: [row, row2] };
    }

    case 'crypto_payment_address': {
      const coin = extra.coin;
      const net = extra.net;
      const amount = extra.amount;
      const data = cryptoData[coin];
      const embed = new EmbedBuilder()
        .setTitle(`${data.emoji} ${coin} — ${net.name}`)
        .setDescription(`**Amount to send:** ${amount} ${coin}\n**Address:**\n\`\`\`${net.address}\`\`\`\n🌐 Network: ${net.name}\n⏱️ Est. time: ${net.time}\n\n⚠️ Use the correct network!\n📌 After sending, click **"I Have Paid"** and enter your transaction hash.`)
        .setColor(0xF7931A);
      const backTarget = data.networks.length === 1 ? 'crypto_select_coin' : `crypto_select_network_${coin}`;
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('menu_i_have_paid').setLabel('✅ I Have Paid').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`menu_goto_${backTarget}`).setLabel('⬅️ Back').setStyle(ButtonStyle.Secondary)
      );
      return { embeds: [embed], components: [row] };
    }

    case 'awaiting_payment_verification': {
      const embed = new EmbedBuilder()
        .setTitle('⏳ Awaiting Verification')
        .setDescription('Your payment has been submitted for verification.\n\nThe owner will confirm shortly. Please stay in this ticket for updates.')
        .setColor(0xFEE75C)
        .setTimestamp();
      return { embeds: [embed], components: [] };
    }

    case 'review_prompt': {
      const embed = new EmbedBuilder()
        .setTitle('🎉 Order Delivered!')
        .setDescription('Your order has been delivered! 🎮\n\nWe hope you enjoy your game!\n\n**Would you like to leave a review?**\nIt only takes a minute and helps us grow! 🙏')
        .setColor(0x57F287)
        .setTimestamp();
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('menu_leave_review').setLabel('✍️ Leave a Review').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('menu_skip_review').setLabel('❌ Skip & Close').setStyle(ButtonStyle.Secondary)
      );
      return { embeds: [embed], components: [row] };
    }

    case 'awaiting_login_after_payment': {
      const embed = new EmbedBuilder()
        .setTitle('⏳ Awaiting Login')
        .setDescription('✅ Login information received!\n\nThe owner will now process your order and deliver it shortly.\n\nPlease stay in this ticket.')
        .setColor(0x57F287)
        .setFooter({ text: 'Do not close this ticket' });
      return { embeds: [embed], components: [] };
    }

    default:
      return { content: '❌ Unknown step.', components: [] };
  }
}

// ─────────────────────────────────────────
// BOTTONI DOPO ACCORDO REGOLAMENTO
// ─────────────────────────────────────────
async function sendTicketButtons(channel, user, reason, session) {
  if (session) { session.rulesAccepted = true; userSessions.set(user.id, session); }
  const step = reason === 'reason_purchase' ? 'main_purchase' : 'main_support';
  const menu = buildMenuStep(step, session);
  const msg = await channel.send({ content: `✅ ${user} you have agreed to the rules. Use the menu below to proceed.`, ...menu });
  if (session) { session.menuMessageId = msg.id; userSessions.set(user.id, session); }
}

// ─────────────────────────────────────────
// TRANSCRIPT E CHIUSURA TICKET
// ─────────────────────────────────────────
async function sendTranscript(guild, channel, user, review = null, openTime = null, reason = null, number = null) {
  const logsChannel = guild.channels.cache.get(LOGS_CHANNEL_ID);
  if (!logsChannel) return;
  const closeTime = new Date();
  const duration = openTime ? formatDuration(closeTime - openTime) : 'N/A';
  const messages = await channel.messages.fetch({ limit: 100 });
  const sortedMessages = [...messages.values()].reverse();
  const transcript = sortedMessages.filter(m => m.content && !m.author.bot).map(m => `[${new Date(m.createdTimestamp).toLocaleString('en-US')}] ${m.author.username}: ${m.content}`).join('\n') || 'No messages found.';
  const reasonLabels = { reason_purchase: '🎮 Purchase', reason_support: '❓ Support' };
  const embedLog = new EmbedBuilder()
    .setTitle(`📋 Ticket Transcript — #${number || channel.name}`)
    .addFields(
      { name: '👤 User', value: `${user} (${user.id})`, inline: true },
      { name: '🏷️ Reason', value: reasonLabels[reason] || 'N/A', inline: true },
      { name: '🔢 Ticket', value: `#${number || 'N/A'}`, inline: true },
      { name: '🕐 Opened at', value: openTime ? openTime.toLocaleString('en-US') : 'N/A', inline: true },
      { name: '🕐 Closed at', value: closeTime.toLocaleString('en-US'), inline: true },
      { name: '⏱️ Duration', value: duration, inline: true }
    )
    .setColor(review ? 0x57F287 : 0x5865F2).setThumbnail(user.displayAvatarURL()).setTimestamp();
  if (review) {
    const starsLabel = ['', '⭐', '⭐⭐', '⭐⭐⭐', '⭐⭐⭐⭐', '⭐⭐⭐⭐⭐'];
    embedLog.addFields(
      { name: '🎮 Game reviewed', value: review.game, inline: true },
      { name: '⭐ Rating', value: `${starsLabel[review.stars]} (${review.stars}/5)`, inline: true },
      { name: '💬 Review', value: review.text, inline: false }
    );
  } else {
    embedLog.addFields({ name: '⭐ Review', value: 'No review left.', inline: false });
  }
  const btnReopen = new ButtonBuilder()
    .setCustomId(`reopen_ticket_${user.id}_${reason || 'reason_support'}_${number || '0000'}`)
    .setLabel('🔓 Reopen Ticket').setStyle(ButtonStyle.Primary);
  await logsChannel.send({ embeds: [embedLog], components: [new ActionRowBuilder().addComponents(btnReopen)] });
  if (transcript !== 'No messages found.') {
    const buffer = Buffer.from(transcript, 'utf-8');
    await logsChannel.send({ content: `📄 **Full transcript for ticket \`#${number || channel.name}\`:**`, files: [{ attachment: buffer, name: `transcript-${number || channel.name}.txt` }] });
  }
}

async function closeTicket(guild, channel, user, session) {
  clearPaymentTimer(user.id || user);
  openTickets = Math.max(0, openTickets - 1);
  closedToday++;
  persistState();
  await sendTranscript(guild, channel, user, null, session?.openTime, session?.reason, session?.number);
  await updateDashboard(guild);
  await channel.send({ content: `🔒 *This ticket is being closed. Channel will be deleted in 5 seconds...*` });
  userSessions.delete(user.id || user);
  setTimeout(async () => { try { await channel.delete(); } catch (err) { console.error(err.message); } }, 5000);
}

// ─────────────────────────────────────────
// BOT READY
// ─────────────────────────────────────────
client.once(Events.ClientReady, async () => {
  console.log(`✅ Bot online as ${client.user.tag}`);
  const commands = [
    { name: 'setup-ticket', description: 'Create the ticket panel' },
    { name: 'setup-recensioni', description: 'Create the reviews panel' },
    { name: 'chiudi', description: "Close a user's ticket", options: [{ name: 'utente', type: 6, description: 'User', required: true }] },
    { name: 'blacklist', description: 'Add/remove user from blacklist', options: [{ name: 'utente', type: 6, description: 'User', required: true }] },
    { name: 'unblacklist', description: 'Remove user from blacklist', options: [{ name: 'utente', type: 6, description: 'User', required: true }] },
    {
      name: 'setlimit',
      description: 'Set custom daily ticket limit for a user (Owner only)',
      options: [
        { name: 'utente', type: 6, description: 'User', required: true },
        { name: 'limite', type: 4, description: 'Max tickets per day (0 = ban from tickets)', required: true }
      ]
    },
    {
      name: 'purge',
      description: 'Cancella tutti i messaggi del canale (Owner only)',
      options: [
        { name: 'canale', type: 7, description: 'Canale da svuotare (default: canale corrente)', required: false }
      ]
    },
    {
      name: 'exportdb',
      description: 'Ricevi il database completo via DM (Owner only)',
      options: [
        {
          name: 'tipo',
          type: 3,
          description: 'Cosa vuoi esportare',
          required: false,
          choices: [
            { name: 'Tutto (database.json)', value: 'all' },
            { name: 'Solo recensioni', value: 'reviews' },
            { name: 'Solo pagamenti', value: 'payments' },
            { name: 'Solo statistiche', value: 'stats' }
          ]
        }
      ]
    }
  ];
  for (const guild of client.guilds.cache.values()) {
    await guild.commands.set(commands);
    console.log(`✅ Commands registered in ${guild.name}`);
  }
});

// ─────────────────────────────────────────
// INTERACTIONS
// ─────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
  try {

  // ── SLASH COMMANDS ──
  if (interaction.isChatInputCommand()) {

    if (interaction.commandName === 'setup-ticket') {
      const embed = new EmbedBuilder().setTitle('🛒 Purchase Support')
        .setDescription('Need help with a purchase?\nClick the button below to open a private ticket!\n\n**We offer:**\n🎮 Steam game purchases\n💳 PayPal & Crypto payments\n\nOur team will assist you as soon as possible 🙏')
        .setColor(0x5865F2);
      await interaction.reply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('open_ticket').setLabel('🎫 Open a Ticket').setStyle(ButtonStyle.Primary))] });
    }

    else if (interaction.commandName === 'setup-recensioni') {
      const embed = new EmbedBuilder().setTitle('🎮 Leave your review! ⭐')
        .setDescription('Share your opinion with the community!\nClick the button below to review\n\n**Please include:**\n1. 🎮 Game purchased\n2. 💬 Your experience\n3. ⭐ Rating (1 to 5 stars)\n\nThank you! Your feedback helps us grow 🙏')
        .setColor(0x5865F2);
      await interaction.reply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('open_review').setLabel('✍️ Write a Review').setStyle(ButtonStyle.Primary))] });
    }

    else if (interaction.commandName === 'chiudi') {
      const ownerRole = interaction.guild.roles.cache.find(r => r.name === OWNER_ROLE_NAME);
      if (!interaction.member.roles.cache.has(ownerRole?.id)) return interaction.reply({ content: '❌ Only the Owner can use this command.', ephemeral: true });
      const target = interaction.options.getUser('utente');
      const session = userSessions.get(target.id);
      const channel = session?.channelId
        ? interaction.guild.channels.cache.get(session.channelId)
        : interaction.guild.channels.cache.find(ch => (ch.name.startsWith('ticket-') || ch.name.startsWith('support-ticket-')) && ch.permissionOverwrites.cache.has(target.id));
      if (!channel) return interaction.reply({ content: `❌ No open ticket found for ${target}.`, ephemeral: true });
      await interaction.reply({ content: `🔒 Closing ticket for ${target}...`, ephemeral: true });
      await closeTicket(interaction.guild, channel, target, session);
    }

    else if (interaction.commandName === 'blacklist') {
      const ownerRole = interaction.guild.roles.cache.find(r => r.name === OWNER_ROLE_NAME);
      if (!interaction.member.roles.cache.has(ownerRole?.id)) return interaction.reply({ content: '❌ Only the Owner can use this command.', ephemeral: true });
      const target = interaction.options.getUser('utente');
      if (blacklist.has(target.id)) { blacklist.delete(target.id); await interaction.reply({ content: `✅ ${target} has been **removed** from the blacklist.`, ephemeral: true }); }
      else { blacklist.add(target.id); await interaction.reply({ content: `🚫 ${target} has been **added** to the blacklist.`, ephemeral: true }); }
      await updateBlacklist(interaction.guild);
    }

    else if (interaction.commandName === 'unblacklist') {
      const ownerRole = interaction.guild.roles.cache.find(r => r.name === OWNER_ROLE_NAME);
      if (!interaction.member.roles.cache.has(ownerRole?.id)) return interaction.reply({ content: '❌ Only the Owner can use this command.', ephemeral: true });
      const target = interaction.options.getUser('utente');
      if (!blacklist.has(target.id)) return interaction.reply({ content: `❌ ${target} is not blacklisted.`, ephemeral: true });
      blacklist.delete(target.id);
      await updateBlacklist(interaction.guild);
      await interaction.reply({ content: `✅ ${target} has been removed from the blacklist.`, ephemeral: true });
    }

    // ── purge ──
    else if (interaction.commandName === 'purge') {
      const ownerRole = interaction.guild.roles.cache.find(r => r.name === OWNER_ROLE_NAME);
      if (!interaction.member.roles.cache.has(ownerRole?.id))
        return interaction.reply({ content: '❌ Solo l\'Owner può usare questo comando.', ephemeral: true });

      const target = interaction.options.getChannel('canale') || interaction.channel;
      if (!target || target.type !== 0)
        return interaction.reply({ content: '❌ Canale non valido.', ephemeral: true });

      await interaction.deferReply({ ephemeral: true });

      let deleted = 0;
      let batch;
      do {
        batch = await target.messages.fetch({ limit: 100 });
        if (batch.size === 0) break;
        const recent = batch.filter(m => Date.now() - m.createdTimestamp < 14 * 24 * 60 * 60 * 1000);
        const old14  = batch.filter(m => Date.now() - m.createdTimestamp >= 14 * 24 * 60 * 60 * 1000);
        if (recent.size > 0) await target.bulkDelete(recent, true);
        for (const m of old14.values()) await m.delete().catch(() => {});
        deleted += batch.size;
        await new Promise(r => setTimeout(r, 500));
      } while (batch.size >= 2);

      await interaction.editReply({ content: `🗑️ Cancellati **${deleted}** messaggi da <#${target.id}>.` });
    }

    // ── exportdb ──
    else if (interaction.commandName === 'exportdb') {
      const ownerRole = interaction.guild.roles.cache.find(r => r.name === OWNER_ROLE_NAME);
      if (!interaction.member.roles.cache.has(ownerRole?.id))
        return interaction.reply({ content: '❌ Solo l\'Owner può usare questo comando.', ephemeral: true });

      await interaction.deferReply({ ephemeral: true });

      const tipo = interaction.options.getString('tipo') || 'all';
      const db = loadDB();

      try {
        if (tipo === 'all') {
          // Manda il database.json completo
          const buf = Buffer.from(JSON.stringify(db, null, 2), 'utf-8');
          await interaction.user.send({
            content: '📦 **Database completo** — `database.json`',
            files: [{ attachment: buf, name: 'database.json' }]
          });

        } else if (tipo === 'reviews') {
          const reviews = db.reviews || [];
          if (reviews.length === 0) return interaction.editReply({ content: '📭 Nessuna recensione trovata.' });
          // Manda come JSON + riepilogo testuale
          const summary = reviews.map((r, i) =>
            `#${i+1} | ⭐${r.stars} | ${r.game} | ${r.userId} | ${new Date(r.date).toLocaleDateString('it-IT')}`
          ).join('\n');
          const buf = Buffer.from(JSON.stringify(reviews, null, 2), 'utf-8');
          await interaction.user.send({
            content: `📝 **Recensioni (${reviews.length} totali)**\n\\`\\`\\`\n${summary.slice(0, 1800)}\n\\`\\`\\``,
            files: [{ attachment: buf, name: 'reviews.json' }]
          });

        } else if (tipo === 'payments') {
          const payments = db.payments || [];
          if (payments.length === 0) return interaction.editReply({ content: '📭 Nessun pagamento trovato.' });
          const total = payments.reduce((s, p) => s + (p.priceEur || 0), 0);
          const summary = payments.map((p, i) =>
            `#${i+1} | €${p.priceEur} | ${p.method} | ${p.games} | ${new Date(p.date).toLocaleDateString('it-IT')}`
          ).join('\n');
          const buf = Buffer.from(JSON.stringify(payments, null, 2), 'utf-8');
          await interaction.user.send({
            content: `💳 **Pagamenti (${payments.length} totali — €${total.toFixed(2)} incassati)**\n\\`\\`\\`\n${summary.slice(0, 1800)}\n\\`\\`\\``,
            files: [{ attachment: buf, name: 'payments.json' }]
          });

        } else if (tipo === 'stats') {
          const avg = allRatings.length > 0
            ? (allRatings.reduce((a,b) => a+b, 0) / allRatings.length).toFixed(2)
            : '—';
          const payments = db.payments || [];
          const totalEur = payments.reduce((s, p) => s + (p.priceEur || 0), 0);
          const topBuyers = [...purchasesPerUser.entries()]
            .sort((a,b) => b[1].count - a[1].count)
            .slice(0, 5)
            .map(([,d], i) => `${i+1}. <@${d.userId}> — ${d.count} acquisti`)
            .join('\n') || 'Nessuno';
          const embed = new EmbedBuilder()
            .setTitle('📊 Statistiche Bot')
            .addFields(
              { name: '🎫 Ticket totali', value: `${ticketCounter}`, inline: true },
              { name: '📝 Recensioni', value: `${allRatings.length}`, inline: true },
              { name: '⭐ Rating medio', value: `${avg}/5`, inline: true },
              { name: '💳 Pagamenti', value: `${payments.length}`, inline: true },
              { name: '💶 Incassato totale', value: `€${totalEur.toFixed(2)}`, inline: true },
              { name: '🚫 Blacklist', value: `${blacklist.size} utenti`, inline: true },
              { name: '🏆 Top 5 acquirenti', value: topBuyers, inline: false }
            )
            .setColor(0x5865F2)
            .setTimestamp()
            .setFooter({ text: 'Esportato da ' + interaction.user.username });
          await interaction.user.send({ embeds: [embed] });
        }

        await interaction.editReply({ content: `✅ Dati inviati in DM!` });
      } catch (err) {
        console.error('exportdb error:', err.message);
        await interaction.editReply({ content: '❌ Errore — assicurati di avere i DM aperti.' });
      }
    }

    // MODIFICA 8: comando setlimit
    else if (interaction.commandName === 'setlimit') {
      const ownerRole = interaction.guild.roles.cache.find(r => r.name === OWNER_ROLE_NAME);
      if (!interaction.member.roles.cache.has(ownerRole?.id)) return interaction.reply({ content: '❌ Only the Owner can use this command.', ephemeral: true });
      const target = interaction.options.getUser('utente');
      const limit = interaction.options.getInteger('limite');
      if (limit < 0) return interaction.reply({ content: '❌ Limit must be 0 or higher.', ephemeral: true });
      setTicketLimit(target.id, limit);
      await interaction.reply({
        content: limit === 0
          ? `🚫 ${target} can no longer open tickets (limit set to 0).`
          : `✅ ${target} can now open up to **${limit}** ticket${limit > 1 ? 's' : ''} per day.`,
        ephemeral: true
      });
    }
  }

  // ── BUTTON: open ticket ──
  if (interaction.isButton() && interaction.customId === 'open_ticket') {
    if (blacklist.has(interaction.user.id)) return interaction.reply({ content: '🚫 You are blacklisted and cannot open tickets.', ephemeral: true });

    // MODIFICA 8: controllo anti-spam
    const limit = getTicketLimit(interaction.user.id);
    const openedToday = getTicketsOpenedToday(interaction.user.id);
    if (openedToday >= limit) {
      return interaction.reply({
        content: `❌ You have reached your daily ticket limit (**${limit}** ticket${limit !== 1 ? 's' : ''} per day).\nPlease try again tomorrow or contact staff.`,
        ephemeral: true
      });
    }

    const existing = interaction.guild.channels.cache.find(ch => (ch.name.startsWith('ticket-') || ch.name.startsWith('support-ticket-')) && ch.permissionOverwrites.cache.has(interaction.user.id));
    if (existing) return interaction.reply({ content: `❌ You already have an open ticket! Go to <#${existing.id}>`, ephemeral: true });

    const embed = new EmbedBuilder().setTitle('🎫 Select Ticket Type').setDescription('What do you need help with?').setColor(0x5865F2);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('reason_purchase').setLabel('🎮 Purchase').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('reason_support').setLabel('❓ Support').setStyle(ButtonStyle.Secondary)
    );
    await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
  }

  // ── BUTTON: reason selected ──
  if (interaction.isButton() && (interaction.customId === 'reason_purchase' || interaction.customId === 'reason_support')) {
    const { guild, user } = interaction;
    const reason = interaction.customId;
    ticketCounter++; openTickets++;
    const number = formatTicketNumber(ticketCounter);
    incrementTicketsToday(user.id);
    const { channel, openTime, rulesMsgId } = await createTicketChannel(guild, user, reason, number);
    userSessions.set(user.id, {
      type: 'ticket', channelId: channel.id, reason, number, openTime, rulesMsgId,
      rulesAccepted: false, requestedGames: null, usernameEmail: null, password: null,
      loginMethod: null, loginConfirmed: false, selectedCoin: null, selectedNetwork: null,
      lastHash: null, text: null, stars: 0, paymentStatus: 'pending', priceEur: null, paymentConfirmed: false
    });
    persistState();
    await updateDashboard(guild);
    await interaction.update({ content: `✅ Your ticket is ready! Go to <#${channel.id}>`, embeds: [], components: [] });
  }

  // ── BUTTON: agree rules ──
  if (interaction.isButton() && interaction.customId.startsWith('agree_rules_')) {
    const userId = interaction.customId.split('_')[2];
    if (interaction.user.id !== userId) return interaction.reply({ content: '❌ Only the ticket owner can accept the rules.', ephemeral: true });
    const session = userSessions.get(userId);
    if (!session?.channelId) return interaction.reply({ content: '❌ Session not found.', ephemeral: true });
    session.rulesAccepted = true;
    userSessions.set(userId, session);
    // Trasforma il messaggio delle regole direttamente nel menu principale (zero messaggi extra)
    const step = session.reason === 'reason_purchase' ? 'main_purchase' : 'main_support';
    const menuData = buildMenuStep(step, session);
    await interaction.update({ content: `✅ ${interaction.user} you have agreed to the rules. Use the menu below to proceed.`, ...menuData });
    session.menuMessageId = interaction.message.id;
    userSessions.set(userId, session);
    return;
  }

  // ═══════════════════════════════════════════════════════
  // MENU NAVIGABILE — gestione centralizzata dei menu_* btn
  // ═══════════════════════════════════════════════════════

  // Aggiorna il messaggio menu tramite interaction.update() — solo per bottoni
  async function updateMenu(interaction, step, extra = {}) {
    const session = userSessions.get(interaction.user.id);
    const menuData = buildMenuStep(step, session, extra);
    const { files, ...rest } = menuData;
    if (files && files.length > 0) {
      await interaction.update({ content: '', files, ...rest });
    } else {
      await interaction.update({ content: '', files: [], ...rest });
    }
  }

  // Aggiorna il messaggio menu tramite message.edit() — per i modal (che non supportano update)
  async function editMenuMessage(interaction, userId, step, extra = {}) {
    const session = userSessions.get(userId);
    const menuData = buildMenuStep(step, session, extra);
    const channel = interaction.guild.channels.cache.get(session?.channelId);
    if (!channel || !session?.menuMessageId) return;
    try {
      const msg = await channel.messages.fetch(session.menuMessageId);
      const { files, ...rest } = menuData;
      await msg.edit({ content: '', files: [], ...rest });
    } catch (e) {
      console.error('editMenuMessage error:', e.message);
    }
  }

  // ── menu_goto_* : navigazione back generico ──
  if (interaction.isButton() && interaction.customId.startsWith('menu_goto_')) {
    const target = interaction.customId.replace('menu_goto_', '');
    const session = userSessions.get(interaction.user.id);

    if (target.startsWith('crypto_select_network_')) {
      const coin = target.replace('crypto_select_network_', '');
      const cryptoAmounts = await convertEurToCrypto(session?.priceEur);
      await updateMenu(interaction, 'crypto_select_network', { coin, cryptoAmounts });
    } else {
      await updateMenu(interaction, target);
    }
    return;
  }

  // ── menu_refund_info ──
  if (interaction.isButton() && interaction.customId === 'menu_refund_info') {
    await updateMenu(interaction, 'refund_info');
    return;
  }

  // ── menu_open_support_form ──
  if (interaction.isButton() && interaction.customId === 'menu_open_support_form') {
    const session = userSessions.get(interaction.user.id);
    if (!session?.rulesAccepted) return interaction.reply({ content: '❌ You must accept the rules first.', ephemeral: true });
    const modal = new ModalBuilder().setCustomId('modal_support_form').setTitle('❓ Support Request');
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('support_category').setLabel('What is your issue about?').setStyle(TextInputStyle.Short).setPlaceholder('E.g: Payment, Account, Order, Other...').setRequired(true).setMaxLength(100)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('support_description').setLabel('Describe your issue in detail').setStyle(TextInputStyle.Paragraph).setPlaceholder('Please provide as much detail as possible.').setRequired(true).setMaxLength(1000)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('support_order').setLabel('Related order/ticket number (if any)').setStyle(TextInputStyle.Short).setPlaceholder('E.g: #0012 or N/A').setRequired(false).setMaxLength(50))
    );
    await interaction.showModal(modal);
    return;
  }

  // ── MODAL: support form ──
  if (interaction.isModalSubmit() && interaction.customId === 'modal_support_form') {
    const category = interaction.fields.getTextInputValue('support_category');
    const description = interaction.fields.getTextInputValue('support_description');
    const order = interaction.fields.getTextInputValue('support_order') || 'N/A';
    const session = userSessions.get(interaction.user.id) || {};
    session.supportCategory = category;
    session.supportDescription = description;
    userSessions.set(interaction.user.id, session);
    const ownerRole = interaction.guild.roles.cache.find(r => r.name === OWNER_ROLE_NAME);
    const embed = new EmbedBuilder()
      .setTitle('📋 Support Request Submitted')
      .setDescription('Your request has been received! Our team will assist you shortly.')
      .addFields(
        { name: '📌 Category', value: category, inline: true },
        { name: '🎫 Related Order', value: order, inline: true },
        { name: '📝 Description', value: description, inline: false },
      )
      .setColor(0xE67E22).setThumbnail(interaction.user.displayAvatarURL()).setTimestamp().setFooter({ text: 'Support Team will reply shortly' });
    await interaction.reply({ embeds: [embed] });
    if (ownerRole) await interaction.channel.send({ content: `${ownerRole} — New support request from ${interaction.user}!` });
    return;
  }

  // ── menu_open_purchase_form ──
  if (interaction.isButton() && interaction.customId === 'menu_open_purchase_form') {
    const session = userSessions.get(interaction.user.id);
    if (!session?.rulesAccepted) return interaction.reply({ content: '❌ You must accept the rules first.', ephemeral: true });
    const modal = new ModalBuilder().setCustomId('modal_purchase_form').setTitle('🎮 Purchase Details');
    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('requested_games').setLabel('Which game(s) do you want?').setStyle(TextInputStyle.Paragraph).setPlaceholder('E.g: Elden Ring, Minecraft...\nOne per line.').setRequired(true).setMaxLength(500)));
    await interaction.showModal(modal);
    return;
  }

  // ── MODAL: purchase form → invia Set Price all'owner, aggiorna menu a choose_login ──
  if (interaction.isModalSubmit() && interaction.customId === 'modal_purchase_form') {
    const requestedGames = interaction.fields.getTextInputValue('requested_games').toUpperCase();
    const session = userSessions.get(interaction.user.id) || {};
    session.requestedGames = requestedGames;
    userSessions.set(interaction.user.id, session);

    // Notifica owner con bottone Set Price subito dopo che il cliente ha inserito i giochi
    const ownerRoleFound = interaction.guild.roles.cache.find(r => r.name === OWNER_ROLE_NAME);
    if (ownerRoleFound) {
      const gamesEmbed = new EmbedBuilder()
        .setTitle('🎮 New Order — Set Price')
        .setDescription(`${interaction.user} has filled the purchase form.\n\n**Games requested:**\n## ${requestedGames}`)
        .setColor(0xFEE75C)
        .setTimestamp();
      const priceButtonRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`set_price_${interaction.user.id}`).setLabel('💰 Set Price (EUR)').setStyle(ButtonStyle.Primary)
      );
      const setPriceMsg = await interaction.channel.send({ content: `${ownerRoleFound}`, embeds: [gamesEmbed], components: [priceButtonRow] });
      session.setPriceMsgId = setPriceMsg.id;
      userSessions.set(interaction.user.id, session);
    }

    await interaction.deferUpdate().catch(() => interaction.reply({ content: '✅ Form submitted!', ephemeral: true }));
    await editMenuMessage(interaction, interaction.user.id, 'awaiting_price');
    return;
  }

  // ── menu_choose_credentials ──
  if (interaction.isButton() && interaction.customId === 'menu_choose_credentials') {
    const session = userSessions.get(interaction.user.id);
    if (!session?.requestedGames) return interaction.reply({ content: '❌ Please submit the purchase form first.', ephemeral: true });
    const modal = new ModalBuilder().setCustomId('modal_credentials').setTitle('🔐 Enter Your Credentials');
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('username_email').setLabel('Username or Email').setStyle(TextInputStyle.Short).setPlaceholder('Your account username or email').setRequired(true).setMaxLength(100)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('password').setLabel('Password').setStyle(TextInputStyle.Short).setPlaceholder('Your password').setRequired(true).setMaxLength(100))
    );
    await interaction.showModal(modal);
    return;
  }

  // ── MODAL: credentials → awaiting_login_after_payment ──
  if (interaction.isModalSubmit() && interaction.customId === 'modal_credentials') {
    const usernameEmail = interaction.fields.getTextInputValue('username_email');
    const password = interaction.fields.getTextInputValue('password');
    const session = userSessions.get(interaction.user.id);
    if (!session) return interaction.reply({ content: '❌ Session expired.', ephemeral: true });
    session.usernameEmail = usernameEmail;
    session.password = password;
    session.loginMethod = 'credentials';
    session.loginConfirmed = true;
    userSessions.set(interaction.user.id, session);

    // Mostra credenziali all'owner nel canale
    const credsEmbed = new EmbedBuilder()
      .setTitle('🔐 Customer Credentials (temporary)')
      .setDescription(`**Username/Email:** ${usernameEmail}\n**Password:** ${password}\n\n*This information will be deleted when the ticket is closed.*`)
      .setColor(0xFEE75C);
    await interaction.channel.send({ embeds: [credsEmbed] });

    // Notifica owner per procedere con la consegna
    const ownerRole2 = interaction.guild.roles.cache.find(r => r.name === OWNER_ROLE_NAME);
    if (ownerRole2) {
      const summaryEmbed = new EmbedBuilder()
        .setTitle('📋 Order Ready — Deliver Now')
        .addFields(
          { name: '👤 Customer', value: `${interaction.user}`, inline: true },
          { name: '🎫 Ticket', value: `#${session.number}`, inline: true },
          { name: '🎮 Game(s)', value: `**${session.requestedGames || 'N/A'}**`, inline: false },
          { name: '💶 Amount Paid', value: `${session.priceEur} EUR`, inline: true },
          { name: '🔐 Login', value: 'Credentials provided above', inline: true },
        )
        .setColor(0x57F287).setTimestamp();
      const deliverRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`order_delivered_${interaction.user.id}`).setLabel('✅ Order Delivered').setStyle(ButtonStyle.Success)
      );
      await interaction.channel.send({ content: `${ownerRole2}`, embeds: [summaryEmbed], components: [deliverRow] });
    }

    await interaction.deferUpdate().catch(() => interaction.reply({ content: '✅ Credentials saved!', ephemeral: true }));
    await editMenuMessage(interaction, interaction.user.id, 'awaiting_login_after_payment');
    return;
  }

  // ── menu_choose_qr ──
  if (interaction.isButton() && interaction.customId === 'menu_choose_qr') {
    const session = userSessions.get(interaction.user.id);
    if (!session?.requestedGames) return interaction.reply({ content: '❌ Please submit the purchase form first.', ephemeral: true });
    session.loginMethod = 'qr';
    userSessions.set(interaction.user.id, session);
    await updateMenu(interaction, 'qr_waiting');
    const ownerRole = interaction.guild.roles.cache.find(r => r.name === OWNER_ROLE_NAME);
    if (ownerRole) {
      const qrRequestMsg = await interaction.channel.send({ content: `${ownerRole}`, embeds: [new EmbedBuilder().setTitle('📱 QR Code Requested').setDescription(`${interaction.user} has chosen QR code login. Please send the QR code manually in this channel.`).setColor(0xFEE75C)] });
      session.qrRequestMsgId = qrRequestMsg.id;
      userSessions.set(interaction.user.id, session);
    }
    return;
  }

  // ── menu_confirm_qr ──
  if (interaction.isButton() && interaction.customId === 'menu_confirm_qr') {
    const session = userSessions.get(interaction.user.id);
    if (!session) return interaction.reply({ content: '❌ Session expired.', ephemeral: true });
    session.loginConfirmed = true;
    userSessions.set(interaction.user.id, session);

    // Elimina il messaggio "QR Code Requested" salvato in precedenza
    if (session.qrRequestMsgId) {
      try {
        const qrReqMsg = await interaction.channel.messages.fetch(session.qrRequestMsgId);
        await qrReqMsg.delete();
      } catch { /* già eliminato o non trovato */ }
      delete session.qrRequestMsgId;
    }

    // Elimina tutti i messaggi con immagini inviati nel canale dopo l'avvio del ticket (immagine QR dell'owner)
    try {
      const fetched = await interaction.channel.messages.fetch({ limit: 50 });
      const imageMsgs = fetched.filter(m =>
        m.attachments.size > 0 &&
        m.attachments.some(a => a.contentType && a.contentType.startsWith('image/'))
      );
      for (const msg of imageMsgs.values()) {
        await msg.delete().catch(() => {});
      }
    } catch { /* ignora errori fetch */ }

    userSessions.set(interaction.user.id, session);

    // Notifica owner per procedere con la consegna
    const ownerRoleQr = interaction.guild.roles.cache.find(r => r.name === OWNER_ROLE_NAME);
    if (ownerRoleQr) {
      const summaryEmbed = new EmbedBuilder()
        .setTitle('📋 Order Ready — Deliver Now')
        .addFields(
          { name: '👤 Customer', value: `${interaction.user}`, inline: true },
          { name: '🎫 Ticket', value: `#${session.number}`, inline: true },
          { name: '🎮 Game(s)', value: `**${session.requestedGames || 'N/A'}**`, inline: false },
          { name: '💶 Amount Paid', value: `${session.priceEur} EUR`, inline: true },
          { name: '🔐 Login', value: '✅ QR Code confirmed', inline: true },
        )
        .setColor(0x57F287).setTimestamp();
      const deliverRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`order_delivered_${interaction.user.id}`).setLabel('✅ Order Delivered').setStyle(ButtonStyle.Success)
      );
      await interaction.channel.send({ content: `${ownerRoleQr}`, embeds: [summaryEmbed], components: [deliverRow] });
    }

    await updateMenu(interaction, 'awaiting_login_after_payment');
    return;
  }

  // ── BUTTON: set price (owner) ──
  if (interaction.isButton() && interaction.customId.startsWith('set_price_')) {
    const ownerRole = interaction.guild.roles.cache.find(r => r.name === OWNER_ROLE_NAME);
    if (!interaction.member.roles.cache.has(ownerRole?.id)) return interaction.reply({ content: '❌ Only the Owner can set prices.', ephemeral: true });
    const userId = interaction.customId.split('_')[2];
    const session = userSessions.get(userId);
    if (!session) return interaction.reply({ content: '❌ Session not found.', ephemeral: true });
    const modal = new ModalBuilder().setCustomId(`modal_set_price_${userId}`).setTitle('💰 Set Price in EUR');
    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('price_eur').setLabel('Price in EUR').setStyle(TextInputStyle.Short).setPlaceholder('e.g., 29.99').setRequired(true)));
    await interaction.showModal(modal);
    return;
  }

  // ── MODAL: set price → aggiorna menu del cliente a choose_login ──
  if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_set_price_')) {
    const userId = interaction.customId.split('_')[3];
    const session = userSessions.get(userId);
    if (!session) return interaction.reply({ content: '❌ Session expired.', ephemeral: true });
    const priceEur = parseFloat(interaction.fields.getTextInputValue('price_eur'));
    if (isNaN(priceEur) || priceEur <= 0) return interaction.reply({ content: '❌ Invalid price.', ephemeral: true });
    session.priceEur = priceEur;
    userSessions.set(userId, session);

    const cryptoAmounts = await convertEurToCrypto(priceEur);
    if (!cryptoAmounts) return interaction.reply({ content: '❌ Error fetching exchange rates. Try again.' });

    // Salva i crypto amounts in sessione per usarli dopo nel choose_payment
    session.cryptoAmounts = cryptoAmounts;
    userSessions.set(userId, session);

    // Elimina il messaggio "Set Price" dal canale
    const userChannelForDelete = interaction.guild.channels.cache.get(session.channelId);
    if (userChannelForDelete && session.setPriceMsgId) {
      try {
        const setPriceMsg = await userChannelForDelete.messages.fetch(session.setPriceMsgId);
        await setPriceMsg.delete();
      } catch { /* già eliminato o non trovato */ }
      delete session.setPriceMsgId;
      userSessions.set(userId, session);
    }

    // Conferma prezzo all'owner (ephemeral)
    const priceEmbed = new EmbedBuilder()
      .setTitle('💰 Price Set')
      .setDescription(
        `Price set to **${priceEur} EUR** (≈ **$${cryptoAmounts.usdAmount} USD**).\n\n` +
        `**Crypto equivalents:**\n💵 USDC: **${cryptoAmounts.USDC}**\n₿ BTC: **${cryptoAmounts.BTC}**\n⟠ ETH: **${cryptoAmounts.ETH}**\n◎ SOL: **${cryptoAmounts.SOL}**`
      )
      .setColor(0x57F287)
      .setFooter({ text: 'Rates are live.' });
    await interaction.reply({ embeds: [priceEmbed], ephemeral: true });

    // Ora mostra direttamente il menu di pagamento al cliente
    const userChannel = interaction.guild.channels.cache.get(session.channelId);
    if (userChannel && session.menuMessageId) {
      try {
        const menuMsg = await userChannel.messages.fetch(session.menuMessageId);
        const menuData = buildMenuStep('choose_payment', session, { cryptoAmounts });
        await menuMsg.edit({ content: `<@${userId}>`, ...menuData });
      } catch {
        const customer = await interaction.guild.members.fetch(userId).catch(() => null);
        const menuData = buildMenuStep('choose_payment', session, { cryptoAmounts });
        const msg = await userChannel.send({ content: `${customer}`, ...menuData });
        session.menuMessageId = msg.id;
        userSessions.set(userId, session);
      }
    }
    startPaymentTimer(interaction.guild, userId, session.channelId, session);
    return;
  }

  // ── menu_goto_choose_payment ──
  // (gestito dal goto handler sopra)

  // ── menu_payment_paypal ──
  if (interaction.isButton() && interaction.customId === 'menu_payment_paypal') {
    const session = userSessions.get(interaction.user.id);
    if (!session) return interaction.reply({ content: '❌ Session expired.', ephemeral: true });
    session.selectedCoin = 'PayPal';
    session.selectedNetwork = 'PayPal';
    session.paymentStatus = 'awaiting_confirmation';
    userSessions.set(interaction.user.id, session);
    await updateMenu(interaction, 'paypal_pay');
    return;
  }

  // ── menu_payment_crypto ──
  if (interaction.isButton() && interaction.customId === 'menu_payment_crypto') {
    await updateMenu(interaction, 'crypto_select_coin');
    return;
  }

  // ── menu_crypto_COIN ──
  if (interaction.isButton() && /^menu_crypto_(USDC|SOL|BTC|ETH)$/.test(interaction.customId)) {
    const coin = interaction.customId.split('_')[2];
    const session = userSessions.get(interaction.user.id);
    if (!session?.priceEur) return interaction.reply({ content: '❌ Price not set.', ephemeral: true });
    session.selectedCoin = coin;
    userSessions.set(interaction.user.id, session);
    const data = cryptoData[coin];
    const cryptoAmounts = await convertEurToCrypto(session.priceEur);
    if (!cryptoAmounts) return interaction.reply({ content: '❌ Exchange rate error.' });
    if (data.networks.length === 1) {
      const net = data.networks[0];
      session.selectedNetwork = net.name;
      userSessions.set(interaction.user.id, session);
      await updateMenu(interaction, 'crypto_payment_address', { coin, net, amount: cryptoAmounts[coin] });
    } else {
      await updateMenu(interaction, 'crypto_select_network', { coin, cryptoAmounts });
    }
    return;
  }

  // ── menu_network_COIN_INDEX ──
  if (interaction.isButton() && interaction.customId.startsWith('menu_network_')) {
    const parts = interaction.customId.split('_');
    const coin = parts[2];
    const index = parseInt(parts[3]);
    const data = cryptoData[coin];
    const net = data.networks[index];
    const session = userSessions.get(interaction.user.id);
    if (!session) return;
    session.selectedNetwork = net.name;
    userSessions.set(interaction.user.id, session);
    const cryptoAmounts = await convertEurToCrypto(session.priceEur);
    const amount = cryptoAmounts?.[coin];
    await updateMenu(interaction, 'crypto_payment_address', { coin, net, amount });
    return;
  }

  // ── menu_i_have_paid ──
  if (interaction.isButton() && interaction.customId === 'menu_i_have_paid') {
    const modal = new ModalBuilder().setCustomId('modal_payment_hash').setTitle('🔍 Enter Transaction Hash');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('tx_hash').setLabel('Transaction Hash').setStyle(TextInputStyle.Short)
        .setPlaceholder('0x... or Solana/BTC hash').setRequired(true).setMinLength(20).setMaxLength(200)
    ));
    await interaction.showModal(modal);
    return;
  }

  // ── menu_customer_paid_paypal ──
  if (interaction.isButton() && interaction.customId === 'menu_customer_paid_paypal') {
    const session = userSessions.get(interaction.user.id);
    if (!session) return interaction.reply({ content: '❌ Session expired.', ephemeral: true });
    session.paymentStatus = 'awaiting_verification';
    userSessions.set(interaction.user.id, session);
    const ownerRole = interaction.guild.roles.cache.find(r => r.name === OWNER_ROLE_NAME);
    const embed = new EmbedBuilder()
      .setTitle('💰 PayPal Payment Awaiting Verification')
      .setDescription(`${interaction.user} has confirmed payment of **${session.priceEur} EUR** via PayPal.\n\n**Games:** ${session.requestedGames}\n**Ticket:** #${session.number}`)
      .setColor(0xFEE75C).setTimestamp();
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`owner_confirm_paypal_${interaction.user.id}`).setLabel('✅ Confirm Payment').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`owner_deny_payment_${interaction.user.id}`).setLabel('❌ Deny Payment').setStyle(ButtonStyle.Danger)
    );
    await interaction.channel.send({ content: ownerRole ? `${ownerRole}` : '', embeds: [embed], components: [row] });
    // Aggiorna il menu ad "awaiting_payment_verification" — zero nuovi messaggi al cliente
    await updateMenu(interaction, 'awaiting_payment_verification');
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith('owner_confirm_paypal_')) {
    const ownerRole = interaction.guild.roles.cache.find(r => r.name === OWNER_ROLE_NAME);
    if (!interaction.member.roles.cache.has(ownerRole?.id)) return interaction.reply({ content: '❌ Only Owner can confirm.', ephemeral: true });
    const userId = interaction.customId.split('_')[3];
    const member = await interaction.guild.members.fetch(userId).catch(() => null);
    const session = userSessions.get(userId);
    if (session) {
      session.paymentStatus = 'completed';
      session.paymentConfirmedBy = interaction.user.id;
      session.paymentConfirmed = true;
      userSessions.set(userId, session);
    }
    clearPaymentTimer(userId);
    if (member) await assignVerifiedBuyerRole(interaction.guild, member);

    // Cancella il messaggio di verifica dalla chat
    await interaction.deferUpdate();
    await interaction.message.delete().catch(() => {});

    savePayment({ userId, method: 'PayPal', priceEur: session?.priceEur, games: session?.requestedGames, ticket: session?.number, confirmedBy: interaction.user.id });

    if (member) await sendDMReceipt(member.user, session, 'PayPal', interaction.user.id);

    const receiptChannel = interaction.guild.channels.cache.get(RECEIPT_CHANNEL_ID);
    if (receiptChannel && session) {
      await receiptChannel.send({ embeds: [new EmbedBuilder().setTitle('✅ PayPal Payment Confirmed').addFields(
        { name: '👤 Customer', value: `${member} (${userId})`, inline: true },
        { name: '🎫 Ticket', value: `#${session.number}`, inline: true },
        { name: '🎮 Game(s)', value: session.requestedGames || 'N/A', inline: false },
        { name: '💶 Price', value: `${session.priceEur} EUR`, inline: true },
        { name: '✅ Confirmed by', value: `<@${interaction.user.id}>`, inline: true },
      ).setColor(0x57F287).setTimestamp()] });
    }

    // Chiedi al cliente il metodo di login
    const ticketChannel = interaction.guild.channels.cache.get(session?.channelId);
    if (ticketChannel && session?.menuMessageId) {
      try {
        const menuMsg = await ticketChannel.messages.fetch(session.menuMessageId);
        const menuData = buildMenuStep('choose_login', session);
        await menuMsg.edit({ content: `<@${userId}> ✅ Payment confirmed! Please provide your login to receive the game.`, ...menuData });
      } catch {
        const menuData = buildMenuStep('choose_login', session);
        const msg = await ticketChannel.send({ content: `<@${userId}> ✅ Payment confirmed! Please provide your login to receive the game.`, ...menuData });
        if (session) { session.menuMessageId = msg.id; userSessions.set(userId, session); }
      }
    }
  }

  if (interaction.isButton() && interaction.customId.startsWith('owner_deny_payment_')) {
    const ownerRole = interaction.guild.roles.cache.find(r => r.name === OWNER_ROLE_NAME);
    if (!interaction.member.roles.cache.has(ownerRole?.id)) return interaction.reply({ content: '❌ Only Owner can deny.', ephemeral: true });
    const userId = interaction.customId.split('_')[3];
    const modal = new ModalBuilder().setCustomId(`modal_deny_reason_${userId}`).setTitle('Reason for denial');
    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('deny_reason').setLabel('Why deny?').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500)));
    await interaction.showModal(modal);
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_deny_reason_')) {
    const userId = interaction.customId.split('_')[3];
    const reason = interaction.fields.getTextInputValue('deny_reason');
    const user = await interaction.guild.members.fetch(userId).catch(() => null);
    const session = userSessions.get(userId);
    if (session) session.paymentStatus = 'denied';
    const embed = new EmbedBuilder().setTitle('❌ PayPal Payment Denied').setDescription(`${user}'s payment denied.\nReason: ${reason}`).setColor(0xED4245);
    const disabledRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('disabled').setLabel('❌ Denied').setStyle(ButtonStyle.Danger).setDisabled(true));
    await interaction.update({ embeds: [embed], components: [disabledRow] });
    await interaction.channel.send({ content: `${user}`, embeds: [new EmbedBuilder().setTitle('❌ Payment Not Confirmed').setDescription(`Your PayPal payment was denied.\nReason: ${reason}\nPlease contact staff.`).setColor(0xED4245)] });
  }

  // ── CRYPTO FLOW ──
  if (interaction.isButton() && interaction.customId === 'payment_crypto') {
    const embed = new EmbedBuilder().setTitle('🪙 Crypto Payment').setDescription('Select cryptocurrency:').setColor(0xF7931A);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('crypto_USDC').setLabel('💵 USDC').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('crypto_SOL').setLabel('◎ Solana').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('crypto_BTC').setLabel('₿ Bitcoin').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('crypto_ETH').setLabel('⟠ Ethereum').setStyle(ButtonStyle.Secondary)
    );
    await interaction.reply({ embeds: [embed], components: [row] });
  }

  if (interaction.isButton() && ['crypto_USDC', 'crypto_SOL', 'crypto_BTC', 'crypto_ETH'].includes(interaction.customId)) {
    const coin = interaction.customId.split('_')[1];
    const data = cryptoData[coin];
    const session = userSessions.get(interaction.user.id);
    if (!session?.priceEur) return interaction.reply({ content: '❌ Price not set.', ephemeral: true });
    session.selectedCoin = coin;
    const cryptoAmounts = await convertEurToCrypto(session.priceEur);
    if (!cryptoAmounts) return interaction.reply({ content: '❌ Exchange rate error.' });
    const amount = cryptoAmounts[coin];
    if (data.networks.length === 1) {
      const net = data.networks[0];
      session.selectedNetwork = net.name;
      userSessions.set(interaction.user.id, session);
      const embed = new EmbedBuilder()
        .setTitle(`${data.emoji} ${coin} — ${net.name}`)
        .setDescription(`**Amount to send:** ${amount} ${coin}\n**Address:**\n\`\`\`${net.address}\`\`\`\n🌐 Network: ${net.name}\n⏱️ Est. time: ${net.time}\n\n⚠️ Use the correct network!\n📌 After sending, click **"I Have Paid"** and enter your transaction hash.`)
        .setColor(0xF7931A);
      const btn = new ButtonBuilder().setCustomId('i_have_paid').setLabel('✅ I Have Paid').setStyle(ButtonStyle.Success);
      await interaction.reply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(btn)] });
    } else {
      const embed = new EmbedBuilder()
        .setTitle(`${data.emoji} ${coin} — Select Network`)
        .setDescription(`Amount: **${amount} ${coin}**`)
        .addFields(data.networks.map(n => ({ name: `🌐 ${n.name}`, value: `⏱️ ${n.time}`, inline: true })))
        .setColor(0xF7931A);
      const row = new ActionRowBuilder().addComponents(
        data.networks.map((n, i) => new ButtonBuilder().setCustomId(`network_${coin}_${i}`).setLabel(`🌐 ${n.name} — ${n.time}`).setStyle(ButtonStyle.Secondary))
      );
      await interaction.reply({ embeds: [embed], components: [row] });
    }
  }

  if (interaction.isButton() && interaction.customId.startsWith('network_')) {
    const parts = interaction.customId.split('_');
    const coin = parts[1];
    const index = parseInt(parts[2]);
    const data = cryptoData[coin];
    const net = data.networks[index];
    const session = userSessions.get(interaction.user.id);
    if (!session) return;
    session.selectedNetwork = net.name;
    userSessions.set(interaction.user.id, session);
    const cryptoAmounts = await convertEurToCrypto(session.priceEur);
    const amount = cryptoAmounts[coin];
    const embed = new EmbedBuilder()
      .setTitle(`${data.emoji} ${coin} — ${net.name}`)
      .setDescription(`**Amount to send:** ${amount} ${coin}\n**Address:**\n\`\`\`${net.address}\`\`\`\n⚠️ Use the **${net.name}** network.\n📌 After sending, click **"I Have Paid"** and enter your transaction hash.`)
      .setColor(0xF7931A);
    const btn = new ButtonBuilder().setCustomId('i_have_paid').setLabel('✅ I Have Paid').setStyle(ButtonStyle.Success);
    await interaction.reply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(btn)] });
  }

  if (interaction.isButton() && interaction.customId === 'i_have_paid') {
    const modal = new ModalBuilder().setCustomId('modal_payment_hash').setTitle('🔍 Enter Transaction Hash');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('tx_hash').setLabel('Transaction Hash').setStyle(TextInputStyle.Short)
        .setPlaceholder('0x... or Solana/BTC hash').setRequired(true).setMinLength(20).setMaxLength(200)
    ));
    await interaction.showModal(modal);
  }

  // MODIFICA: hash crypto → verifica manuale owner
  if (interaction.isModalSubmit() && interaction.customId === 'modal_payment_hash') {
    const hash = interaction.fields.getTextInputValue('tx_hash').trim();
    const session = userSessions.get(interaction.user.id);
    if (!session) return interaction.reply({ content: '❌ Session expired.', ephemeral: true });
    session.lastHash = hash;
    session.paymentStatus = 'awaiting_verification';
    userSessions.set(interaction.user.id, session);

    const ownerRole = interaction.guild.roles.cache.find(r => r.name === OWNER_ROLE_NAME);

    const ownerEmbed = new EmbedBuilder()
      .setTitle('🔍 Crypto Payment — Manual Verification Required')
      .setDescription('A customer has submitted a transaction hash. Please verify it manually.')
      .addFields(
        { name: '👤 Customer', value: `${interaction.user} (${interaction.user.id})`, inline: true },
        { name: '🎫 Ticket', value: `#${session.number || 'N/A'}`, inline: true },
        { name: '🎮 Game(s)', value: session.requestedGames || 'N/A', inline: false },
        { name: '💳 Coin', value: session.selectedCoin || 'N/A', inline: true },
        { name: '🌐 Network', value: session.selectedNetwork || 'N/A', inline: true },
        { name: '💶 Amount (EUR)', value: `${session.priceEur} EUR`, inline: true },
        { name: '🔗 Transaction Hash', value: `\`${hash}\``, inline: false },
      )
      .setColor(0xFEE75C).setThumbnail(interaction.user.displayAvatarURL()).setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`owner_confirm_crypto_${interaction.user.id}`).setLabel('✅ Confirm Payment').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`owner_deny_crypto_${interaction.user.id}`).setLabel('❌ Deny Payment').setStyle(ButtonStyle.Danger)
    );
    await interaction.channel.send({ content: ownerRole ? `${ownerRole}` : '', embeds: [ownerEmbed], components: [row] });

    // Aggiorna il menu a "awaiting verification" senza creare nuovi messaggi
    await interaction.deferUpdate().catch(() => interaction.reply({ content: '✅ Hash submitted!', ephemeral: true }));
    await editMenuMessage(interaction, interaction.user.id, 'awaiting_payment_verification');
  }

  // ── OWNER: conferma pagamento crypto ──
  if (interaction.isButton() && interaction.customId.startsWith('owner_confirm_crypto_')) {
    const ownerRole = interaction.guild.roles.cache.find(r => r.name === OWNER_ROLE_NAME);
    if (!interaction.member.roles.cache.has(ownerRole?.id)) return interaction.reply({ content: '❌ Only the Owner can confirm payments.', ephemeral: true });
    const userId = interaction.customId.split('_')[3];
    const member = await interaction.guild.members.fetch(userId).catch(() => null);
    const session = userSessions.get(userId);
    if (session) { session.paymentStatus = 'completed'; session.paymentConfirmed = true; session.paymentConfirmedBy = interaction.user.id; userSessions.set(userId, session); }
    clearPaymentTimer(userId);
    if (member) await assignVerifiedBuyerRole(interaction.guild, member);

    const confirmedEmbed = new EmbedBuilder()
      .setTitle('✅ Crypto Payment Confirmed')
      .setDescription(`${member}'s payment confirmed.\n\n💳 **Coin:** ${session?.selectedCoin}\n🌐 **Network:** ${session?.selectedNetwork}\n🔗 **Hash:** \`${session?.lastHash}\``)
      .setColor(0x57F287).setTimestamp();
    const disabledRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('disabled').setLabel('✅ Payment Confirmed').setStyle(ButtonStyle.Success).setDisabled(true));
    await interaction.update({ embeds: [confirmedEmbed], components: [disabledRow] });

    savePayment({ userId, method: session?.selectedCoin, priceEur: session?.priceEur, games: session?.requestedGames, ticket: session?.number, hash: session?.lastHash, confirmedBy: interaction.user.id });

    if (member) await sendDMReceipt(member.user, session, `${session?.selectedCoin} (${session?.selectedNetwork})`, interaction.user.id);

    const receiptChannel = interaction.guild.channels.cache.get(RECEIPT_CHANNEL_ID);
    if (receiptChannel && session) {
      await receiptChannel.send({ embeds: [new EmbedBuilder().setTitle('✅ Crypto Payment Confirmed').addFields(
        { name: '👤 Customer', value: `${member} (${userId})`, inline: true },
        { name: '🎫 Ticket', value: `#${session.number}`, inline: true },
        { name: '🎮 Game(s)', value: session.requestedGames || 'N/A', inline: false },
        { name: '💶 Price', value: `${session.priceEur} EUR`, inline: true },
        { name: '💳 Coin', value: session.selectedCoin || 'N/A', inline: true },
        { name: '🌐 Network', value: session.selectedNetwork || 'N/A', inline: true },
        { name: '🔗 Hash', value: `\`${session.lastHash}\``, inline: false },
        { name: '✅ Confirmed by', value: `<@${interaction.user.id}>`, inline: true },
      ).setColor(0x57F287).setTimestamp()] });
    }

    // Chiedi al cliente il metodo di login
    const ticketChannel = interaction.guild.channels.cache.get(session?.channelId);
    if (ticketChannel && session?.menuMessageId) {
      try {
        const menuMsg = await ticketChannel.messages.fetch(session.menuMessageId);
        const menuData = buildMenuStep('choose_login', session);
        await menuMsg.edit({ content: `<@${userId}> ✅ Payment confirmed! Please provide your login to receive the game.`, ...menuData });
      } catch {
        const menuData = buildMenuStep('choose_login', session);
        const msg = await ticketChannel.send({ content: `<@${userId}> ✅ Payment confirmed! Please provide your login to receive the game.`, ...menuData });
        if (session) { session.menuMessageId = msg.id; userSessions.set(userId, session); }
      }
    }
  }

  // ── OWNER: nega pagamento crypto ──
  if (interaction.isButton() && interaction.customId.startsWith('owner_deny_crypto_')) {
    const ownerRole = interaction.guild.roles.cache.find(r => r.name === OWNER_ROLE_NAME);
    if (!interaction.member.roles.cache.has(ownerRole?.id)) return interaction.reply({ content: '❌ Only the Owner can deny payments.', ephemeral: true });
    const userId = interaction.customId.split('_')[3];
    const modal = new ModalBuilder().setCustomId(`modal_deny_crypto_${userId}`).setTitle('❌ Reason for Denial');
    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('deny_reason').setLabel('Why is this payment being denied?').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500)));
    await interaction.showModal(modal);
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_deny_crypto_')) {
    const userId = interaction.customId.split('_')[3];
    const reason = interaction.fields.getTextInputValue('deny_reason');
    const user = await interaction.guild.members.fetch(userId).catch(() => null);
    const session = userSessions.get(userId);
    if (session) { session.paymentStatus = 'denied'; userSessions.set(userId, session); }
    const deniedEmbed = new EmbedBuilder().setTitle('❌ Crypto Payment Denied').setDescription(`${user}'s payment denied.\n**Reason:** ${reason}`).setColor(0xED4245).setTimestamp();
    const disabledRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('disabled').setLabel('❌ Payment Denied').setStyle(ButtonStyle.Danger).setDisabled(true));
    await interaction.update({ embeds: [deniedEmbed], components: [disabledRow] });
    // Ripristina il menu del cliente al passo "i_have_paid" per permettere retry
    if (session?.menuMessageId) {
      const ticketChannel = interaction.guild.channels.cache.get(session?.channelId);
      if (ticketChannel) {
        try {
          const menuMsg = await ticketChannel.messages.fetch(session.menuMessageId);
          const coin = session.selectedCoin;
          const data = cryptoData[coin];
          const net = data?.networks.find(n => n.name === session.selectedNetwork) || data?.networks[0];
          const cryptoAmounts = await convertEurToCrypto(session.priceEur);
          const retryEmbed = new EmbedBuilder()
            .setTitle('❌ Payment Denied — Retry')
            .setDescription(`Your **${coin}** payment was denied.\n**Reason:** ${reason}\n\nPlease submit a new transaction hash.`)
            .setColor(0xED4245);
          const retryRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('menu_i_have_paid').setLabel('🔄 Submit New Hash').setStyle(ButtonStyle.Primary)
          );
          await menuMsg.edit({ embeds: [retryEmbed], components: [retryRow], content: '' });
        } catch { }
      }
    }
  }

  // "Order Delivered" → invia review_prompt come nuovo messaggio sotto Order Summary
  if (interaction.isButton() && interaction.customId.startsWith('order_delivered_')) {
    const ownerRole = interaction.guild.roles.cache.find(r => r.name === OWNER_ROLE_NAME);
    if (!interaction.member.roles.cache.has(ownerRole?.id)) return interaction.reply({ content: '❌ Only the Owner can mark orders as delivered.', ephemeral: true });

    const userId = interaction.customId.split('_')[2];
    const session = userSessions.get(userId);

    const disabledRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('disabled').setLabel('✅ Order Delivered').setStyle(ButtonStyle.Success).setDisabled(true)
    );
    await interaction.update({ components: [disabledRow] });

    // Invia review_prompt come nuovo messaggio nel canale (sotto Order Summary)
    const ticketChannel = interaction.guild.channels.cache.get(session?.channelId);
    if (ticketChannel) {
      try {
        const customer = await interaction.guild.members.fetch(userId).catch(() => null);
        const menuData = buildMenuStep('review_prompt', session);
        const reviewMsg = await ticketChannel.send({ content: customer ? `${customer}` : '', ...menuData });
        // Aggiorna il menuMessageId alla nuova review prompt per gestire i bottoni
        if (session) {
          session.menuMessageId = reviewMsg.id;
          userSessions.set(userId, session);
        }
      } catch { }
    }

    await interaction.followUp({ content: '✅ Order marked as delivered. Customer has been notified.', ephemeral: true });
    return;
  }

  // ── REVIEW: menu_leave_review ──
  if (interaction.isButton() && interaction.customId === 'menu_leave_review') {
    const session = userSessions.get(interaction.user.id);
    if (!session) return interaction.reply({ content: '❌ Session expired.', ephemeral: true });
    if (!session.paymentConfirmed) return interaction.reply({ content: '❌ Payment not confirmed yet.', ephemeral: true });
    const modal = new ModalBuilder().setCustomId('modal_review_with_stars').setTitle('📝 Write your Review');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('review_text').setLabel('Your experience with our service')
          .setStyle(TextInputStyle.Paragraph).setPlaceholder('Share your experience with this purchase and our support...').setRequired(true).setMaxLength(1000)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('rating_stars').setLabel('Rating — Enter a number from 1 to 5')
          .setStyle(TextInputStyle.Short).setPlaceholder('Enter 1, 2, 3, 4 or 5').setRequired(true).setMinLength(1).setMaxLength(1)
      )
    );
    await interaction.showModal(modal);
    return;
  }

  // ── menu_skip_review ──
  if (interaction.isButton() && interaction.customId === 'menu_skip_review') {
    const session = userSessions.get(interaction.user.id);
    const channelId = session?.channelId || interaction.channelId;
    const channel = interaction.guild.channels.cache.get(channelId);
    await updateMenu(interaction, 'awaiting_payment_verification'); // congela il menu
    await closeTicket(interaction.guild, channel, interaction.user, session);
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId === 'modal_review_with_stars') {
    const reviewText = interaction.fields.getTextInputValue('review_text');
    const starsRaw = interaction.fields.getTextInputValue('rating_stars').trim();
    const stars = parseInt(starsRaw);

    if (isNaN(stars) || stars < 1 || stars > 5 || starsRaw.length !== 1) {
      return interaction.reply({
        content: '❌ **Invalid rating!** Please enter only a number between **1** and **5** (e.g., 1, 2, 3, 4 or 5).',
        ephemeral: true
      });
    }

    const session = userSessions.get(interaction.user.id);
    if (!session) return interaction.reply({ content: '❌ Session expired.' });
    session.text = reviewText;
    session.stars = stars;
    userSessions.set(interaction.user.id, session);

    const game = session.requestedGames || 'Unknown Game';

    // Congela il menu prima di procedere
    await interaction.deferUpdate().catch(() => interaction.reply({ content: '⏳ Publishing review...', ephemeral: true }));

    const starsLabel = ['', '⭐', '⭐⭐', '⭐⭐⭐', '⭐⭐⭐⭐', '⭐⭐⭐⭐⭐'];
    const colors = [null, 0xED4245, 0xE67E22, 0xFEE75C, 0x57F287, 0x00FF7F];
    const coverUrl = await getCoverImage(game.split('\n')[0]);
    const reviewChannel = interaction.guild.channels.cache.find(ch => ch.name === process.env.REVIEW_CHANNEL_NAME);
    if (!reviewChannel) return;

    allRatings.push(stars);
    const userId = interaction.user.id;
    const existing = purchasesPerUser.get(userId) || { userId, username: interaction.user.username, count: 0 };
    existing.count++;
    purchasesPerUser.set(userId, existing);

    const reasonConfig = session.reason === 'reason_purchase'
      ? { emoji: '🎮', fieldObj: '🎮 Game', fieldExp: '💬 Experience', footer: 'Purchase Review' }
      : { emoji: '❓', fieldObj: '📋 Issue', fieldExp: '💬 Support Experience', footer: 'Support Review' };

    const reviewEmbed = new EmbedBuilder()
      .setTitle(`✅ ${reasonConfig.emoji} ${game.split('\n')[0]}`)
      .addFields(
        { name: reasonConfig.fieldObj, value: game, inline: true },
        { name: '⭐ Rating', value: `${starsLabel[stars]} (${stars}/5)`, inline: true },
        { name: '👤 Reviewer', value: `${interaction.user}`, inline: true },
        { name: '🔖 Status', value: '✅ Verified Purchase', inline: true },
        { name: reasonConfig.fieldExp, value: reviewText, inline: false }
      )
      .setColor(colors[stars]).setThumbnail(interaction.user.displayAvatarURL()).setTimestamp()
      .setFooter({ text: `${reasonConfig.footer} • ${interaction.guild.name}` });
    if (coverUrl) reviewEmbed.setImage(coverUrl);
    await reviewChannel.send({ embeds: [reviewEmbed] });

    saveReview({ userId, game, text: reviewText, stars, reason: session.reason, ticket: session.number });

    const ticketChannel = interaction.guild.channels.cache.get(session.channelId || interaction.channelId);
    if (ticketChannel) {
      await sendTranscript(interaction.guild, ticketChannel, interaction.user, { game, text: reviewText, stars }, session?.openTime, session?.reason, session?.number);
      openTickets = Math.max(0, openTickets - 1);
      closedToday++;
      // Edita il messaggio della review prompt con avviso chiusura, invece di inviarne uno nuovo
      if (session?.menuMessageId) {
        try {
          const menuMsg = await ticketChannel.messages.fetch(session.menuMessageId);
          await menuMsg.edit({
            content: `✅ Thank you for your review! 🎉\n🔒 *This ticket will be closed automatically in 5 seconds...*`,
            embeds: [],
            components: []
          });
        } catch { }
      }
      setTimeout(async () => { try { await ticketChannel.delete(); } catch (err) { console.error(err.message); } }, 5000);
    }
    userSessions.delete(interaction.user.id);
    persistState();
    await updateRatingVoice(interaction.guild);
    await updateDashboard(interaction.guild);
    await updateTopBuyers(interaction.guild);
  }

  // ── BUTTON: close ticket — aggiorna il menu alla review_prompt ──
  if (interaction.isButton() && interaction.customId === 'close_ticket') {
    const session = userSessions.get(interaction.user.id) || {};
    session.channelId = session.channelId || interaction.channelId;
    session.menuMessageId = session.menuMessageId || interaction.message.id;
    userSessions.set(interaction.user.id, session);
    // Se il pagamento è confermato, mostra review prompt nel menu; altrimenti chiudi direttamente
    if (session.paymentConfirmed) {
      await updateMenu(interaction, 'review_prompt');
    } else {
      await updateMenu(interaction, 'awaiting_payment_verification');
      const channel = interaction.guild.channels.cache.get(session.channelId);
      await closeTicket(interaction.guild, channel, interaction.user, session);
    }
    return;
  }

  // Vecchio skip_review (fallback per eventuali messaggi rimasti) + menu_skip_review già gestito sopra
  if (interaction.isButton() && interaction.customId === 'skip_review') {
    const session = userSessions.get(interaction.user.id);
    const channelId = session?.channelId || interaction.channelId;
    const channel = interaction.guild.channels.cache.get(channelId);
    await interaction.update({ components: [] });
    await closeTicket(interaction.guild, channel, interaction.user, session);
    return;
  }

  // ── REOPEN TICKET ──
  if (interaction.isButton() && interaction.customId.startsWith('reopen_ticket_')) {
    const parts = interaction.customId.split('_');
    const userId = parts[2];
    const number = parts[parts.length - 1];
    const reason = parts.slice(3, parts.length - 1).join('_');
    const guild = interaction.guild;
    let user;
    try { user = (await guild.members.fetch(userId)).user; } catch { return interaction.reply({ content: '❌ User not found.', ephemeral: true }); }
    const channelName = reason === 'reason_support' ? `support-ticket-${number}` : `ticket-${number}`;
    const existing = guild.channels.cache.find(ch => ch.name === channelName);
    if (existing) return interaction.reply({ content: `❌ Ticket #${number} already open! <#${existing.id}>`, ephemeral: true });
    openTickets++;
    const { channel, openTime, rulesMsgId } = await createTicketChannel(guild, user, reason, number);
    userSessions.set(user.id, {
      type: 'ticket', channelId: channel.id, reason, number, openTime, rulesMsgId,
      rulesAccepted: false, requestedGames: null, usernameEmail: null, password: null,
      loginMethod: null, loginConfirmed: false, selectedCoin: null, selectedNetwork: null,
      lastHash: null, text: null, stars: 0, paymentStatus: 'pending', priceEur: null, paymentConfirmed: false
    });
    persistState();
    await updateDashboard(guild);
    const newRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`reopen_ticket_${userId}_${reason}_${number}`).setLabel('✅ Ticket Reopened').setStyle(ButtonStyle.Success).setDisabled(true)
    );
    await interaction.message.edit({ components: [newRow] });
    await interaction.reply({ content: `✅ Ticket #${number} reopened! <#${channel.id}>`, ephemeral: true });
  }

  // ── MANUAL REVIEW ──
  if (interaction.isButton() && interaction.customId === 'open_review') {
    if (blacklist.has(interaction.user.id)) return interaction.reply({ content: '🚫 You are blacklisted.', ephemeral: true });
    const { guild, user } = interaction;
    const existing = guild.channels.cache.find(ch => ch.name === `review-${user.username.toLowerCase().replace(/[^a-z0-9]/g, '')}`);
    if (existing) return interaction.reply({ content: `❌ You already have an open review channel! <#${existing.id}>`, ephemeral: true });
    const channel = await guild.channels.create({
      name: `review-${user.username.toLowerCase().replace(/[^a-z0-9]/g, '')}`,
      type: ChannelType.GuildText, parent: CATEGORY_ID,
      permissionOverwrites: [
        { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
        { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels] },
      ]
    });
    userSessions.set(user.id, { type: 'review', game: null, text: null, stars: 0, channelId: channel.id });
    await interaction.reply({ content: `✅ Your review channel is ready! Go to <#${channel.id}>`, ephemeral: true });
    const embed = new EmbedBuilder()
      .setTitle('📝 Write your Review')
      .setDescription(`Welcome ${user}! 👋\n\nPlease fill in the form.\n\n**Please include:**\n1. 🎮 Game purchased\n2. 💬 Your experience\n3. ⭐ Rating (1-5)\n\n*Channel will be deleted after submission.*`)
      .setColor(0x5865F2);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('open_review_form_manual').setLabel('📝 Fill Review Form').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('cancel_review').setLabel('🗑️ Cancel').setStyle(ButtonStyle.Danger)
    );
    await channel.send({ embeds: [embed], components: [row] });
  }

  if (interaction.isButton() && interaction.customId === 'open_review_form_manual') {
    const modal = new ModalBuilder().setCustomId('modal_review_manual').setTitle('📝 Write your Review');
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('game_name').setLabel('Game purchased').setStyle(TextInputStyle.Short).setPlaceholder('E.g., Elden Ring').setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('review_text').setLabel('Your experience').setStyle(TextInputStyle.Paragraph).setPlaceholder('Share your experience...').setRequired(true).setMaxLength(1000)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('rating_stars').setLabel('Rating — Enter a number from 1 to 5').setStyle(TextInputStyle.Short).setPlaceholder('Enter 1, 2, 3, 4 or 5').setRequired(true).setMinLength(1).setMaxLength(1))
    );
    await interaction.showModal(modal);
  }

  if (interaction.isModalSubmit() && interaction.customId === 'modal_review_manual') {
    const game = interaction.fields.getTextInputValue('game_name');
    const text = interaction.fields.getTextInputValue('review_text');
    const starsRaw = interaction.fields.getTextInputValue('rating_stars').trim();
    const stars = parseInt(starsRaw);

    // MODIFICA 5: validazione
    if (isNaN(stars) || stars < 1 || stars > 5 || starsRaw.length !== 1) {
      return interaction.reply({ content: '❌ **Invalid rating!** Please enter only a number between **1** and **5**.', ephemeral: true });
    }

    const session = userSessions.get(interaction.user.id) || {};
    session.game = game; session.text = text; session.stars = stars;
    userSessions.set(interaction.user.id, session);
    await interaction.reply({ content: 'Publishing your review...', ephemeral: true });
    const starsLabel = ['', '⭐', '⭐⭐', '⭐⭐⭐', '⭐⭐⭐⭐', '⭐⭐⭐⭐⭐'];
    const colors = [null, 0xED4245, 0xE67E22, 0xFEE75C, 0x57F287, 0x00FF7F];
    const coverUrl = await getCoverImage(game);
    const reviewChannel = interaction.guild.channels.cache.find(ch => ch.name === process.env.REVIEW_CHANNEL_NAME);
    if (!reviewChannel) return interaction.editReply({ content: '❌ Review channel not found!' });
    allRatings.push(stars);
    const userId = interaction.user.id;
    const existing = purchasesPerUser.get(userId) || { userId, username: interaction.user.username, count: 0 };
    existing.count++;
    purchasesPerUser.set(userId, existing);
    const reviewEmbed = new EmbedBuilder()
      .setTitle(`📝 ${game}`)
      .addFields(
        { name: '🎮 Game', value: game, inline: true },
        { name: '⭐ Rating', value: `${starsLabel[stars]} (${stars}/5)`, inline: true },
        { name: '👤 Reviewer', value: `${interaction.user}`, inline: true },
        { name: '🔖 Status', value: '📝 Unverified', inline: true },
        { name: '💬 Experience', value: text, inline: false }
      )
      .setColor(colors[stars]).setThumbnail(interaction.user.displayAvatarURL()).setTimestamp()
      .setFooter({ text: `Manual Review • ${interaction.guild.name}` });
    if (coverUrl) reviewEmbed.setImage(coverUrl);
    await reviewChannel.send({ embeds: [reviewEmbed] });
    saveReview({ userId, game, text, stars, reason: 'manual' });
    const reviewChannelObj = interaction.guild.channels.cache.get(session.channelId);
    if (reviewChannelObj) {
      await reviewChannelObj.send({ content: `✅ Thank you ${interaction.user}! Your review has been posted.\n\n🗑️ *This channel will be deleted in 5 seconds...*` });
      setTimeout(async () => { try { await reviewChannelObj.delete(); } catch (err) { console.error(err.message); } }, 5000);
    }
    userSessions.delete(interaction.user.id);
    persistState();
    await updateRatingVoice(interaction.guild);
    await updateDashboard(interaction.guild);
    await updateTopBuyers(interaction.guild);
    await interaction.editReply({ content: '✅ Review published!' });
  }

  if (interaction.isButton() && interaction.customId === 'cancel_review') {
    const session = userSessions.get(interaction.user.id);
    const channelId = session?.channelId || interaction.channelId;
    const channel = interaction.guild.channels.cache.get(channelId);
    await interaction.reply({ content: '🗑️ Review cancelled. Channel will be deleted.' });
    if (channel) await sendTranscript(interaction.guild, channel, interaction.user, null, session?.openTime, session?.reason, session?.number);
    userSessions.delete(interaction.user.id);
    setTimeout(async () => { try { if (channel) await channel.delete(); } catch (err) { console.error(err.message); } }, 5000);
  }

  } catch (err) {
    console.error('Interaction error:', err);
    try {
      const msg = { content: '❌ An error occurred. Please try again.', ephemeral: true };
      if (interaction.replied || interaction.deferred) await interaction.followUp(msg);
      else await interaction.reply(msg);
    } catch { }
  }
});

client.login(process.env.TOKEN);
