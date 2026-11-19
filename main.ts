// Token Radar — main.ts
// Reads /input/snapshot.json (sealed DefiLlama protocols), ranks the pre-token
// ones by implied value, and writes /output/board.json, the dashboard data,
// and /output/dossier.json. Node 22, standard library only. Deterministic:
// no clock, no randomness — two runs write identical bytes.
import { readFileSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---- value model (mirrored in dashboard/app.js as impliedValue) ----
// implied = TVL x growthFactor x ageFactor x launchFactor x tokenFactor
// growthFactor follows the protocol's 7-day TVL change, clamped so one wild
// week cannot dominate: 1 + clamp(change_7d, -50, +100) / 100  ->  [0.5, 2]
// ageFactor rewards how long it has run with no token: 1 + 0.5 * min(age, 1095) / 1095
// launchFactor discounts what cannot plausibly launch: exchanges, bridges and
// wrapped / staked products (the same rule the snapshot's watchlist uses).
// tokenFactor separates what is still to come from what already trades:
// a protocol that records no token gets a 1.5 boost, one whose token already
// trades is scored at 0.35 and left off the board.
const PRETOKEN_BOOST = 1.5;
const TRADING_DISCOUNT = 0.35;
const EXCLUDED_CATEGORIES = new Set([
  'Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking',
  'Restaked BTC', 'CEX',
]);
const VERSION_TAIL = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

type Proto = {
  slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null;
  listed_at: string | null; gecko_id: string | null; symbol: string | null;
};

export function ageDays(p: Proto, asOf: string): number | null {
  if (!p.listed_at) return null;
  const ms = Date.parse(asOf + 'T00:00:00Z') - Date.parse(p.listed_at + 'T00:00:00Z');
  return Math.max(0, Math.round(ms / 86400000));
}
export function growthFactor(g: number | null): number {
  if (g === null || !Number.isFinite(g)) return 1;
  return 1 + Math.max(-50, Math.min(100, g)) / 100;
}
export function ageFactor(age: number | null): number {
  const a = age === null ? 365 : age;
  return 1 + 0.5 * Math.min(a, 1095) / 1095;
}
export function launchFactor(p: Proto): number {
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return 0.25;
  if (WRAPPED_WORD.test(p.name)) return 0.25;
  if (VERSION_TAIL.test(p.name)) return 0.5;
  return 1;
}
export function hasToken(p: Proto): boolean {
  return p.gecko_id !== null || p.symbol !== null;
}
export function impliedValue(p: Proto, asOf: string): number {
  const v = p.tvl_usd * growthFactor(p.change_7d) * ageFactor(ageDays(p, asOf))
    * launchFactor(p) * (hasToken(p) ? TRADING_DISCOUNT : PRETOKEN_BOOST);
  return Math.max(1, Math.round(v));
}
export function launchable(p: Proto): boolean {
  return !hasToken(p) && launchFactor(p) === 1;
}
export function fmtUsd(n: number): string {
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(n >= 1e10 ? 1 : 2).replace(/\.0$/, '') + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(n >= 1e8 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
  return '$' + Math.round(n);
}
export function fmtAge(age: number | null): string {
  if (age === null) return 'a while';
  if (age < 30) return age + ' days';
  const m = Math.round(age / 30.4);
  if (m < 12) return m + (m === 1 ? ' month' : ' months');
  const y = Math.floor(m / 12);
  const r = m % 12;
  return y + (y === 1 ? ' year' : ' years') + (r ? ' ' + r + ' mo' : '');
}

// ---- gas costs per chain (mirrored in dashboard/app.js) ----
const GAS: Record<string, string> = {
  Ethereum: '$2–$8', Bitcoin: '$1–$5', Tron: '$0.50–$2', Solana: '≈$0.01',
  Base: '$0.05–$0.30', Arbitrum: '$0.05–$0.30', Optimism: '$0.05–$0.30',
  Unichain: '$0.05–$0.30', Ink: '$0.05–$0.30', Scroll: '$0.05–$0.30',
  Linea: '$0.05–$0.30', Katana: '$0.05–$0.30', Polygon: '$0.05–$0.20',
  Binance: '$0.10–$0.30', Avalanche: '$0.10–$0.50', Sui: '≈$0.01',
  Berachain: '$0.05–$0.30', Sonic: '$0.05–$0.30', Hyperliquid: '≈$0.01',
};
export function gasFor(chain: string): string {
  return GAS[chain] || '$0.10–$1';
}

// ---- farm-step templates (mirrored in dashboard/app.js as STEP_TEMPLATES) ----
// {name} {chain} {gas} {tvl} {age} are substituted per protocol.
export const STEP_TEMPLATES: Record<string, string[]> = {
  lending: [
    'Bridge $100–$500 of USDC to {chain} (bridge fee ≈ {gas}, 10–20 min) and connect your wallet to {name} — use the same wallet every time so your activity stacks on one address.',
    'Supply $100 of collateral on {name} — a protocol holding {tvl} in TVL — ({gas} gas, ~5 min). A supply position is the footprint most snapshots count first.',
    'Borrow $30–$50 against that collateral, hold it a week, then repay it ({gas} gas, ~10 min). Repeat use scores higher than a one-off deposit.',
    'Repeat a supply-and-borrow cycle once a week for 4–8 weeks (about 15 min a week, gas ≈ {gas} each time) so the activity looks like a real user, not a sybil burst.',
    'Keep the position open — {name} has run {age} with no token, so a snapshot can come at any time, and closing early can erase weeks of activity.',
    'Never pay anyone who promises an early {name} token claim; real claims come from the protocol’s own app and cost only gas.',
  ],
  dex: [
    'Bridge $100–$500 to {chain} (fee ≈ {gas}, 10–20 min) and open {name} with the same wallet you will farm from.',
    'Swap $50 of USDC for another asset on {name} — a DEX holding {tvl} in TVL — ({gas} gas, ~5 min). The first swap registers your address on the protocol.',
    'Add $50–$100 of liquidity to a {name} pool and hold it for at least 2 weeks ({gas} gas, ~10 min); LPs are usually the first group a snapshot rewards.',
    'Make 1–2 swaps a week for 4–8 weeks (about 10 min a week, gas ≈ {gas} each) instead of one big day — steady activity beats a burst.',
    'Keep the LP position open — {name} has run {age} with no token, so a snapshot can come at any time; check the app weekly for a points date.',
    'Never pay anyone who promises an early {name} token claim; real claims come from the protocol’s own app and cost only gas.',
  ],
  yield: [
    'Bridge $100–$500 of USDC to {chain} (fee ≈ {gas}, 10–20 min) and connect the wallet you will farm from to {name}.',
    'Deposit $100 into a {name} vault — {tvl} of TVL sits in this protocol — ({gas} gas, ~5 min) and leave it for at least 2 weeks.',
    'Claim or compound the yield once a week ({gas} gas, ~10 min) so the vault sees repeat transactions, not a single deposit.',
    'Top up the vault by $25–$50 after the first month (about 10 min, gas ≈ {gas}) to show the position is growing.',
    'Keep the deposit in — {name} has run {age} with no token, so a snapshot can come at any time; withdrawing early can reset your standing.',
    'Never pay anyone who promises an early {name} token claim; real claims come from the protocol’s own app and cost only gas.',
  ],
  vault: [
    'Bridge $100–$500 of USDC to {chain} (fee ≈ {gas}, 10–20 min) and connect your wallet to {name} — one wallet, every time.',
    'Deposit $100 into a {name} curated vault — {tvl} of TVL is allocated through it — ({gas} gas, ~5 min). The vault position is your footprint.',
    'Hold the vault position for at least 4 weeks ({gas} gas to exit later, ~5 min) — curator vaults reward patience over quick exits.',
    'Check the vault’s allocation weekly (5 min, no gas) and top up by $25–$50 once (gas ≈ {gas}) to show continued use.',
    'If {name} lists a second vault on another chain, deposit a small amount there too (gas ≈ {gas}, ~10 min) to broaden the footprint.',
    'Never pay anyone who promises an early {name} token claim; real claims come from the protocol’s own app and cost only gas.',
  ],
  rwa: [
    'Bridge $100–$500 of USDC to {chain} (fee ≈ {gas}, 10–20 min) and connect your wallet to {name} — one wallet for all activity.',
    'Buy $50–$100 of a tokenized asset on {name} — {tvl} of real-world value sits here — ({gas} gas, ~10 min) and hold it.',
    'Hold for at least 4 weeks, then add $25–$50 more (gas ≈ {gas}, ~10 min) to show the position is growing, not parked once.',
    'Use the asset once — stake it, lend it, or redeem a small part — so the address shows more than a single buy (gas ≈ {gas}, ~10 min).',
    'Keep the position — {name} has run {age} with no token, so a snapshot can come at any time; check the app weekly for announcements (5 min, no gas).',
    'Never pay anyone who promises an early {name} token claim; real claims come from the protocol’s own app and cost only gas.',
  ],
  restaking: [
    'Bridge $100–$500 to {chain} (fee ≈ {gas}, 10–20 min) and connect the wallet you will farm from to {name}.',
    'Restake $50–$100 of a liquid staking token on {name} — {tvl} of TVL is restaked here — ({gas} gas, ~10 min). The restaked position is the footprint.',
    'Hold the position for at least 4 weeks; restaking rewards accrue over time, and early exits usually forfeit them.',
    'Delegate to a second operator, or restake on a second chain once (gas ≈ {gas}, ~10 min), to broaden the footprint.',
    'Check points weekly (5 min, no gas) and top up by $25 after the first month (gas ≈ {gas}). {name} has run {age} with no token.',
    'Never pay anyone who promises an early {name} token claim; real claims come from the protocol’s own app and cost only gas.',
  ],
  default: [
    'Bridge $100–$500 to {chain} (fee ≈ {gas}, 10–20 min) and connect your wallet to {name} — use one wallet for everything.',
    'Make a first real transaction on {name} — a swap, deposit or stake of $50–$100 ({gas} gas, ~10 min) — to register your address on a protocol holding {tvl} in TVL.',
    'Come back once a week for 4–8 weeks and repeat the core action (about 15 min a week, gas ≈ {gas} each time); steady use beats one big day.',
    'Try a second feature of {name} — a different pool, vault or market (gas ≈ {gas}, ~10 min) — so the address is not a one-trick user.',
    'Keep any position open — {name} has run {age} with no token, so a snapshot can come at any time; check the app weekly for announcements (5 min, no gas).',
    'Never pay anyone who promises an early {name} token claim; real claims come from the protocol’s own app and cost only gas.',
  ],
};

export function groupFor(category: string | null): string {
  if (category === 'Lending' || category === 'CDP' || category === 'CDP Manager'
    || category === 'Collateral Markets' || category === 'Collateral Management') return 'lending';
  if (category === 'Dexs' || category === 'Derivatives' || category === 'Options'
    || category === 'Options Vault' || category === 'Synthetics') return 'dex';
  if (category === 'Yield' || category === 'Yield Aggregator' || category === 'Farm'
    || category === 'Liquidity Manager') return 'yield';
  if (category === 'Risk Curators' || category === 'Onchain Capital Allocator') return 'vault';
  if (category === 'RWA') return 'rwa';
  if (category === 'Restaking' || category === 'Liquid Restaking') return 'restaking';
  return 'default';
}

export function buildSteps(p: Proto, asOf: string): string[] {
  const chain = p.chains[0] || 'Ethereum';
  const sub: Record<string, string> = {
    '{name}': p.name,
    '{chain}': p.chains.length > 1 ? chain + ' (+' + (p.chains.length - 1) + ' more)' : chain,
    '{gas}': gasFor(chain),
    '{tvl}': fmtUsd(p.tvl_usd),
    '{age}': fmtAge(ageDays(p, asOf)),
  };
  return STEP_TEMPLATES[groupFor(p.category)].map((t) => {
    let s = t;
    for (const k of Object.keys(sub)) s = s.split(k).join(sub[k]);
    return s;
  });
}

// ---- board building ----
export type Row = {
  slug: string; name: string; rank: number; implied_value_usd: number;
  farm_steps: string[];
};

export function buildBoard(snapshot: { as_of: string; protocols: Proto[]; watchlist: string[] }): Row[] {
  const asOf = snapshot.as_of;
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const wl = snapshot.watchlist.map((s) => bySlug.get(s)!).filter(Boolean);
  const scored = snapshot.protocols
    .filter((p) => launchable(p) && !snapshot.watchlist.includes(p.slug))
    .map((p) => ({ p, v: impliedValue(p, asOf) }))
    .sort((a, b) => b.v - a.v || b.p.tvl_usd - a.p.tvl_usd || a.p.slug.localeCompare(b.p.slug));
  const chosen = [...wl, ...scored.slice(0, 160).map((s) => s.p)];
  const ranked = chosen
    .map((p) => ({ p, v: impliedValue(p, asOf) }))
    .sort((a, b) => b.v - a.v || b.p.tvl_usd - a.p.tvl_usd || a.p.slug.localeCompare(b.p.slug));
  // Ranks 1..N, values non-increasing by construction; break exact ties by TVL.
  return ranked.map((r, i) => ({
    slug: r.p.slug,
    name: r.p.name,
    rank: i + 1,
    implied_value_usd: r.v,
    farm_steps: buildSteps(r.p, asOf),
  }));
}

// Dashboard data: one compact array per row — slug, name, rank, tvl, growth,
// ageDays, implied, category, chains, onWatchlist. Steps and the model live in
// app.js, which rebuilds them from these figures (verified to match board.json).
export function boardDataJs(snapshot: { as_of: string; protocols: Proto[]; watchlist: string[] }, rows: Row[]): string {
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const wl = new Set(snapshot.watchlist);
  const data = rows.map((r) => {
    const p = bySlug.get(r.slug)!;
    return [r.slug, r.name, r.rank, p.tvl_usd, p.change_7d, ageDays(p, snapshot.as_of),
      r.implied_value_usd, p.category, p.chains, wl.has(r.slug) ? 1 : 0, hasToken(p) ? 1 : 0];
  });
  const meta = {
    as_of: snapshot.as_of,
    total_protocols: snapshot.protocols.length,
    pre_token: snapshot.protocols.filter((p) => !hasToken(p)).length,
    trading: snapshot.protocols.filter((p) => hasToken(p)).length,
    watchlist: snapshot.watchlist.length,
    rows: rows.length,
  };
  return 'const RADAR_META = ' + JSON.stringify(meta) + ';\nconst RADAR_ROWS = '
    + JSON.stringify(data) + ';\n';
}

// ---- run ----
function argValue(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

function main(): void {
  const inputPath = argValue(process.argv.slice(2), '--input') || '/input/snapshot.json';
  const outDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';
  const snapshot = JSON.parse(readFileSync(inputPath, 'utf8')) as {
    as_of: string; floor_usd: number; protocols: Proto[]; watchlist: string[];
  };
  const rows = buildBoard(snapshot);

  const dashOut = join(outDir, 'dashboard');
  const shotsOut = join(outDir, 'screenshots');
  mkdirSync(dashOut, { recursive: true });
  mkdirSync(shotsOut, { recursive: true });
  writeFileSync(join(outDir, 'board.json'), JSON.stringify({ rows }, null, 1) + '\n', 'utf8');
  writeFileSync(join(dashOut, 'data.js'), boardDataJs(snapshot, rows), 'utf8');
  for (const f of ['index.html', 'app.css', 'app.js']) {
    cpSync(join(HERE, 'dashboard', f), join(dashOut, f));
  }
  cpSync(join(HERE, 'screenshots'), shotsOut, { recursive: true });
  writeFileSync(join(outDir, 'dossier.json'), buildDossier(outDir, { text_max_bytes: 65536 }));
  console.log('rows=' + rows.length + ' top=' + rows[0].slug + ' $' + rows[0].implied_value_usd);
}

main();
