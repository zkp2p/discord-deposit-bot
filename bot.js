require('dotenv').config();
const { WebSocketProvider, Interface } = require('ethers');

// ============================================
// DISCORD WEBHOOK CONFIGURATION
// ============================================
const DISCORD_WEBHOOKS = {
  venmo: process.env.DISCORD_WEBHOOK_VENMO,
  revolut: process.env.DISCORD_WEBHOOK_REVOLUT,
  wise: process.env.DISCORD_WEBHOOK_WISE,
  cashapp: process.env.DISCORD_WEBHOOK_CASHAPP,
  zelle: process.env.DISCORD_WEBHOOK_ZELLE,
  paypal: process.env.DISCORD_WEBHOOK_PAYPAL,
  monzo: process.env.DISCORD_WEBHOOK_MONZO,
  'mercado pago': process.env.DISCORD_WEBHOOK_MERCADOPAGO
};

// ============================================
// DEDUPLICATION & STATE TRACKING
// ============================================

// Level 1: Track processed events by txHash:logIndex (prevents WebSocket replays)
const processedEvents = new Set();

// Level 2: Track deposit base info (depositId -> {amount, depositor, contractAddress})
const depositBaseInfo = new Map();

// Level 3: Track pending posts PER PLATFORM (key: "depositId:platform" -> {currencies, postTimeout})
// This allows ONE deposit to post to MULTIPLE platform channels
const pendingPlatformPosts = new Map();

// Level 4: Track posted deposits by "depositId:platform" (final safety net)
const postedDeposits = new Set();

// Cleanup old entries periodically (prevent memory leak)
setInterval(() => {
  if (processedEvents.size > 10000) {
    console.log('🧹 Clearing processedEvents cache');
    processedEvents.clear();
  }
  if (postedDeposits.size > 10000) {
    console.log('🧹 Clearing postedDeposits cache');
    postedDeposits.clear();
  }
  // Clean up old base info (older than 5 minutes)
  const fiveMinutesAgo = Date.now() - 300000;
  for (const [id, info] of depositBaseInfo) {
    if (info.timestamp < fiveMinutesAgo) {
      depositBaseInfo.delete(id);
    }
  }
}, 3600000);

// ============================================
// PLATFORM & CURRENCY MAPPINGS
// ============================================

const platformMapping = {
  // Verifier addresses (Escrow v1)
  '0x76d33a33068d86016b806df02376ddbb23dd3703': { platform: 'cashapp' },
  '0x9a733b55a875d0db4915c6b36350b24f8ab99df5': { platform: 'venmo' },
  '0xaa5a1b62b01781e789c900d616300717cd9a41ab': { platform: 'revolut' },
  '0xff0149799631d7a5bde2e7ea9b306c42b3d9a9ca': { platform: 'wise' },
  '0x03d17e9371c858072e171276979f6b44571c5dea': { platform: 'paypal' },
  '0x0de46433bd251027f73ed8f28e01ef05da36a2e0': { platform: 'monzo' },
  '0xf2ac5be14f32cbe6a613cff8931d95460d6c33a3': { platform: 'mercado pago' },
  '0x431a078a5029146aab239c768a615cd484519af7': { platform: 'zelle' },
  // Payment method hashes (v2/v3)
  '0x90262a3db0edd0be2369c6b28f9e8511ec0bac7136cefbada0880602f87e7268': { platform: 'venmo' },
  '0x617f88ab82b5c1b014c539f7e75121427f0bb50a4c58b187a238531e7d58605d': { platform: 'revolut' },
  '0x10940ee67cfb3c6c064569ec92c0ee934cd7afa18dd2ca2d6a2254fcb009c17d': { platform: 'cashapp' },
  '0x554a007c2217df766b977723b276671aee5ebb4adaea0edb6433c88b3e61dac5': { platform: 'wise' },
  '0xa5418819c024239299ea32e09defae8ec412c03e58f5c75f1b2fe84c857f5483': { platform: 'mercado pago' },
  '0x817260692b75e93c7fbc51c71637d4075a975e221e1ebc1abeddfabd731fd90d': { platform: 'zelle' },
  '0x6aa1d1401e79ad0549dced8b1b96fb72c41cd02b32a7d9ea1fed54ba9e17152e': { platform: 'zelle' },
  '0x4bc42b322a3ad413b91b2fde30549ca70d6ee900eded1681de91aaf32ffd7ab5': { platform: 'zelle' },
  '0x3ccc3d4d5e769b1f82dc4988485551dc0cd3c7a3926d7d8a4dde91507199490f': { platform: 'paypal' },
  '0x62c7ed738ad3e7618111348af32691b5767777fbaf46a2d8943237625552645c': { platform: 'monzo' }
};

