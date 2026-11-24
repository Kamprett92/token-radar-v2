# token-radar-v2

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Kamprett92/token-radar-v2/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Kamprett92/token-radar-v2/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token Radar (model radar-2) — the best token launch radar: a program that reads a
sealed DefiLlama snapshot of 758 protocols, ranks every protocol that records no
token by what its token would be worth if it launched, and writes a dashboard
that shows the board, each protocol's farm plan, and the live-token comparables
the prices come from. An entry for make.fun's "Build the best token launch
radar" bounty ($1,325 in USDC).

## The model

```
implied value = TVL × category multiple × growth multiplier × age multiplier
```

- **Category multiple** — the median market-cap/TVL of live-token protocols in the
  same category (at least 3 comparables), otherwise the global comparable median
  (0.229x here), clamped to 0.05–1.50. A DEX is not priced like a lending market:
  Dexs 0.342x, Lending 0.131x, RWA 0.275x, Basis Trading 0.654x, Cross Chain
  Bridge 1.220x. The multiples are measured from the snapshot itself at run time;
  no protocol name is special-cased.
- **Growth multiplier** — 1 + clamp(7-day TVL change, −50%, +100%) × 0.5. Momentum
  counts, but one wild week (the snapshot's max is +4448%) cannot more than 1.5x a
  protocol.
- **Age multiplier** — 0.80 + 0.20 × min(age, 730 days) / 730. Age is a weak signal;
  category and growth do the work.

## The board

198 rows: the watchlist's 40 protocols plus every other protocol the house's own
exclusion rule keeps. Wrapped, staked and bridged products of tokens that already
trade are never ranked — WBTC is Bitcoin on Ethereum, Binance staked ETH is ETH
in a staking product, and neither is a protocol still waiting on a launch of its
own. Versioned pools and exchange products are out for the same reason. The 24
largest live-token protocols are shown apart, at market value, never ranked.

Every row carries a 7-step farm plan derived from the protocol's own record
(category, first chain, TVL, age): set up a fresh wallet with chain-specific gas,
the main on-chain action with exact capital ($250 / $150 / $100 / $50 by TVL tier),
a second distinct interaction, a weekly qualifying action, a hold window
(60 / 45 / 30 days by age), a points check that only ever claims from the
protocol's own published link, and a farm log with an exit plan. Each step states
its cost and time.

## The dashboard

A dark radar page (no network anywhere): the board with search, category and chain
filters, a watchlist-only toggle and sorting; a detail view per protocol with the
model breakdown (TVL × multiple × growth × age = implied, each factor shown) and
its farm plan; the methodology and the category-multiple table rendered from the
data; deep links via `#detail:&lt;slug&gt;`, `#filter:&lt;category&gt;` and
`#watchlist`.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to-snapshot.json>
```

`main.ts` (Node 22, standard library only) reads the snapshot, writes
`board.json` (198 rows), `data.js`, copies `dashboard/` and `screenshots/` to the
output directory, and writes `dossier.json` with `buildDossier` from
`vendor/makefun-board.ts`. Two runs on the same input write identical bytes.

## Layout

- `main.ts` — the program: snapshot in, board + dashboard data + dossier out.
- `dashboard/` — `index.html`, `app.css`, `app.js` (19 KB in all; the dossier's
  text cap is 65,536 bytes).
- `screenshots/` — the board, a protocol's detail view, and the watchlist-filtered
  view, each 1440×900 and 177–187 KB, under the 512 KiB cap.
- `vendor/makefun-board.ts` — the kit's dossier library, byte for byte.

## Verification

Two runs on the sealed snapshot write byte-identical output (deterministic), and
all seven gate rows pass locally: dashboard files, board file, sorted-by-value,
coverage (40/40 watchlist), farm steps (1,386 steps, all 20–600 characters),
screenshots, and dossier-matches (dossier 758 KB, under the 1.5 MiB cap).

---

<sub>Entered on [make.fun](https://make.fun/?ref=t1yg6scf&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
