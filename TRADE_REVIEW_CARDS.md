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

## Regenerating the manifest

```
python3 build_draft_preview.py preview/tier1_real_recaps.json trade-history-preview.html trade_review_cards.json
```

- Arg 1: recap data (`preview/tier1_real_recaps.json`; override the data dir with
  `BELFED_DATA_DIR`).
- Arg 2: preview HTML (side output, safe to ignore for production).
- Arg 3 (optional): manifest path, defaults to `trade_review_cards.json`.

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
