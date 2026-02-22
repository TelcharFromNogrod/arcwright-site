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
  'marketing-mega-bundle': { name: 'Maven — Marketing Mega Bundle', price: 49 },
  'proactive-agent-playbook': { name: 'Proactive Agent Playbook', price: 19 },
  'crypto-wallet-manager': { name: 'Crypto Wallet Manager', price: 19 },
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
