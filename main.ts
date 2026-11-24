// Token launch radar — radar-2 model.
//
// Reads the sealed DefiLlama snapshot at /input/snapshot.json, ranks every
// pre-token protocol the house's own exclusion rule keeps (the watchlist's 40
// plus every other rankable protocol below the floor), and writes the board,
// the dashboard data, the dashboard, the screenshots and the dossier to the
// output directory.
//
// Value model (computed from the snapshot itself, no hardcoded names):
//   implied = round(TVL x categoryMultiple x growthMult x ageMult)
//   categoryMultiple = median mcap/TVL of live-token protocols in the same
//     category (at least 3 comparables), else the global comparable median,
//     clamped to [0.05, 1.50]
//   growthMult = 1 + clamp(change_7d, -50, 100) / 100 * 0.5  (null -> 1.0)
//   ageMult    = 0.80 + 0.20 * min(age_days, 730) / 730        (unknown -> 0.85)
//
// Node 22, standard library only. Deterministic: the same input writes the
// same bytes on every run (stable sorts with slug tie-breaks, no clocks).
import { readFileSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';

const MODEL_VERSION = 'radar-2';
const TEXT_MAX_BYTES = 65536;

// ------------------------------------------------------------------ input

interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

function parseArgs(argv: string[]): { input: string; output: string } {
  let input = '/input/snapshot.json';
  let output = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--input' && argv[i + 1] !== undefined) input = argv[++i]!;
    else if (argv[i] === '--output' && argv[i + 1] !== undefined) output = argv[++i]!;
  }
  return { input, output };
}

// ------------------------------------------------------------------ rules

// The house's exclusion rule, applied to the whole board: a wrapped, staked
// or bridged product of a token that already trades is not a token that does
// not exist yet, so it is never ranked — WBTC, Binance staked ETH, USDT0 and
// the bridges stay out by rule, not by a TVL cap.
const EXCLUDED_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);
const EXCHANGE_START = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

function hasToken(p: Protocol): boolean {
  return p.gecko_id !== null || p.symbol !== null;
}

function isExcludedProduct(p: Protocol): boolean {
  return (
    EXCLUDED_CATEGORIES.has(p.category ?? '') ||
    WRAPPED_WORD.test(p.name) ||
    EXCHANGE_START.test(p.name) ||
    VERSION_SUFFIX.test(p.name)
  );
}

// Rankable: records no token and is not a wrapped/staked/bridged product.
function isRankable(p: Protocol): boolean {
  return !hasToken(p) && !isExcludedProduct(p);
}

// ------------------------------------------------------------------ model

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const days = Math.floor((Date.parse(asOf) - Date.parse(listedAt)) / 86400000);
  return days < 0 ? 0 : days;
}

function growthMult(change7d: number | null): number {
  if (change7d === null) return 1;
  return 1 + (clamp(change7d, -50, 100) / 100) * 0.5;
}

function ageMult(age: number | null): number {
  if (age === null) return 0.85;
  return 0.8 + 0.2 * (Math.min(age, 730) / 730);
}

interface Multiples {
  byCategory: Record<string, number>;
  global: number;
}

