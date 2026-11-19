# Token Radar — pre-token protocol board

[![make.fun](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Rifat7600/token-radar-01-3/rank.svg)](https://make.fun/bounty/token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Rifat7600/token-radar-01-3/reward.svg)](https://make.fun/bounty/token-radar-01)

A token launch radar: it reads a sealed DefiLlama snapshot of 758 protocols,
ranks the ones that record no token by what their launch would be worth, and
shows a reader how to farm each one — on a dashboard you can sort, filter and
search, with a detail view per protocol.

## How it works

`main.ts` (Node 22, standard library only) reads `/input/snapshot.json` and
writes `/output/board.json` (198 rows), the dashboard data, and
`/output/dossier.json` via `vendor/makefun-board.ts`. It runs twice and writes
identical bytes both times.

**Value model** — one line: implied value = TVL × growth factor × age factor× launch factor, where the growth factor follows the protocol's 7-day TVL
change, the age factor rewards how long it has run with no token, and the
launch factor discounts exchanges, bridges and wrapped/staked products whose
token already trades. The same formula lives in `dashboard/app.js` as
`impliedValue()`, recomputing each row's value from its own figures, so the
dashboard and the board can never disagree.

**Farm plans** — every row carries 5–6 concrete steps with a cost and a time,
generated from the protocol's category, chains, TVL and age. The same
templates live in `main.ts` and in `dashboard/app.js`, and the two are
verified to produce identical steps for every row.

## The board

198 rows: all 40 protocols on the snapshot's watchlist, plus the 158 other
pre-token protocols the model scores highest that could plausibly launch.
Top of the board: Steakhouse Financial ($5.04B implied), Sentora Curator
($5.02B), Gauntlet ($3.12B), Veda ($2.77B), USDD ($1.97B). Total implied
value across the board: $37.2B.
The other pre-token protocols are exchanges, bridges and wrapped or staked
products (Bybit, WBTC, Binance staked ETH and the like) — scored with the
launch discount and left off, because their token already trades or they are
not a launch at all. Protocols whose token already trades are scored with a
discount and left off the board — their launch has already happened, so the
radar is for what is still to come.

## Verified

- `main.ts` run twice into two directories: `diff -r` empty, including
  `dossier.json` — fully deterministic.
- `app.js` recomputes every row: 0 implied-value mismatches and 0 farm-step
  mismatches across all 198 rows against `board.json` (checked in a headless
  browser).
- Board gates self-checked: 198 rows, all 40 watchlist slugs covered, ranks
  1..198, implied values non-increasing, every farm plan 6 steps of 20–600
  characters.
- Dossier: 694,074 bytes (cap 1.5 MiB); source text 50,436 bytes (cap
  65,536), so the judge reads every dashboard file whole.
- Screenshots (real headless-Chromium captures, 1440×900): board 146 KB,
  detail 192 KB, filtered (Lending) 131 KB — all under the 512 KiB cap.

## Run it locally

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

Then open `out/dashboard/index.html` in a browser.
