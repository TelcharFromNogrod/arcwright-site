require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const { ethers } = require('ethers');

const WalletDeriver = require('./lib/wallet');
const db = require('./lib/db');
const ChainMonitor = require('./lib/monitor');
const SolanaMonitor = require('./lib/solana-monitor');
const { fetchPrices, usdToCrypto } = require('./lib/prices');
const { initMailer, deliverProduct } = require('./lib/delivery');

const app = express();
app.use(cors());

// ============ STRIPE WEBHOOK (must be before express.json()) ============
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const stripeLib = STRIPE_SECRET_KEY ? require('stripe')(STRIPE_SECRET_KEY) : null;

app.post('/api/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripeLib || !STRIPE_WEBHOOK_SECRET) {
    return res.status(503).json({ error: 'Stripe not configured' });
  }

  let event;
  try {
    event = stripeLib.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[Stripe] Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const paymentIdFromMeta = session.metadata && session.metadata.payment_id;
    if (paymentIdFromMeta) {
      const downloadToken = crypto.randomBytes(32).toString('hex');
      db.confirmPayment(paymentIdFromMeta, session.payment_intent, downloadToken);
      console.log(`[Stripe] Payment confirmed: ${paymentIdFromMeta}`);

      // Attempt email delivery
      const payment = db.getPayment(paymentIdFromMeta);
      if (payment) {
        deliverProduct({ ...payment, download_token: downloadToken }).catch(err => {
          console.error('[Stripe] Email delivery error:', err.message);
        });
      }
    }
  }

  res.json({ received: true });
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const TIMEOUT_MS = (parseInt(process.env.PAYMENT_TIMEOUT_MINUTES) || 30) * 60 * 1000;
const SOL_ADDRESS = process.env.SOL_ADDRESS || '2EDnCQBcrNZmNfoFaVLKJWx2NhSxaBd3kTU5q7KLaGzb';

// Initialize wallet deriver
const wallet = new WalletDeriver(process.env.XPUB);

// Initialize mailer if configured
if (process.env.SMTP_PASS) {
  initMailer({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT) || 587,
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  });
}

// Seed products
const productsDir = path.join(__dirname, 'products');
const productFiles = {
  'marketing-mega-bundle': { name: 'Maven — Marketing Mega Bundle', price: 28 },
  'proactive-agent-playbook': { name: 'Proactive Agent Playbook', price: 14 },
  'crypto-wallet-manager': { name: 'Crypto Wallet Manager', price: 14 },
  'crypto-payment-engine': { name: 'Crypto Payment Engine — Self-Hosted, Non-Custodial', price: 24 },
};

for (const [slug, info] of Object.entries(productFiles)) {
  const filePath = path.join(productsDir, `${slug}.zip`);
  db.upsertProduct({
    slug,
    name: info.name,
    description: '',
    priceUsd: info.price,
    filePath,
  });
}

// Valid payment methods
const VALID_METHODS = {
  'USDC:base': true,
  'ETH:base': true,
  'ETH:ethereum': true,
  'SOL:solana': true,
};

// ============ API ROUTES ============

// GET /api/products — list all products
app.get('/api/products', (req, res) => {
  const products = db.getAllProducts();
  res.json(products.map(p => ({
    slug: p.slug,
    name: p.name,
    description: p.description,
    price_usd: p.price_usd,
  })));
});

// GET /api/prices — current crypto prices
app.get('/api/prices', async (req, res) => {
  try {
    const prices = await fetchPrices();
    res.json(prices);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch prices' });
  }
});

