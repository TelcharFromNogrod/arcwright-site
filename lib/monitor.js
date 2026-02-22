/**
 * Chain monitor — watches for USDC transfers to payment addresses
 */
const { ethers } = require('ethers');
const db = require('./db');

// ERC-20 Transfer event signature
const TRANSFER_TOPIC = ethers.utils.id('Transfer(address,address,uint256)');

class ChainMonitor {
  constructor({ rpcUrl, usdcContract, onPaymentConfirmed }) {
    this.provider = new ethers.providers.JsonRpcProvider(rpcUrl);
    this.usdcAddress = usdcContract;
    this.onPaymentConfirmed = onPaymentConfirmed;
    this.polling = false;
    this.pollInterval = 15000; // 15 seconds
    this.lastBlock = null;
  }

  async start() {
    this.polling = true;
    console.log('[Monitor] Starting chain monitor...');
    
    try {
      this.lastBlock = await this.provider.getBlockNumber();
      console.log(`[Monitor] Starting from block ${this.lastBlock}`);
    } catch (err) {
      console.error('[Monitor] Failed to get block number:', err.message);
      this.lastBlock = 0;
    }

    this._poll();
  }

  stop() {
    this.polling = false;
    console.log('[Monitor] Stopped.');
  }

  async _poll() {
    while (this.polling) {
      try {
        await this._checkNewBlocks();
      } catch (err) {
        console.error('[Monitor] Poll error:', err.message);
      }
      await new Promise(r => setTimeout(r, this.pollInterval));
    }
  }

  async _checkNewBlocks() {
    const currentBlock = await this.provider.getBlockNumber();
    if (currentBlock <= this.lastBlock) return;

    // Get all pending payment addresses
    const pending = db.getPendingPayments();
    if (pending.length === 0) {
      this.lastBlock = currentBlock;
      return;
    }

    const addressSet = new Set(pending.map(p => p.pay_address.toLowerCase()));

    // Query USDC Transfer events in new blocks
    const fromBlock = this.lastBlock + 1;
    const toBlock = currentBlock;

    console.log(`[Monitor] Scanning blocks ${fromBlock}-${toBlock} for ${pending.length} pending payments`);

    try {
      const logs = await this.provider.getLogs({
        address: this.usdcAddress,
        topics: [TRANSFER_TOPIC],
        fromBlock,
        toBlock,
      });

      for (const log of logs) {
        // Decode Transfer event: Transfer(from, to, amount)
        const to = ethers.utils.getAddress('0x' + log.topics[2].slice(26));
        
        if (addressSet.has(to.toLowerCase())) {
          const amount = ethers.BigNumber.from(log.data);
          const amountUsdc = parseFloat(ethers.utils.formatUnits(amount, 6)); // USDC = 6 decimals
          
          // Find the matching payment
          const payment = pending.find(p => p.pay_address.toLowerCase() === to.toLowerCase());
          
          if (payment && amountUsdc >= payment.amount_usd * 0.99) { // Allow 1% tolerance
            console.log(`[Monitor] Payment confirmed! ${amountUsdc} USDC to ${to} (tx: ${log.transactionHash})`);
            db.confirmPayment(payment.id, log.transactionHash);
            
            if (this.onPaymentConfirmed) {
              this.onPaymentConfirmed(payment, log.transactionHash, amountUsdc);
            }
          }
        }
      }
    } catch (err) {
      console.error('[Monitor] Log query error:', err.message);
    }

    this.lastBlock = currentBlock;
  }
}

module.exports = ChainMonitor;