const currencyHashToCode = {
  '0x4dab77a640748de8588de6834d814a344372b205265984b969f3e97060955bfa': 'AED',
  '0x8fd50654b7dd2dc839f7cab32800ba0c6f7f66e1ccf89b21c09405469c2175ec': 'ARS',
  '0xcb83cbb58eaa5007af6cad99939e4581c1e1b50d65609c30f303983301524ef3': 'AUD',
  '0x221012e06ebf59a20b82e3003cf5d05ee973d9008bdb6e2f604faa89a27235522': 'CAD',
  '0xc9d84274fd58aa177cabff54611546051b74ad658b939babaad6282500300d36': 'CHF',
  '0xfaaa9c7b2f09d6a1b0971574d43ca62c3e40723167c09830ec33f06cec921381': 'CNY',
  '0xd783b199124f01e5d0dde2b7fc01b925e699caea84eae3ca92ed17377f498e97': 'CZK',
  '0x5ce3aa5f4510edaea40373cbe83c091980b5c92179243fe926cb280ff07d403e': 'DKK',
  '0xfff16d60be267153303bbfa66e593fb8d06e24ea5ef24b6acca5224c2ca6b907': 'EUR',
  '0x90832e2dc3221e4d56977c1aa8f6a6706b9ad6542fbbdaac13097d0fa5e42e67': 'GBP',
  '0xa156dad863111eeb529c4b3a2a30ad40e6dcff3b27d8f282f82996e58eee7e7d': 'HKD',
  '0x7766ee347dd7c4a6d5a55342d89e8848774567bcf7a5f59c3e82025dbde3babb': 'HUF',
  '0xc681c4652bae8bd4b59bec1cdb90f868d93cc9896af9862b196843f54bf254b3': 'IDR',
  '0x313eda7ae1b79890307d32a78ed869290aeb24cc0e8605157d7e7f5a69fea425': 'ILS',
  '0xaad766fbc07fb357bed9fd8b03b935f2f71fe29fc48f08274bc2a01d7f642afc': 'INR',
  '0xfe13aafd831cb225dfce3f6431b34b5b17426b6bff4fccabe4bbe0fe4adc0452': 'JPY',
  '0x589be49821419c9c2fbb26087748bf3420a5c13b45349828f5cac24c58bbaa7b': 'KES',
  '0xa94b0702860cb929d0ee0c60504dd565775a058bf1d2a2df074c1db0a66ad582': 'MXN',
  '0xf20379023279e1d79243d2c491be8632c07cfb116be9d8194013fb4739461b84': 'MYR',
  '0x8fb505ed75d9d38475c70bac2c3ea62d45335173a71b2e4936bd9f05bf0ddfea': 'NOK',
  '0xdbd9d34f382e9f6ae078447a655e0816927c7c3edec70bd107de1d34cb15172e': 'NZD',
  '0xe6c11ead4ee5ff5174861adb55f3e8fb2841cca69bf2612a222d3e8317b6ae06': 'PHP',
  '0x9a788fb083188ba1dfb938605bc4ce3579d2e085989490aca8f73b23214b7c1d': 'PLN',
  '0x2dd272ddce846149d92496b4c3e677504aec8d5e6aab5908b25c9fe0a797e25f': 'RON',
  '0xf998cbeba8b7a7e91d4c469e5fb370cdfa16bd50aea760435dc346008d78ed1f': 'SAR',
  '0x8895743a31faedaa74150e89d06d281990a1909688b82906f0eb858b37f82190': 'SEK',
  '0xc241cc1f9752d2d53d1ab67189223a3f330e48b75f73ebf86f50b2c78fe8df88': 'SGD',
  '0x326a6608c2a353275bd8d64db53a9d772c1d9a5bc8bfd19dfc8242274d1e9dd4': 'THB',
  '0x128d6c262d1afe2351c6e93ceea68e00992708cfcbc0688408b9a23c0c543db2': 'TRY',
  '0xc4ae21aac0c6549d71dd96035b7e0bdb6c79ebdba8891b666115bc976d16a29e': 'USD',
  '0xe85548baf0a6732cfcc7fc016ce4fd35ce0a1877057cfec6e166af4f106a3728': 'VND',
  '0x53611f0b3535a2cfc4b8deb57fa961ca36c7b2c272dfe4cb239a29c48e549361': 'ZAR'
};

