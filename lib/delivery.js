/**
 * Product delivery via email
 */
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');
const db = require('./db');

let transporter = null;

function initMailer(config) {
  transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    auth: {
      user: config.user,
      pass: config.pass,
    },
  });
  console.log('[Delivery] Mailer initialized');
}

async function deliverProduct(payment) {
  const product = db.getProduct(payment.product_slug);
  if (!product) {
    console.error(`[Delivery] Product not found: ${payment.product_slug}`);
    return false;
  }

  const filePath = path.resolve(product.file_path);
  if (!fs.existsSync(filePath)) {
    console.error(`[Delivery] File not found: ${filePath}`);
    return false;
  }

  const filename = path.basename(filePath);

  try {
    if (!transporter) {
      console.log(`[Delivery] No mailer configured — logging delivery for ${payment.email}`);
      console.log(`[Delivery] Would send: ${product.name} (${filePath}) to ${payment.email}`);
      db.markDelivered(payment.id);
      return true;
    }

    await transporter.sendMail({
      from: `"Arcwright" <${process.env.SMTP_USER || 'arcwrighthq@proton.me'}>`,
      to: payment.email,
      subject: `Your purchase: ${product.name}`,
      html: `
        <div style="font-family: -apple-system, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #f59e0b;">⚒️ Arcwright</h2>
          <p>Thanks for your purchase!</p>
          <p><strong>Product:</strong> ${product.name}</p>
          <p><strong>Amount:</strong> $${payment.amount_usd} USDC</p>
          <p><strong>Transaction:</strong> <a href="https://basescan.org/tx/${payment.tx_hash}">${payment.tx_hash?.slice(0, 16)}...</a></p>
          <p>Your product is attached below. If you have any questions, reply to this email.</p>
          <br>
          <p style="color: #888; font-size: 12px;">Built in the forge. — Arcwright</p>
        </div>
      `,
      attachments: [{ filename, path: filePath }],
    });

    console.log(`[Delivery] Sent ${product.name} to ${payment.email}`);
    db.markDelivered(payment.id);
    return true;
  } catch (err) {
    console.error(`[Delivery] Email failed:`, err.message);
    return false;
  }
}

module.exports = { initMailer, deliverProduct };