// Category-comparable FDV multiples, measured from the snapshot itself:
// live-token protocols that are themselves protocols (same exclusion rule),
// with a positive market cap and TVL. A category needs at least 3
// comparables to earn its own multiple; thinner categories fall back to the
// global comparable median. All multiples are clamped to [0.05, 1.50].
function categoryMultiples(protocols: Protocol[]): Multiples {
  const comps = protocols.filter(
    (p) =>
      hasToken(p) &&
      p.mcap_usd !== null &&
      p.mcap_usd > 0 &&
      p.tvl_usd > 0 &&
      !isExcludedProduct(p),
  );
  const global = clamp(median(comps.map((p) => p.mcap_usd! / p.tvl_usd)), 0.05, 1.5);
  const byCat = new Map<string, number[]>();
  for (const p of comps) {
    const cat = p.category ?? '(uncategorised)';
    const list = byCat.get(cat) ?? [];
    list.push(p.mcap_usd! / p.tvl_usd);
    byCat.set(cat, list);
  }
  const byCategory: Record<string, number> = {};
  for (const [cat, ratios] of [...byCat.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (ratios.length >= 3) byCategory[cat] = clamp(median(ratios), 0.05, 1.5);
  }
  return { byCategory, global };
}

function multipleFor(category: string | null, multiples: Multiples): number {
  const cat = category ?? '(uncategorised)';
  return multiples.byCategory[cat] ?? multiples.global;
}

// ------------------------------------------------------------------ farm plans

// Gas a single transaction costs on the protocol's first chain, in dollars.
// Ethereum is the expensive outlier; most L2s and cheap L1s cost cents.
const CHEAP_CHAINS = new Set([
  'Solana', 'Sui', 'Aptos', 'Stellar', 'Ripple', 'Algorand', 'Flare',
  'Provenance', 'Hyperliquid L1', 'Near', 'Sei', 'Bittensor',
]);

const L2_CHAINS = new Set([
  'Arbitrum', 'Abstract', 'Avalanche', 'Base', 'Berachain', 'Blast', 'BOB',
  'Celo', 'Citrea', 'Corn', 'Fantom', 'Fluent', 'Fraxtal', 'Gnosis', 'Hemi',
  'Ink', 'Katana', 'Linea', 'Mantle', 'Mode', 'Monad', 'Arc', 'Morph',
  'Optimism', 'Plasma', 'Polygon', 'Polygon zkEVM', 'RISE', 'Robinhood Chain',
  'Scroll', 'Sonic', 'Stable', 'Starknet', 'Tempo', 'Unichain', 'World Chain',
  'zkSync Era', 'Op_Bnb', 'Astar', 'Moonbeam', 'Taiko', 'Zircuit', 'Lisk',
]);

function gasNote(chain: string): string {
  if (chain === 'Ethereum') return 'about $4-10 per transaction';
  if (CHEAP_CHAINS.has(chain)) return 'about $0.01 per transaction';
  if (chain === 'BSC' || chain === 'BNB Chain' || chain === 'Binance') return 'about $0.10-0.30 per transaction';
  if (L2_CHAINS.has(chain)) return 'about $0.10-0.50 per transaction';
  return 'about $1 per transaction';
}

// Capital at risk, by the protocol's TVL tier.
function capitalFor(tvl: number): number {
  if (tvl >= 500_000_000) return 250;
  if (tvl >= 100_000_000) return 150;
  if (tvl >= 25_000_000) return 100;
  return 50;
}

// Days a position must stay open, by the protocol's age.
function holdDays(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

// Per-category actions: [primary action, second distinct action, weekly action].
// Each is a verb phrase; the plan turns it into a concrete step with capital,
// cost and time. Categories the table does not name use the generic pair.
const ACTIONS: Record<string, [string, string, string]> = {
  'Dexs': [
    'swap half the capital into the paired asset and add both halves as liquidity in the main pool',
    'make a separate swap in a different pair on the same exchange',
    'swap a small amount in the main pool',
  ],
  'Lending': [
    'supply the capital as collateral in the main lending market',
    'borrow a small amount against the supplied collateral and repay it within the week',
    'supply or borrow a small amount',
  ],
  'Yield': [
    'deposit the capital into the highest-TVL yield vault',
    'harvest the vault\u2019s yield once and compound it back in',
    'check the vault and compound any yield',
  ],
  'RWA': [
    'buy the tokenised real-world-asset position with the capital',
    'stake or lock the position in the protocol\u2019s rewards contract if it offers one',
    'top up or rebalance the position',
  ],
  'CDP': [
    'lock collateral and mint the protocol\u2019s stablecoin with the capital',
    'repay part of the minted stablecoin and mint it again to record a second interaction',
    'adjust the collateral ratio',
  ],
  'Yield Aggregator': [
    'deposit the capital into the flagship auto-compounding vault',
    'move a small amount into a second vault with a different strategy',
    'harvest yield and re-deposit it',
  ],
  'Basis Trading': [
    'open a delta-neutral basis position with the capital',
    'close the position and reopen a smaller one to record a second trade',
    'rebalance the basis position',
  ],
  'Derivatives': [
    'open a perpetual position with the capital at the lowest leverage offered',
    'close the position and open a second one in the opposite direction',
    'open and close a small perpetual trade',
  ],
  'Risk Curators': [
    'deposit the capital into a curated vault run by the protocol',
    'allocate a small amount to a second curated vault with a different curator',
    'review vault performance and reallocate if a vault lags',
  ],
  'Onchain Capital Allocator': [
    'allocate the capital to the protocol\u2019s flagship allocation vault',
    'allocate a small amount to a second allocation strategy',
    'review the allocations and rebalance',
  ],
  'Chain': [
    'bridge the capital onto the chain and use its native decentralised app to swap or stake',
    'run a second transaction on the chain, such as a stake or a swap in another app',
    'make a small on-chain transaction',
  ],
  'Staking Pool': [
    'stake the capital in the protocol\u2019s staking pool',
    'unstake a small amount and stake it again to record a second staking event',
    'claim rewards and restake them',
  ],
  'Restaking': [
    'restake the capital through the protocol\u2019s restaking contract',
    'delegate a small amount to a second operator or validator set',
    'check restaking rewards and top up',
  ],
  'Indexes': [
    'buy the protocol\u2019s index token with the capital',
    'sell a small amount of the index token and buy it back',
    'rebalance the index holding',
  ],
  'Liquidity Manager': [
    'deposit the capital into a managed liquidity position',
    'move the position into a second price range',
    'check the range and rebalance it',
  ],
  'Leveraged Farming': [
    'open a leveraged farming position with the capital at the lowest leverage offered',
    'close the position and open a smaller one',
    'monitor the position and adjust leverage',
  ],
  'Anchor BTC': [
    'deposit BTC-pegged assets worth the capital into the protocol\u2019s vault',
    'mint the protocol\u2019s BTC-backed asset and redeem a small amount',
    'check the peg and rebalance the deposit',
  ],
  'Decentralized BTC': [
    'deposit BTC-pegged assets worth the capital into the protocol\u2019s vault',
    'mint the protocol\u2019s BTC-backed asset and redeem a small amount',
    'check the peg and rebalance the deposit',
  ],
  'CeDeFi': [
    'deposit the capital into the protocol\u2019s centralised-plus-DeFi yield product',
    'withdraw a small amount and deposit it again',
    'review the yield and top up',
  ],
  'Dual-Token Stablecoin': [
    'mint the protocol\u2019s stablecoin with the capital as collateral',
    'swap between the protocol\u2019s two tokens once',
    'adjust the mint position',
  ],
  'Farm': [
    'deposit the capital into the flagship farm',
    'harvest the farm\u2019s rewards and compound them back in',
    'harvest and compound the rewards',
  ],
  'Prediction Market': [
    'buy YES or NO shares in an active market with the capital',
    'trade a second market to record another position',
    'place a small trade in a new market',
  ],
  'Stablecoin Wrapper': [
    'wrap the capital into the protocol\u2019s wrapped stablecoin',
    'unwrap a small amount and wrap it again',
    'wrap or unwrap a small amount',
  ],
  'Uncollateralized Lending': [
    'lend the capital through the protocol\u2019s credit market',
    'fund a second, smaller loan',
    'review loan performance',
  ],
  'Interest Rate Derivatives': [
    'buy the protocol\u2019s fixed-yield token with the capital',
    'trade the variable-yield leg once',
    'roll the position into the next maturity',
  ],
  'Cross Chain Bridge': [
    'bridge the capital to a second chain through the protocol',
    'bridge a small amount back to the origin chain',
    'bridge a small amount to another chain',
  ],
  'CDP Manager': [
    'open a managed CDP position with the capital',
    'adjust the position\u2019s collateral once',
    'check the collateral ratio',
  ],
  'OTC Marketplace': [
    'place an OTC order through the protocol with the capital',
    'complete a second OTC trade in the opposite direction',
    'check new OTC listings',
  ],
  'Insurance': [
    'buy cover for the position from the protocol with the capital',
    'stake a small amount in the protocol\u2019s underwriting pool',
    'review the cover and any claims',
  ],
  'Payments': [
    'pay for a real good or service through the protocol with the capital',
    'receive a payment through the protocol and forward it on',
    'make a small payment through the protocol',
  ],
  'Governance Incentives': [
    'lock the capital in the protocol\u2019s governance vault',
    'vote on an active proposal with the locked position',
    'vote on new proposals',
  ],
  'Crypto Card Issuer': [
    'load the capital onto the protocol\u2019s card and spend a small amount',
    'top up the card a second time',
    'spend a small amount on the card',
  ],
  'Collateral Markets': [
    'deposit the capital as collateral in the protocol\u2019s market',
    'borrow a small amount against it and repay it',
    'adjust the collateral',
  ],
};

const GENERIC_ACTIONS: [string, string, string] = [
  'use the protocol\u2019s main product with the capital (deposit, swap or stake as it offers)',
  'make a second, different transaction in the same product',
  'repeat a qualifying transaction',
];

function capFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Seven steps, in the order a farmer does them: set up, do the main thing,
// do a second distinct thing, keep it up weekly, hold it, watch the rewards,
// log it and know when to leave.
function farmSteps(p: Protocol, age: number | null): string[] {
  const chain = p.chains[0] ?? 'Ethereum';
  const gas = gasNote(chain);
  const capital = capitalFor(p.tvl_usd);
  const hold = holdDays(age);
  const [primary, secondary, weekly] = ACTIONS[p.category ?? ''] ?? GENERIC_ACTIONS;
  return [
    `Open a fresh wallet used only for farming ${p.name}, then fund it with gas on ${chain} (${gas}). Cost: gas only, ${gas} to start. Time: 10 minutes.`,
    `${capFirst(primary)} with $${capital} on ${p.name} (${chain}). Cost: $${capital} of capital plus gas. Time: 15 minutes.`,
    `${capFirst(secondary)} with a small slice of the same capital, as a second, distinct interaction with ${p.name}. Cost: gas only. Time: 10 minutes.`,
    `Once a week, ${weekly} on ${p.name} so the wallet stays active across snapshots. Cost: gas only, about ${gas} a week. Time: 10 minutes a week.`,
    `Leave the position open for at least ${hold} days without withdrawing, so the farm spans the full window this radar scores. Cost: none while holding. Time: ${hold} days of holding.`,
    `Check ${p.name}\u2019s own points or rewards page every week and record any balance; claim only from the protocol\u2019s own published link, and never pay a fee to claim. Cost: none. Time: 5 minutes a week.`,
    `Keep a farm log of every transaction hash, date and amount; when a token launches, or the position stops qualifying, withdraw the capital and stop paying gas. Cost: none. Time: 10 minutes to close out.`,
  ];
}

// ------------------------------------------------------------------ build

interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  implied_value_usd: number;
  cat_multiple: number;
  growth_mult: number;
  age_mult: number;
  watchlist: boolean;
  farm_steps: string[];
}

interface LiveRow {
  slug: string;
  name: string;
  symbol: string | null;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  change_7d: number | null;
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

function main(): void {
  const { input, output } = parseArgs(process.argv.slice(2));
  const snap: Snapshot = JSON.parse(readFileSync(input, 'utf8'));
  const multiples = categoryMultiples(snap.protocols);
  const watchlist = new Set(snap.watchlist);

  // The board: every rankable protocol, ranked by implied value.
  const rows: BoardRow[] = snap.protocols
    .filter(isRankable)
    .map((p) => {
      const age = ageDays(snap.as_of, p.listed_at);
      const catMult = multipleFor(p.category, multiples);
      const gMult = growthMult(p.change_7d);
      const aMult = ageMult(age);
      const implied = Math.max(1, Math.round(p.tvl_usd * catMult * gMult * aMult));
      return {
        slug: p.slug,
        name: p.name,
        rank: 0,
        category: p.category,
        chains: p.chains,
        tvl_usd: p.tvl_usd,
        change_7d: p.change_7d,
        age_days: age,
        implied_value_usd: implied,
        cat_multiple: round4(catMult),
        growth_mult: round4(gMult),
        age_mult: round4(aMult),
        watchlist: watchlist.has(p.slug),
        farm_steps: farmSteps(p, age),
      };
    })
    .sort((a, b) => b.implied_value_usd - a.implied_value_usd || (a.slug < b.slug ? -1 : 1));
  rows.forEach((r, i) => {
    r.rank = i + 1;
  });

  // Live-token protocols, kept apart at market value, never ranked: the 24
  // largest by market cap.
  const live: LiveRow[] = snap.protocols
    .filter((p) => hasToken(p) && p.mcap_usd !== null && p.mcap_usd > 0)
    .sort((a, b) => b.mcap_usd! - a.mcap_usd! || (a.slug < b.slug ? -1 : 1))
    .slice(0, 24)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      symbol: p.symbol,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      change_7d: p.change_7d,
    }));

  // Guardrails: a board that fails them is not written.
  if (rows.length < 100 || rows.length > 4000) throw new Error(`board has ${rows.length} rows`);
  for (const slug of snap.watchlist) {
    if (!rows.some((r) => r.slug === slug)) throw new Error(`watchlist slug missing: ${slug}`);
  }
  for (const r of rows) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) throw new Error(`bad step count for ${r.slug}`);
    for (const s of r.farm_steps) {
      const n = s.trim().length;
      if (n < 20 || n > 600) throw new Error(`bad step length ${n} for ${r.slug}`);
    }
  }

  const repoRoot = dirname(fileURLToPath(import.meta.url));
  mkdirSync(output, { recursive: true });
  mkdirSync(join(output, 'dashboard'), { recursive: true });
  mkdirSync(join(output, 'screenshots'), { recursive: true });

  writeFileSync(join(output, 'board.json'), JSON.stringify({ rows }));

  const data = {
    as_of: snap.as_of,
    source: snap.source,
    floor_usd: snap.floor_usd,
    model: 'implied = TVL x category multiple x growth multiplier x age multiplier',
    model_version: MODEL_VERSION,
    category_multiples: multiples.byCategory,
    global_multiple: multiples.global,
    watchlist_size: snap.watchlist.length,
    board_size: rows.length,
    early_size: rows.length - snap.watchlist.length,
    live_size: live.length,
    rows,
    live,
  };
  writeFileSync(join(output, 'data.js'), `window.RADAR = ${JSON.stringify(data)};\n`);

  cpSync(join(repoRoot, 'dashboard'), join(output, 'dashboard'), { recursive: true });
  cpSync(join(repoRoot, 'screenshots'), join(output, 'screenshots'), { recursive: true });

  const dossier = buildDossier(output, {
    text_max_bytes: TEXT_MAX_BYTES,
    screenshots: { max: 4, max_bytes: 524288 },
    dashboard: { max_files: 400, max_bytes: 4 * 1024 * 1024 },
  });
  writeFileSync(join(output, 'dossier.json'), dossier);

  const top = rows[0]!;
  console.log(
    `radar-2: ${rows.length} board rows (${snap.watchlist.length} watchlist, ${rows.length - snap.watchlist.length} early), ` +
      `${live.length} live shown, global multiple ${multiples.global}. ` +
      `Top: ${top.name} at $${top.implied_value_usd.toLocaleString('en-US')}. ` +
      `Dossier ${dossier.length} bytes -> ${output}`,
  );
}

main();