// ============================================
// HELPER FUNCTIONS
// ============================================

const getPlatformName = (identifier) => {
  const mapping = platformMapping[identifier.toLowerCase()];
  return mapping ? mapping.platform : 'unknown';
};

const getPlatformEmoji = (platform) => {
  const emojis = {
    venmo: '💜', revolut: '🔵', wise: '💚', cashapp: '💵',
    zelle: '💸', paypal: '🅿️', monzo: '🔴', 'mercado pago': '💙', unknown: '❓'
  };
  return emojis[platform] || '📦';
};

const getPlatformColor = (platform) => {
  const colors = {
    venmo: 0x008CFF, revolut: 0x0075EB, wise: 0x9FE870, cashapp: 0x00D632,
    zelle: 0x6D1ED4, paypal: 0x003087, monzo: 0xFF5A5F, 'mercado pago': 0x009EE3, unknown: 0x808080
  };
  return colors[platform] || 0x808080;
};

const formatUSDC = (amount) => (Number(amount) / 1e6).toFixed(2);
const getFiatCode = (hash) => currencyHashToCode[hash.toLowerCase()] || 'UNKNOWN';
const formatConversionRate = (conversionRate, fiatCode) => {
  return `${(Number(conversionRate) / 1e18).toFixed(6)} ${fiatCode}/USDC`;
};
const depositLink = (contractAddress, id) => `https://www.zkp2p.xyz/deposit/${contractAddress}/${id}`;

// ============================================
// DISCORD POSTING
// ============================================

async function postToDiscord({ webhookUrl, embeds, components }) {
  if (!webhookUrl) return;

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds, components })
    });

    if (res.status === 429) {
      const j = await res.json().catch(() => ({}));
      const retryMs = Math.ceil((j.retry_after || 1) * 1000);
      console.log(`⏳ Rate limited, retrying in ${retryMs}ms`);
      await new Promise(r => setTimeout(r, retryMs));
      return postToDiscord({ webhookUrl, embeds, components });
    }

    if (!res.ok) {
      console.error('❌ Discord error:', res.status, await res.text().catch(() => ''));
    }
  } catch (error) {
    console.error('❌ Discord post failed:', error.message);
  }
}

function createDepositEmbed(depositInfo) {
  const { depositId, platform, amount, currencies, depositor, contractAddress } = depositInfo;
  
  const platformEmoji = getPlatformEmoji(platform);
  const platformTitle = platform.charAt(0).toUpperCase() + platform.slice(1);
  const depositUrl = depositLink(contractAddress, depositId);
  
  const currencyFields = currencies.map(c => ({
    name: `💱 ${c.currency}`,
    value: `Rate: \`${c.rate}\``,
    inline: true
  }));

  return {
    title: `${platformEmoji} New ${platformTitle} Deposit #${depositId}`,
    color: getPlatformColor(platform),
    fields: [
      { name: '💰 Amount', value: `\`${formatUSDC(amount)} USDC\``, inline: true },
      { name: '🏦 Platform', value: `\`${platformTitle}\``, inline: true },
      ...currencyFields,
      { name: '👤 Depositor', value: `\`${depositor.slice(0, 6)}...${depositor.slice(-4)}\``, inline: true },
      { name: '🔗 Link', value: `[Fill Deposit](${depositUrl})`, inline: false }
    ],
    timestamp: new Date().toISOString(),
    footer: { text: 'ZKP2P Deposit Monitor' }
  };
}

// ============================================
// POSTING LOGIC - PER PLATFORM
// ============================================

