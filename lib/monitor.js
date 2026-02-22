/**
 * Chain monitor — watches for USDC transfers and native ETH transfers
 * Supports multiple EVM chains (Base, Ethereum mainnet)
 */
const { ethers } = require('ethers');
const db = require('./db');

// ERC-20 Transfer event signature
const TRANSFER_TOPIC = ethers.utils.id('Transfer(address,address,uint256)');

class ChainMonitor {
  constructor({ rpcUrl, usdcContract, onPaymentConfirmed, chainName = 'base' }) {
    this.provider = new ethers.providers.JsonRpcProvider(rpcUrl);
    this.usdcAddress = usdcContract;
    this.onPaymentConfirmed = onPaymentConfirmed;
    this.chainName = chainName;
    this.polling = false;
    this.pollInterval = 15000;
    this.lastBlock = null;
  }

  async start() {
    this.polling = true;
    console.log(`[Monitor:${this.chainName}] Starting chain monitor...`);

    try {
      this.lastBlock = await this.provider.getBlockNumber();
      console.log(`[Monitor:${this.chainName}] Starting from block ${this.lastBlock}`);
    } catch (err) {
      console.error(`[Monitor:${this.chainName}] Failed to get block number:`, err.message);
      this.lastBlock = 0;
    }

    this._poll();
  }

  stop() {
    this.polling = false;
    console.log(`[Monitor:${this.chainName}] Stopped.`);
  }

  async _poll() {
    while (this.polling) {
      try {
        await this._checkNewBlocks();
      } catch (err) {
        console.error(`[Monitor:${this.chainName}] Poll error:`, err.message);
      }
      await new Promise(r => setTimeout(r, this.pollInterval));
    }
  }

  async _checkNewBlocks() {
    const currentBlock = await this.provider.getBlockNumber();
    if (currentBlock <= this.lastBlock) return;

    // Get pending payments for this chain
    const allPending = db.getPendingPayments();
    const pending = allPending.filter(p => p.chain === this.chainName);
    if (pending.length === 0) {
      this.lastBlock = currentBlock;
      return;
    }

    const addressSet = new Set(pending.map(p => p.pay_address.toLowerCase()));
    const fromBlock = this.lastBlock + 1;
    const toBlock = currentBlock;

    console.log(`[Monitor:${this.chainName}] Scanning blocks ${fromBlock}-${toBlock} for ${pending.length} pending payments`);

    // Check USDC transfers (ERC-20 logs)
    const usdcPending = pending.filter(p => p.crypto === 'USDC');
    if (usdcPending.length > 0 && this.usdcAddress) {
      await this._checkUsdcTransfers(fromBlock, toBlock, usdcPending, addressSet);
    }

    // Check native ETH transfers (block transactions)
    const ethPending = pending.filter(p => p.crypto === 'ETH');
    if (ethPending.length > 0) {
      await this._checkEthTransfers(fromBlock, toBlock, ethPending, addressSet);
    }

    this.lastBlock = currentBlock;
  }

  /** Scan ERC-20 Transfer logs for USDC payments */
  async _checkUsdcTransfers(fromBlock, toBlock, pending, addressSet) {
    try {
      const logs = await this.provider.getLogs({
        address: this.usdcAddress,
        topics: [TRANSFER_TOPIC],
        fromBlock,
        toBlock,
      });

      for (const log of logs) {
        const to = ethers.utils.getAddress('0x' + log.topics[2].slice(26));

        if (addressSet.has(to.toLowerCase())) {
          const amount = ethers.BigNumber.from(log.data);
          const amountUsdc = parseFloat(ethers.utils.formatUnits(amount, 6));

          const payment = pending.find(p => p.pay_address.toLowerCase() === to.toLowerCase());

          if (payment && amountUsdc >= payment.amount_usd * 0.99) {
            console.log(`[Monitor:${this.chainName}] USDC payment detected! ${amountUsdc} USDC to ${to} (tx: ${log.transactionHash})`);
            if (this.onPaymentConfirmed) {
              this.onPaymentConfirmed(payment, log.transactionHash, amountUsdc);
            }
          }
        }
      }
    } catch (err) {
      console.error(`[Monitor:${this.chainName}] USDC log query error:`, err.message);
    }
  }

  /** Scan block transactions for native ETH transfers */
  async _checkEthTransfers(fromBlock, toBlock, pending, addressSet) {
    try {
      // Cap scan range to avoid huge queries
      const maxRange = 5;
      const start = Math.max(fromBlock, toBlock - maxRange + 1);

      for (let blockNum = start; blockNum <= toBlock; blockNum++) {
        const block = await this.provider.getBlockWithTransactions(blockNum);
        if (!block || !block.transactions) continue;

        for (const tx of block.transactions) {
          if (!tx.to || !tx.value || tx.value.isZero()) continue;

          if (addressSet.has(tx.to.toLowerCase())) {
            const amountEth = parseFloat(ethers.utils.formatEther(tx.value));

            const payment = pending.find(p => p.pay_address.toLowerCase() === tx.to.toLowerCase());

            if (payment && payment.amount_crypto) {
              // Match by crypto amount (0.5% tolerance)
              const expected = payment.amount_crypto;
              if (amountEth >= expected * 0.995) {
                console.log(`[Monitor:${this.chainName}] ETH payment detected! ${amountEth} ETH to ${tx.to} (tx: ${tx.hash})`);
                if (this.onPaymentConfirmed) {
                  this.onPaymentConfirmed(payment, tx.hash, amountEth);
                }
              }
            }
          }
        }
      }
    } catch (err) {
      console.error(`[Monitor:${this.chainName}] ETH scan error:`, err.message);
    }
  }
}

module.exports = ChainMonitor;
