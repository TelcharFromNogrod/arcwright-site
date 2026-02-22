/**
 * Solana monitor — polls for SOL transfers to a receive address
 * Matches payments by amount (within 0.5% tolerance)
 */
const { Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const db = require('./db');

class SolanaMonitor {
  constructor({ rpcUrl, receiveAddress, onPaymentConfirmed }) {
    this.connection = new Connection(rpcUrl || 'https://api.mainnet-beta.solana.com');
    this.receiveAddress = new PublicKey(receiveAddress);
    this.onPaymentConfirmed = onPaymentConfirmed;
    this.polling = false;
    this.pollInterval = 15000;
    this.lastSignature = null; // Track last processed tx signature
  }

  async start() {
    this.polling = true;
    console.log(`[SolMon] Monitoring ${this.receiveAddress.toBase58()}`);

    // Get the latest signature to start from
    try {
      const sigs = await this.connection.getSignaturesForAddress(this.receiveAddress, { limit: 1 });
      if (sigs.length > 0) {
        this.lastSignature = sigs[0].signature;
      }
    } catch (err) {
      console.error('[SolMon] Init error:', err.message);
    }

    this._poll();
  }

  stop() {
    this.polling = false;
    console.log('[SolMon] Stopped.');
  }

  async _poll() {
    while (this.polling) {
      try {
        await this._checkNewTransactions();
      } catch (err) {
        console.error('[SolMon] Poll error:', err.message);
      }
      await new Promise(r => setTimeout(r, this.pollInterval));
    }
  }

  async _checkNewTransactions() {
    // Get pending SOL payments
    const pending = db.getPendingPayments().filter(
      p => p.crypto === 'SOL' && p.chain === 'solana'
    );
    if (pending.length === 0) return;

    // Fetch new signatures since last check
    const opts = { limit: 20 };
    if (this.lastSignature) opts.until = this.lastSignature;

    const sigs = await this.connection.getSignaturesForAddress(this.receiveAddress, opts);
    if (sigs.length === 0) return;

    // Update last signature to the newest
    this.lastSignature = sigs[0].signature;

    // Build amount map for quick lookup: amount_crypto -> payment
    // (amounts should be unique enough for matching)
    const amountMap = new Map();
    for (const p of pending) {
      if (p.amount_crypto) {
        amountMap.set(p.amount_crypto, p);
      }
    }

    for (const sigInfo of sigs) {
      if (sigInfo.err) continue; // Skip failed txs

      try {
        const tx = await this.connection.getTransaction(sigInfo.signature, {
          maxSupportedTransactionVersion: 0,
        });
        if (!tx || !tx.meta) continue;

        // Check for SOL transfer to our address
        const accountKeys = tx.transaction.message.staticAccountKeys
          ? tx.transaction.message.staticAccountKeys.map(k => k.toBase58())
          : tx.transaction.message.accountKeys.map(k => k.toBase58());

        const receiveIdx = accountKeys.indexOf(this.receiveAddress.toBase58());
        if (receiveIdx === -1) continue;

        // Calculate SOL received (postBalance - preBalance)
        const pre = tx.meta.preBalances[receiveIdx];
        const post = tx.meta.postBalances[receiveIdx];
        const received = (post - pre) / LAMPORTS_PER_SOL;

        if (received <= 0) continue;

        // Match by amount (0.5% tolerance)
        for (const [expectedAmount, payment] of amountMap) {
          const tolerance = expectedAmount * 0.005;
          if (Math.abs(received - expectedAmount) <= tolerance) {
            console.log(`[SolMon] Payment detected! ${received} SOL (tx: ${sigInfo.signature})`);
            if (this.onPaymentConfirmed) {
              this.onPaymentConfirmed(payment, sigInfo.signature, received);
            }
            amountMap.delete(expectedAmount);
            break;
          }
        }
      } catch (err) {
        console.error(`[SolMon] Tx parse error (${sigInfo.signature}):`, err.message);
      }
    }
  }
}

module.exports = SolanaMonitor;
