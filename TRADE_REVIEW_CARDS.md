# Trade Review Cards — integration & regeneration

Per-trade "Review / Обзор" modal cards on the live results pages
(`trades.html`, `equities-trades.html`, and the belfed.ru mirror). The pages'
existing design, CSV data flow, stats and year filter are unchanged — the modal
layer is additive and fully scoped under `.brc-*`.

## Files

| File | Role |
|------|------|
| `trade-review.js` | Modal layer. `window.BelfedReview.attachButton(cell, data)` adds a Review button to a trade's Analysis cell and opens an accessible modal (`role="dialog"`, `aria-modal`, ESC / backdrop close, Tab focus-trap, focus restore). No storage APIs. Language auto-detected from hostname (`belfed.ru` → RU, else EN). |
| `trade-review.css` | Scoped styles for the trigger button + modal + card content. Inherits each page's existing `:root` colour tokens; adds no global rules. |
| `trade_review_cards.json` | Static manifest of pre-rendered cards, keyed by trade. Generated — do not hand-edit. |
| `build_draft_preview.py` | Generator for both the preview and the manifest. |

## How a card is chosen (runtime, identical for every closed trade incl. future)

1. Each visible closed row calls `attachButton` with its CSV fields
   (`ticker, dir, entryDate, exitDate, entryP, exitP, result, tvLink`).
2. On click, the module looks the trade up in `trade_review_cards.json` by
   `TICKER|ENTRY_ISO|EXIT_ISO` (falling back to the unambiguous `TICKER|ENTRY_ISO`
   alias).
   - **Hit** → pre-rendered card for the active language (bot trades get the rich
     timeline card; others get the legacy card).
   - **Miss** (e.g. a trade closed after the last manifest rebuild) → the module
     builds a **legacy fallback card** from the row's own visible fields
     (Original Analysis pill from the TradingView link, ledger fields, muted
     methodology, trial promo CTA). No timeline is ever fabricated for
     non-manifest trades.

So new closed trades automatically receive a card in the agreed style and by the
same algorithm with no code change. Rebuild the manifest to upgrade a
just-closed trade from the fallback card to a curated one (and to give bot trades
their rich timeline).

## Structured manual enrichments

Exceptionally, a reviewed public idea can carry a `manual.en` object in its
manifest entry. This is structured content (not prebuilt HTML) for the three
flat card sections rendered by `trade-review.js`: `SET-UP LOGIC`, `RISK &
EXECUTION`, and `RESULT CALCULATION`.

- The renderer inserts the block after the existing header/metrics and before
  the existing timeline or methodology, so original card data and Telegram links
  remain intact.
- A manual entry may provide a `header` object when there is no historical card
  HTML yet; the normal fallback card still supplies its methodology and promo.
- Use `kind: "manual"` for a manual-only card. The scheduled fill treats that
  kind as protected and never overwrites it. Existing `bot` cards may also carry
  `manual.en`; their lifecycle history continues to be preserved.
- Keep the full and safe keys collision-safe. Add an entry-date alias only when
  it is unambiguous, following the same rules as every other manifest card.

## Automatic refresh after a trade closes

`.github/workflows/refresh-review-manifest.yml` (daily 06:23 UTC +
`workflow_dispatch`) runs `refresh_review_manifest.js`, which:

1. reads the live ledger worksheets from the public gviz CSV export (no secret),
2. reads the subscriber-signal lifecycle through the token-gated Supabase RPC
   `export_review_card_data`, which returns only closed archived positions with
   the card fields already whitelisted server-side (the same whitelist is
   re-applied client-side) — no profiles, subscriptions or user ids ever leave
   the database,
3. recovers the CSV→sheet row offset from `sheet_row_id` instead of assuming it,
4. reuses `build_review_manifest.js` `reconcile()`/`fill()` to upgrade closed
   trades that have genuine EN history and no bot card yet,
5. writes and commits `trade_review_cards.json` **only** when its bytes change.

The run is idempotent — nothing newly closed means no write and no commit.

The export call is `POST ${SUPABASE_URL}/rest/v1/rpc/export_review_card_data`
with `apikey: ${SUPABASE_PUBLISHABLE_KEY}` and body `{"p_token": …}`; the
publishable key is public and the export token is the actual gate, so **no
service-role key is used anywhere in this path**. Repository secrets:
`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_CARD_EXPORT_KEY`.

There is no degraded mode. A missing secret, a rejected token, a non-`https`
project URL or a payload that fails shape validation (missing `generated_at`,
non-array collections, an empty export, a position without `id`/`sheet_row_id`,
duplicate ids) aborts with a non-zero exit and leaves the manifest untouched —
a half-refreshed card is worse than a stale one, so the schedule goes red
instead.

Preview locally with `node refresh_review_manifest.js --dry-run`.

## Regenerating the manifest by hand

```
node build_review_manifest.js audit [dataDir] [outCsv]   # reconcile, never writes
node build_review_manifest.js fill  [dataDir] [manifest] # upgrade gaps in place
```

`dataDir` holds a captured `crypto_rows.json`, `equities_rows.json` and
`supabase_audit.json`; it defaults to `$BELFED_AUDIT_DIR`. These exports are
production data and must not be committed.

Deploy the regenerated `trade_review_cards.json` alongside `trade-review.js` /
`trade-review.css` at the site root.

## Language separation

`.com` serves EN, `.ru` serves RU (module picks by hostname). Source comments are
routed by *detected content language*, not the mislabeled sheet column. The only
cross-language text that remains by design is the verbatim bot-timeline
subscriber messages (quoted exactly as originally published).

## Deployment (both domains)

Publish these files at the web root of belfed.com **and** belfed.ru:

- `/trade-review.js`
- `/trade-review.css`
- `/trade_review_cards.json`

The page edits (asset `<link>`/`<script>` + one `attachButton` call in the CSV
row loop) are already in `trades.html` and `equities-trades.html`; mirror the same
two edits into the belfed.ru results pages (no `.ru` HTML exists in this repo).
No CSP change is needed — all three assets are same-origin and covered by the
existing `script-src 'self'` / `style-src 'self'` / `connect-src 'self'`.