// POST /api/checkout — create a payment session
app.post('/api/checkout', async (req, res) => {
  const { email, product_slug, crypto: cryptoType = 'USDC', chain = 'base' } = req.body;

  if (!email || !product_slug) {
    return res.status(400).json({ error: 'email and product_slug required' });
  }

  const methodKey = `${cryptoType}:${chain}`;
  if (!VALID_METHODS[methodKey]) {
    return res.status(400).json({ error: `Unsupported payment method: ${cryptoType} on ${chain}` });
  }

  const product = db.getProduct(product_slug);
  if (!product) {
    return res.status(404).json({ error: 'Product not found' });
  }

  // Calculate crypto amount
  let amountCrypto;
  try {
    amountCrypto = await usdToCrypto(product.price_usd, cryptoType);
  } catch (err) {
    return res.status(503).json({ error: `Price unavailable for ${cryptoType}: ${err.message}` });
  }

  // Determine pay address
  let payAddress, addressIndex;
  if (cryptoType === 'SOL') {
    // Solana uses a single receive address, matched by amount
    payAddress = SOL_ADDRESS;
    addressIndex = -1; // Not HD-derived
  } else {
    // EVM chains use HD-derived addresses (same address works on Base & Ethereum)
    addressIndex = db.getNextAddressIndex();
    payAddress = wallet.getAddress(addressIndex);
  }

  const paymentId = crypto.randomUUID ? crypto.randomUUID() :
    `pay_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  db.createPayment({
    id: paymentId,
    email,
    productSlug: product_slug,
    amountUsd: product.price_usd,
    amountCrypto,
    crypto: cryptoType,
    chain,
    payAddress,
    addressIndex,
  });

  console.log(`[Checkout] Payment ${paymentId}: ${product.name} → ${payAddress} (${amountCrypto} ${cryptoType} / $${product.price_usd})`);

  res.json({
    payment_id: paymentId,
    product: product.name,
    amount_usd: product.price_usd,
    amount_crypto: amountCrypto,
    crypto: cryptoType,
    chain,
    pay_address: payAddress,
    expires_in_minutes: parseInt(process.env.PAYMENT_TIMEOUT_MINUTES) || 30,
  });
});

// POST /api/checkout/stripe — create Stripe Checkout Session
app.post('/api/checkout/stripe', async (req, res) => {
  if (!stripeLib) {
    return res.status(503).json({ error: 'Stripe not configured' });
  }

  const { email, product_slug } = req.body;
  if (!email || !product_slug) {
    return res.status(400).json({ error: 'email and product_slug required' });
  }

  const product = db.getProduct(product_slug);
  if (!product) {
    return res.status(404).json({ error: 'Product not found' });
  }

  const paymentId = crypto.randomUUID ? crypto.randomUUID() :
    `pay_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  const baseUrl = process.env.SITE_URL || `http://localhost:${PORT}`;

  try {
    const session = await stripeLib.checkout.sessions.create({
      mode: 'payment',
      customer_email: email,
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: product.name },
          unit_amount: Math.round(product.price_usd * 100),
        },
        quantity: 1,
      }],
      metadata: { payment_id: paymentId, product_slug },
      success_url: `${baseUrl}/checkout.html?product=${product_slug}&payment_id=${paymentId}&stripe=success`,
      cancel_url: `${baseUrl}/checkout.html?product=${product_slug}`,
    });

    // Create payment record
    db.createPayment({
      id: paymentId,
      email,
      productSlug: product_slug,
      amountUsd: product.price_usd,
      amountCrypto: product.price_usd,
      crypto: 'STRIPE',
      chain: 'stripe',
      payAddress: session.id,
      addressIndex: -1,
    });

    console.log(`[Stripe] Checkout session created: ${paymentId} → ${session.id}`);

    res.json({
      payment_id: paymentId,
      checkout_url: session.url,
    });
  } catch (err) {
    console.error('[Stripe] Session creation error:', err.message);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// GET /api/payment/:id — check payment status
app.get('/api/payment/:id', (req, res) => {
  const payment = db.getPayment(req.params.id);
  if (!payment) {
    return res.status(404).json({ error: 'Payment not found' });
  }

  const resp = {
    payment_id: payment.id,
    status: payment.status,
    product_slug: payment.product_slug,
    amount_usd: payment.amount_usd,
    amount_crypto: payment.amount_crypto,
    crypto: payment.crypto,
    chain: payment.chain,
    pay_address: payment.pay_address,
    tx_hash: payment.tx_hash,
    created_at: payment.created_at,
    confirmed_at: payment.confirmed_at,
    delivered_at: payment.delivered_at,
  };

  if (payment.download_token && (payment.status === 'confirmed' || payment.status === 'delivered')) {
    const baseUrl = process.env.SITE_URL || `${req.protocol}://${req.get('host')}`;
    resp.download_url = `${baseUrl}/api/download/${payment.product_slug}?token=${payment.download_token}`;
  }

  res.json(resp);
});

// ============ x402 PAYMENT PROTOCOL ============

app.get('/api/x402/products/:slug', (req, res) => {
  const product = db.getProduct(req.params.slug);
  if (!product) {
    return res.status(404).json({ error: 'Product not found' });
  }

  const addressIndex = db.getNextAddressIndex();
  const payAddress = wallet.getAddress(addressIndex);

  res.status(402).json({
    status: 402,
    message: 'Payment Required',
    accepts: [{
      scheme: 'exact',
      network: 'base',
      asset: 'USDC',
      address: payAddress,
      amount: (product.price_usd * 1e6).toString(),
      amount_usd: product.price_usd,
    }],
    product: {
      slug: product.slug,
      name: product.name,
      description: product.description,
    },
    x402_version: '1',
  });
});

app.post('/api/x402/products/:slug', (req, res) => {
  const { tx_hash } = req.body;

  if (!tx_hash) {
    return res.status(400).json({ error: 'tx_hash required' });
  }

  const product = db.getProduct(req.params.slug);
  if (!product) {
    return res.status(404).json({ error: 'Product not found' });
  }

  const paymentId = `x402_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  res.json({
    status: 'ok',
    payment_id: paymentId,
    product: product.name,
    download_url: `${process.env.SITE_URL}/api/download/${req.params.slug}?token=${paymentId}`,
    message: 'Payment received. Download your product at the URL above.',
  });
});

// Download endpoint
app.get('/api/download/:slug', (req, res) => {
  const { token } = req.query;
  if (!token) {
    return res.status(401).json({ error: 'Token required' });
  }

  const payment = db.getPaymentByToken(token);
  if (!payment || payment.product_slug !== req.params.slug) {
    return res.status(403).json({ error: 'Invalid or expired download token' });
  }

  const product = db.getProduct(req.params.slug);
  if (!product) {
    return res.status(404).json({ error: 'Product not found' });
  }

  const filePath = path.resolve(product.file_path);
  const fs = require('fs');
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Product file not found' });
  }

  if (payment.status === 'confirmed') {
    db.markDelivered(payment.id);
  }

  res.download(filePath);
});

// ============ SPA FALLBACK / 404 ============
const KNOWN_ROUTES = ['/', '/index.html', '/product.html', '/checkout.html'];
app.get('*', (req, res) => {
  if (KNOWN_ROUTES.includes(req.path)) {
    res.sendFile(path.join(__dirname, 'public', req.path === '/' ? 'index.html' : req.path.slice(1)));
  } else {
    res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  }
});

// ============ PAYMENT CONFIRMATION HANDLER ============
function handlePaymentConfirmed(chainLabel) {
  return async (payment, txHash, amount) => {
    console.log(`[Payment:${chainLabel}] Confirmed: ${payment.id} — ${amount} ${payment.crypto}`);
    const downloadToken = crypto.randomBytes(32).toString('hex');
    db.confirmPayment(payment.id, txHash, downloadToken);
    await deliverProduct({ ...payment, download_token: downloadToken });
  };
}

// ============ START ============
app.listen(PORT, () => {
  console.log(`[Arcwright] Server running on port ${PORT}`);

  // Base chain monitor (USDC + ETH on Base)
  const baseMonitor = new ChainMonitor({
    rpcUrl: process.env.BASE_RPC || 'https://mainnet.base.org',
    usdcContract: process.env.USDC_CONTRACT,
    chainName: 'base',
    onPaymentConfirmed: handlePaymentConfirmed('base'),
  });
  baseMonitor.start();

  // Ethereum mainnet monitor (ETH only)
  const ethRpc = process.env.ETH_MAINNET_RPC || 'https://eth.llamarpc.com';
  const ethMonitor = new ChainMonitor({
    rpcUrl: ethRpc,
    usdcContract: null, // No USDC monitoring on mainnet
    chainName: 'ethereum',
    onPaymentConfirmed: handlePaymentConfirmed('ethereum'),
  });
  ethMonitor.start();

  // Solana monitor (SOL)
  const solMonitor = new SolanaMonitor({
    rpcUrl: process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com',
    receiveAddress: SOL_ADDRESS,
    onPaymentConfirmed: handlePaymentConfirmed('solana'),
  });
  solMonitor.start();

  // Expire old payments every minute
  setInterval(() => {
    db.expireOldPayments(TIMEOUT_MS);
  }, 60000);

  // Pre-fetch prices on boot
  fetchPrices().catch(() => {});
});
