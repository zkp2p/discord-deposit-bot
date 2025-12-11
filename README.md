# ZKP2P Discord Deposit Monitor

A Discord bot that monitors ZKP2P deposits on Base and posts them to platform-specific channels.

## Features

- 🔔 Real-time deposit notifications
- 📊 Shows amount, platform, currencies, and exchange rates
- 🎯 Posts to platform-specific Discord channels (Wise, Revolut, Venmo, etc.)
- 🔗 Direct links to fill deposits
- 💪 Auto-reconnect WebSocket connections

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Create Discord Webhooks

For each platform channel you want:
1. Go to your Discord server
2. Server Settings > Integrations > Webhooks
3. Click "New Webhook"
4. Choose the channel for that platform
5. Copy the webhook URL

### 3. Configure Environment Variables

```bash
cp .env.example .env
```

Edit `.env` and add:
- Your Base RPC WebSocket URL (from Alchemy, Infura, etc.)
- Discord webhook URLs for each platform

### 4. Set Up Discord Roles (Optional)

If you want users to self-select which platforms they see:

1. Create roles for each platform (e.g., `@Wise`, `@Revolut`, `@Venmo`)
2. Make each platform channel only visible to users with that role
3. Create a role-selection channel where users can pick their roles
4. Use a bot like Carl-bot or Dyno for reaction roles

### 5. Run the Bot

```bash
npm start
```

Or with auto-restart on file changes (development):
```bash
npm run dev
```

## Discord Channel Structure Example

```
📁 ZKP2P Deposits
├── #all-deposits       (DISCORD_WEBHOOK_ALL)
├── #wise-deposits      (DISCORD_WEBHOOK_WISE)
├── #revolut-deposits   (DISCORD_WEBHOOK_REVOLUT)
├── #venmo-deposits     (DISCORD_WEBHOOK_VENMO)
├── #cashapp-deposits   (DISCORD_WEBHOOK_CASHAPP)
├── #zelle-deposits     (DISCORD_WEBHOOK_ZELLE)
├── #paypal-deposits    (DISCORD_WEBHOOK_PAYPAL)
└── #other-deposits     (DISCORD_WEBHOOK_UNKNOWN)
```

## Deposit Notification Example

```
💚 New Wise Deposit #1234

💰 Amount: 500.00 USDC
🏦 Platform: Wise

💱 EUR: Rate: 0.920000 EUR/USDC
💱 GBP: Rate: 0.790000 GBP/USDC

👤 Depositor: 0x1234...5678

[🔗 Fill Deposit #1234]
```

## Supported Platforms

- Venmo (USD only)
- Revolut
- Wise
- Cash App (USD only)
- Zelle (USD only)
- PayPal
- Monzo
- Mercado Pago

## Troubleshooting

### WebSocket Disconnections
The bot automatically reconnects. Check your RPC URL if disconnections are frequent.

### Missing Deposits
Make sure the webhook URLs are correct and the bot has permission to post.

### Rate Limits
Discord has rate limits. The bot handles these automatically with retries.

## Running in Production

Use PM2 or similar:

```bash
npm install -g pm2
pm2 start bot.js --name zkp2p-discord
pm2 save
pm2 startup
```