function postPlatformDeposit(depositId, platform) {
  const postKey = `${depositId}:${platform}`;
  const pending = pendingPlatformPosts.get(postKey);
  
  console.log(`\n🚀 [Post] Attempting to post ${postKey}`);
  
  if (!pending) {
    console.log(`   ❌ No pending data for ${postKey}`);
    return;
  }
  
  console.log(`   📋 Currencies in this pending: [${pending.currencies.map(c => c.currency).join(', ')}]`);
  
  // Clear timeout
  if (pending.postTimeout) {
    clearTimeout(pending.postTimeout);
    pending.postTimeout = null;
  }
  
  // Check if already posted (Level 4 dedup)
  if (postedDeposits.has(postKey)) {
    console.log(`   ❌ Already in postedDeposits, skipping`);
    pendingPlatformPosts.delete(postKey);
    return;
  }
  
  // Mark as posted SYNCHRONOUSLY
  postedDeposits.add(postKey);
  pendingPlatformPosts.delete(postKey);
  
  const webhookUrl = DISCORD_WEBHOOKS[platform];
  if (!webhookUrl) {
    console.log(`   ❌ No webhook for ${platform}`);
    return;
  }
  
  // Get base deposit info
  const baseInfo = depositBaseInfo.get(depositId) || {
    amount: 0,
    depositor: '0x0000000000000000000000000000000000000000',
    contractAddress: escrowV3ContractAddress
  };
  
  console.log(`   ✅ Posting to ${platform}: ${pending.currencies.length} currencies, ${formatUSDC(baseInfo.amount)} USDC`);
  
  const embed = createDepositEmbed({
    depositId,
    platform,
    amount: baseInfo.amount,
    currencies: pending.currencies,
    depositor: baseInfo.depositor,
    contractAddress: baseInfo.contractAddress
  });
  
  const components = [{
    type: 1,
    components: [{
      type: 2,
      style: 5,
      label: `🔗 Fill Deposit #${depositId}`,
      url: depositLink(baseInfo.contractAddress, depositId)
    }]
  }];
  
  postToDiscord({ webhookUrl, embeds: [embed], components });
}

function schedulePlatformPost(depositId, platform, delayMs) {
  const postKey = `${depositId}:${platform}`;
  
  // Check if already posted
  if (postedDeposits.has(postKey)) {
    console.log(`   ⏰ Not scheduling ${postKey} - already posted`);
    return;
  }
  
  let pending = pendingPlatformPosts.get(postKey);
  if (!pending) {
    console.log(`   ⏰ Warning: no pending entry for ${postKey} in schedule`);
    pending = { currencies: [], postTimeout: null };
    pendingPlatformPosts.set(postKey, pending);
  }
  
  // Clear existing timeout
  if (pending.postTimeout) {
    clearTimeout(pending.postTimeout);
    console.log(`   ⏰ Cleared existing timer for ${postKey}`);
  }
  
  // Schedule new post
  pending.postTimeout = setTimeout(() => postPlatformDeposit(depositId, platform), delayMs);
  console.log(`   ⏰ Scheduled ${postKey} to post in ${delayMs}ms`);
}

// ============================================
// CONTRACT CONFIG
// ============================================

const escrowV3ContractAddress = '0x2f121cddca6d652f35e8b3e560f9760898888888';

const escrowV3Abi = [
  `event DepositReceived(uint256 indexed depositId, address indexed depositor, address indexed token, uint256 amount, tuple(uint256,uint256) intentAmountRange, address delegate, address intentGuardian)`,
  `event DepositCurrencyAdded(uint256 indexed depositId, bytes32 indexed paymentMethod, bytes32 indexed currency, uint256 minConversionRate)`
];

const escrowV3Iface = new Interface(escrowV3Abi);

// ============================================
// RESILIENT WEBSOCKET PROVIDER
// ============================================

class ResilientWebSocketProvider {
  constructor(url, contractAddress, eventHandler, name = 'Provider') {
    this.url = url;
    this.contractAddress = contractAddress;
    this.eventHandler = eventHandler;
    this.name = name;
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 30000;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 50;
    this.isConnecting = false;
    this.isDestroyed = false;
    this.provider = null;
    this.reconnectTimer = null;
    this.keepAliveTimer = null;
    this.lastActivityTime = Date.now();
    this.connect();
  }

