/**
 * Crypto price fetcher — CoinGecko free API
 * Caches prices for 60 seconds to avoid rate limits
 */

const CACHE_TTL = 60_000; // 60 seconds
const cache = { eth: { price: 0, ts: 0 }, sol: { price: 0, ts: 0 } };

const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum,solana&vs_currencies=usd';

async function fetchPrices() {
  const now = Date.now();
  if (cache.eth.ts > now - CACHE_TTL && cache.sol.ts > now - CACHE_TTL) {
    return { eth: cache.eth.price, sol: cache.sol.price };
  }

  try {
    const res = await fetch(COINGECKO_URL);
    const data = await res.json();
    if (data.ethereum?.usd) {
      cache.eth = { price: data.ethereum.usd, ts: now };
    }
    if (data.solana?.usd) {
      cache.sol = { price: data.solana.usd, ts: now };
    }
    console.log(`[Prices] ETH=$${cache.eth.price} SOL=$${cache.sol.price}`);
  } catch (err) {
    console.error('[Prices] Fetch error:', err.message);
  }

  return { eth: cache.eth.price, sol: cache.sol.price };
}

/**
 * Convert USD to crypto amount
 * @returns {number} amount in crypto (e.g. 0.0123 ETH)
 */
async function usdToCrypto(usd, crypto) {
  if (crypto === 'USDC') return usd; // 1:1

  const prices = await fetchPrices();
  const key = crypto === 'ETH' ? 'eth' : 'sol';
  const price = prices[key];
  if (!price || price <= 0) throw new Error(`No price available for ${crypto}`);

  // Round to 8 decimal places
  return Math.ceil((usd / price) * 1e8) / 1e8;
}

module.exports = { fetchPrices, usdToCrypto };
