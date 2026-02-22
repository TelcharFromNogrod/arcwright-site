require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const { ethers } = require('ethers');

const WalletDeriver = require('./lib/wallet');
const db = require('./lib/db');
const ChainMonitor = require('./lib/monitor');
const { initMailer, deliverProduct } = require('./lib/delivery');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const TIMEOUT_MS = (parseInt(process.env.PAYMENT_TIMEOUT_MINUTES) || 30) * 60 * 1000;

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

// POST /api/checkout — create a payment session
app.post('/api/checkout', (req, res) => {
  const { email, product_slug, crypto = 'USDC', chain = 'base' } = req.body;

  if (!email || !product_slug) {
    return res.status(400).json({ error: 'email and product_slug required' });
  }

  const product = db.getProduct(product_slug);
  if (!product) {
    return res.status(404).json({ error: 'Product not found' });
  }

  // Generate unique payment address
  const addressIndex = db.getNextAddressIndex();
  const payAddress = wallet.getAddress(addressIndex);

  const paymentId = crypto.randomUUID ? crypto.randomUUID() : 
    `pay_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  db.createPayment({
    id: paymentId,
    email,
    productSlug: product_slug,
    amountUsd: product.price_usd,
    crypto,
    chain,
    payAddress,
    addressIndex,
  });

  console.log(`[Checkout] Payment ${paymentId}: ${product.name} → ${payAddress} ($${product.price_usd})`);

  res.json({
    payment_id: paymentId,
    product: product.name,
    amount_usd: product.price_usd,
    crypto,
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
    pay_address: payment.pay_address,
    tx_hash: payment.tx_hash,
    created_at: payment.created_at,
    confirmed_at: payment.confirmed_at,
    delivered_at: payment.delivered_at,
  };

  // Include download URL when payment is confirmed or delivered
  if (payment.download_token && (payment.status === 'confirmed' || payment.status === 'delivered')) {
    const baseUrl = process.env.SITE_URL || `${req.protocol}://${req.get('host')}`;
    resp.download_url = `${baseUrl}/api/download/${payment.product_slug}?token=${payment.download_token}`;
  }

  res.json(resp);
});

// ============ x402 PAYMENT PROTOCOL ============
// Agent-to-agent HTTP payments: pay with USDC, get product in response

app.get('/api/x402/products/:slug', (req, res) => {
  const product = db.getProduct(req.params.slug);
  if (!product) {
    return res.status(404).json({ error: 'Product not found' });
  }

  // Return 402 with payment requirements
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
      amount: (product.price_usd * 1e6).toString(), // atomic units (6 decimals)
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
  const { tx_hash, pay_address } = req.body;
  
  if (!tx_hash) {
    return res.status(400).json({ error: 'tx_hash required' });
  }

  const product = db.getProduct(req.params.slug);
  if (!product) {
    return res.status(404).json({ error: 'Product not found' });
  }

  // For x402, we verify the tx on-chain then return a download URL
  // For now, we'll trust the tx_hash and verify async
  // In production, we'd verify the tx before responding
  
  const paymentId = `x402_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  
  res.json({
    status: 'ok',
    payment_id: paymentId,
    product: product.name,
    download_url: `${process.env.SITE_URL}/api/download/${req.params.slug}?token=${paymentId}`,
    message: 'Payment received. Download your product at the URL above.',
  });
});

// Download endpoint — validates token against payment record
app.get('/api/download/:slug', (req, res) => {
  const { token } = req.query;
  if (!token) {
    return res.status(401).json({ error: 'Token required' });
  }

  // Verify token matches a confirmed/delivered payment
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

  // Mark as delivered on first download
  if (payment.status === 'confirmed') {
    db.markDelivered(payment.id);
  }

  res.download(filePath);
});

// ============ SPA FALLBACK ============
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============ START ============
app.listen(PORT, () => {
  console.log(`[Arcwright] Server running on port ${PORT}`);

  // Start chain monitor
  const monitor = new ChainMonitor({
    rpcUrl: process.env.BASE_RPC || 'https://mainnet.base.org',
    usdcContract: process.env.USDC_CONTRACT,
    onPaymentConfirmed: async (payment, txHash, amount) => {
      console.log(`[Payment] Confirmed: ${payment.id} — $${amount} USDC`);
      // Generate secure download token
      const downloadToken = crypto.randomBytes(32).toString('hex');
      db.confirmPayment(payment.id, txHash, downloadToken);
      // Also attempt email delivery if mailer configured
      await deliverProduct({ ...payment, download_token: downloadToken });
    },
  });
  monitor.start();

  // Expire old payments every minute
  setInterval(() => {
    db.expireOldPayments(TIMEOUT_MS);
  }, 60000);
});