  async connect() {
    if (this.isConnecting || this.isDestroyed) return;
    this.isConnecting = true;

    try {
      console.log(`🔌 [${this.name}] Connecting (attempt ${this.reconnectAttempts + 1})...`);
      if (this.provider) await this.cleanup();

      this.provider = new WebSocketProvider(this.url);
      this.setupEventListeners();
      
      await Promise.race([
        this.provider.getNetwork(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout')), 15000))
      ]);
      
      console.log(`✅ [${this.name}] Connected`);
      this.lastActivityTime = Date.now();
      this.reconnectAttempts = 0;
      this.isConnecting = false;
      this.setupContractListening();
      this.startKeepAlive();
    } catch (error) {
      console.error(`❌ [${this.name}] Connection failed:`, error.message);
      this.isConnecting = false;
      if (!this.isDestroyed) this.scheduleReconnect();
    }
  }

  async cleanup() {
    if (!this.provider) return;
    try {
      this.stopKeepAlive();
      this.provider.removeAllListeners();
      if (this.provider._websocket) {
        this.provider._websocket.removeAllListeners();
        if (this.provider._websocket.readyState === 1) {
          this.provider._websocket.close(1000);
        }
      }
      if (typeof this.provider.destroy === 'function') await this.provider.destroy();
    } catch (e) { /* ignore */ }
  }

  setupEventListeners() {
    if (!this.provider?._websocket || this.isDestroyed) return;
    
    this.provider._websocket.on('close', () => {
      this.stopKeepAlive();
      if (!this.isDestroyed) setTimeout(() => this.scheduleReconnect(), 2000);
    });
    this.provider._websocket.on('error', () => {
      this.stopKeepAlive();
      if (!this.isDestroyed) this.scheduleReconnect();
    });
    this.provider._websocket.on('ping', (d) => { this.lastActivityTime = Date.now(); this.provider._websocket.pong(d); });
    this.provider._websocket.on('pong', () => { this.lastActivityTime = Date.now(); });
    this.provider._websocket.on('message', () => { this.lastActivityTime = Date.now(); });
    this.provider.on('error', () => { if (!this.isDestroyed) this.scheduleReconnect(); });
  }

  startKeepAlive() {
    this.stopKeepAlive();
    this.keepAliveTimer = setInterval(() => {
      if (this.provider?._websocket?.readyState === 1) {
        try {
          this.provider._websocket.ping();
          if (Date.now() - this.lastActivityTime > 90000) this.scheduleReconnect();
        } catch { this.scheduleReconnect(); }
      }
    }, 30000);
  }

  stopKeepAlive() {
    if (this.keepAliveTimer) { clearInterval(this.keepAliveTimer); this.keepAliveTimer = null; }
  }

  setupContractListening() {
    if (!this.provider || this.isDestroyed) return;
    try {
      this.provider.on({ address: this.contractAddress.toLowerCase() }, (log) => {
        this.lastActivityTime = Date.now();
        this.eventHandler(log);
      });
      console.log(`👂 [${this.name}] Listening on: ${this.contractAddress}`);
    } catch (e) {
      if (!this.isDestroyed) this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    if (this.isConnecting || this.isDestroyed) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopKeepAlive();
    this.reconnectAttempts++;
    if (this.reconnectAttempts > this.maxReconnectAttempts) {
      console.error(`💀 [${this.name}] Max reconnects reached`);
      return;
    }
    const delay = Math.min(this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts), this.maxReconnectDelay);
    console.log(`⏰ [${this.name}] Reconnecting in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => { if (!this.isDestroyed) this.connect(); }, delay);
  }

  async restart() {
    this.reconnectAttempts = 0;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopKeepAlive();
    await this.cleanup();
    setTimeout(() => { if (!this.isDestroyed) this.connect(); }, 3000);
  }

  async destroy() {
    this.isDestroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopKeepAlive();
    await this.cleanup();
  }

  get isConnected() {
    return this.provider?._websocket?.readyState === 1 && (Date.now() - this.lastActivityTime) < 120000;
  }
}

// ============================================
// EVENT HANDLER
// ============================================

const handleEscrowV3Event = (log) => {
  if (log.address.toLowerCase() !== escrowV3ContractAddress.toLowerCase()) return;

  // LEVEL 1: Event-level deduplication
  const eventKey = `${log.transactionHash}:${log.index}`;
  if (processedEvents.has(eventKey)) {
    console.log(`⚠️ [Event] Duplicate ${eventKey}`);
    return;
  }
  processedEvents.add(eventKey);

  try {
    const parsed = escrowV3Iface.parseLog({ data: log.data, topics: log.topics });
    if (!parsed) return;

    if (parsed.name === 'DepositReceived') {
      const { depositId, depositor, amount } = parsed.args;
      const id = Number(depositId);
      
      console.log(`💰 [v3] DepositReceived #${id} - ${formatUSDC(amount)} USDC`);
      
      // Store base deposit info (shared across all platforms)
      depositBaseInfo.set(id, {
        amount: Number(amount),
        depositor,
        contractAddress: escrowV3ContractAddress,
        timestamp: Date.now()
      });
      
      // Note: We don't schedule posts here - we wait for DepositCurrencyAdded
      // to know which platforms this deposit supports
    }

    if (parsed.name === 'DepositCurrencyAdded') {
      const { depositId, paymentMethod, currency, minConversionRate } = parsed.args;
      const id = Number(depositId);
      const fiatCode = getFiatCode(currency);
      const platform = getPlatformName(paymentMethod);
      const rate = formatConversionRate(minConversionRate, fiatCode);
      
      const postKey = `${id}:${platform}`;
      console.log(`💱 [v3] Currency: #${id} | platform=${platform} | currency=${fiatCode} | key=${postKey}`);
      console.log(`   paymentMethod hash: ${paymentMethod}`);
      
      // Check if already posted to this platform
      if (postedDeposits.has(postKey)) {
        console.log(`   ⚠️ Already posted ${postKey}, skipping`);
        return;
      }
      
      // Get or create pending entry for this deposit+platform combo
      let pending = pendingPlatformPosts.get(postKey);
      if (!pending) {
        console.log(`   📦 Creating NEW pending entry for ${postKey}`);
        pending = { currencies: [], postTimeout: null };
        pendingPlatformPosts.set(postKey, pending);
      } else {
        console.log(`   📦 Using EXISTING pending entry for ${postKey} (has ${pending.currencies.length} currencies)`);
      }
      
      // Add currency if not duplicate
      if (!pending.currencies.some(c => c.currency === fiatCode)) {
        pending.currencies.push({ currency: fiatCode, rate });
        console.log(`   ✅ Added ${fiatCode} → ${postKey} now has: [${pending.currencies.map(c => c.currency).join(', ')}]`);
      } else {
        console.log(`   ⚠️ ${fiatCode} already in ${postKey}, skipping`);
      }
      
      // Schedule post with 5s delay to batch multiple currencies for same platform
      schedulePlatformPost(id, platform, 5000);
    }
  } catch { /* ignore parse errors */ }
};

// ============================================
// INIT
// ============================================

console.log('🤖 ZKP2P Discord Bot Starting...');
console.log(`📡 Escrow v3: ${escrowV3ContractAddress}`);

const configuredWebhooks = Object.entries(DISCORD_WEBHOOKS).filter(([_, url]) => url).map(([name]) => name);
console.log(`📢 Channels: ${configuredWebhooks.join(', ') || 'NONE'}`);

const escrowV3Provider = new ResilientWebSocketProvider(
  process.env.BASE_RPC,
  escrowV3ContractAddress,
  handleEscrowV3Event,
  'Escrow-v3'
);

console.log('✅ Bot Started!');

// Graceful shutdown
const shutdown = async (sig) => {
  console.log(`🔄 ${sig}, shutting down...`);
  await escrowV3Provider?.destroy();
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (e) => { console.error('❌', e); escrowV3Provider?.restart(); });
process.on('unhandledRejection', (r) => console.error('❌ Rejection:', r));

// Health check
setInterval(() => {
  if (escrowV3Provider && !escrowV3Provider.isConnected) {
    console.log('🔍 Health check: reconnecting...');
    escrowV3Provider.restart();
  }
}, 120000);