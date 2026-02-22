/**
 * HD Wallet address derivation
 * Uses xpub (public key only) — server can generate addresses but never spend
 */
const { ethers } = require('ethers');

class WalletDeriver {
  constructor(xpub) {
    this.hdNode = ethers.utils.HDNode.fromExtendedKey(xpub);
  }

  /**
   * Derive a unique payment address from an index
   * Path: m/44'/60'/0'/0/{index} (but from xpub, so relative: 0/{index})
   */
  getAddress(index) {
    // From xpub we derive relative to the xpub's path
    // xpub is at m level, so we derive 0/{index}
    const child = this.hdNode.derivePath(`0/${index}`);
    return child.address;
  }
}

module.exports = WalletDeriver;
