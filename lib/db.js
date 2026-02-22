/**
 * SQLite database for payment sessions
 */
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'payments.db'));

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    product_slug TEXT NOT NULL,
    amount_usd REAL NOT NULL,
    crypto TEXT NOT NULL DEFAULT 'USDC',
    chain TEXT NOT NULL DEFAULT 'base',
    pay_address TEXT NOT NULL,
    address_index INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    tx_hash TEXT,
    download_token TEXT,
    created_at INTEGER NOT NULL,
    confirmed_at INTEGER,
    delivered_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS products (
    slug TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    price_usd REAL NOT NULL,
    file_path TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS address_counter (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    next_index INTEGER NOT NULL DEFAULT 0
  );

  INSERT OR IGNORE INTO address_counter (id, next_index) VALUES (1, 0);
`);

// Migration: add download_token if missing
try {
  db.exec('ALTER TABLE payments ADD COLUMN download_token TEXT');
} catch (e) {
  // Column already exists, ignore
}

function getNextAddressIndex() {
  const row = db.prepare('SELECT next_index FROM address_counter WHERE id = 1').get();
  const index = row.next_index;
  db.prepare('UPDATE address_counter SET next_index = next_index + 1 WHERE id = 1').run();
  return index;
}

function createPayment({ id, email, productSlug, amountUsd, crypto, chain, payAddress, addressIndex }) {
  db.prepare(`
    INSERT INTO payments (id, email, product_slug, amount_usd, crypto, chain, pay_address, address_index, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, email, productSlug, amountUsd, crypto, chain, payAddress, addressIndex, Date.now());
}

function getPendingPayments() {
  return db.prepare("SELECT * FROM payments WHERE status = 'pending'").all();
}

function getPayment(id) {
  return db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
}

function getPaymentByAddress(address) {
  return db.prepare("SELECT * FROM payments WHERE pay_address = ? AND status = 'pending'").get(address);
}

function getPaymentByToken(token) {
  return db.prepare("SELECT * FROM payments WHERE download_token = ? AND status IN ('confirmed', 'delivered')").get(token);
}

function confirmPayment(id, txHash, downloadToken) {
  db.prepare("UPDATE payments SET status = 'confirmed', tx_hash = ?, download_token = ?, confirmed_at = ? WHERE id = ?")
    .run(txHash, downloadToken, Date.now(), id);
}

function markDelivered(id) {
  db.prepare("UPDATE payments SET status = 'delivered', delivered_at = ? WHERE id = ?")
    .run(Date.now(), id);
}

function expireOldPayments(timeoutMs) {
  const cutoff = Date.now() - timeoutMs;
  db.prepare("UPDATE payments SET status = 'expired' WHERE status = 'pending' AND created_at < ?")
    .run(cutoff);
}

function getProduct(slug) {
  return db.prepare('SELECT * FROM products WHERE slug = ? AND active = 1').get(slug);
}

function getAllProducts() {
  return db.prepare('SELECT * FROM products WHERE active = 1').all();
}

function upsertProduct({ slug, name, description, priceUsd, filePath }) {
  db.prepare(`
    INSERT INTO products (slug, name, description, price_usd, file_path)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(slug) DO UPDATE SET name=?, description=?, price_usd=?, file_path=?, active=1
  `).run(slug, name, description, priceUsd, filePath, name, description, priceUsd, filePath);
}

module.exports = {
  db,
  getNextAddressIndex,
  createPayment,
  getPendingPayments,
  getPayment,
  getPaymentByAddress,
  getPaymentByToken,
  confirmPayment,
  markDelivered,
  expireOldPayments,
  getProduct,
  getAllProducts,
  upsertProduct,
};
