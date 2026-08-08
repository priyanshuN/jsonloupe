# Design-system audit — jsonloupe vs Primer & Carbon

> **STATUS: EXECUTED 2026-08-08, same day.** Everything below was implemented: the two state
> defects fixed (`:active` leak, dead `button.ghost` deleted), the rule-23 type ramp (`--fs-*`,
> 8 steps) with a 112-declaration sweep, spacing/radius/bar-height/glow restatements tokenized
> (96 more substitutions), the `code.ts` editor palette moved onto tokens (light's editor
> cursor/selection family deliberately unified onto `--accent` from its pre-brand blue),
> syntax-ink contrast floors added and three values fixed (`--c-number`, `--c-null`,
> `--c-punct`), the `prefers-contrast` focus fallback shipped, dead tokens deleted, and the
> linter extended to enforce all of it (type ramp, restatements, dead tokens, syntax floors).
> Verified: lint clean · 362/362 tests · full build · live browser checks. The table below is
> the pre-execution snapshot, kept for the reasoning.

2026-08-08 · benchmarked against GitHub Primer (primitives @ main) and IBM Carbon (v11 @ main),
with Atlassian's token-ESLint plugin as the enforcement reference. Inventory measured on
`src/style.css` (comments stripped: 51% of the file), `src/code.ts`, and the three HTML entries.

**Reading the grades:** ✅ meets or exceeds the standard *at this project's scale* ·
🟡 gap worth work · 🔴 defect. "At scale" matters: Primer serves 14 themes and hundreds of
consumers; importing its machinery wholesale would be cosplay. The question per axis is whether
jsonloupe has the *shape* the standards converge on, sized honestly.

| Axis | jsonloupe today | Primer / Carbon | Verdict |
|---|---|---|---|
| Color tokens | 47 semantic tokens, ~100% funneled (1 raw rgba) | 3 layers / primitives+roles | ✅ single layer is correct for 2 themes |
| Theming | 2 themes = 2 token blocks | 14 themes / 4 themes, same mechanism | ✅ same shape, honest scale |
| Font weights | **2** (400/700), lint-enforced | 4 / 3 | ✅ exceeds — stricter than both, platform-justified |
| Motion | 1 duration + 1 easing, **100% tokenized** | 4+5 semantic / 6×6 matrix | ✅ right count for a tool with no expressive moments |
| Contrast | machine-enforced floors, both themes | Primer: ~100 asserted pairs in CI | ✅ same pattern (Primer's `colorContrast.ts`, hand-rolled) |
| Reduced motion | one global collapse block | Primer: policy / Carbon: guidance only | ✅ exceeds Carbon |
| Enforcement | `lint-contract.mjs` in CI | stylelint plugins / carbon-tokens plugin / Atlaskit ESLint | ✅ the pattern, scaled down |
| Docs | in-file contract + `/styleguide.html` | doc sites + Storybooks | ✅ at scale |
| Radii | 72% tokenized | fully tokenized | 🟡 small: 15 literal stragglers, `999px` pill ×4 |
| Shadows | 50% tokenized | fully tokenized | 🟡 small: focus-glow recipe ×6, one raw dialog shadow |
| Z-index | 6 ad-hoc values, monotonic | scales exist but rule 21 (top-layer) does the real work | 🟡 optional naming |
| Spacing | **26% tokenized**; 69 literals restate a `--gap-*` value; 139 off the 4px grid | 19+6 steps / 13 steps | 🟡 real gap — see below |
| **Font sizes** | **22 distinct literals, 0 tokens** | **6 steps + 11 roles / named styles** | 🔴 the biggest gap |
| Line-height / letter-spacing | 9 / **16 distinct** values, 0 tokens | bundled into type roles | 🔴 same gap, same fix |
| Interactive states | `:disabled` ×2 in whole file; `:active` leaks (below) | states are first-class token names | 🔴 two live defects |

## The two defects (state axis)

1. **`:active` leak on the quiet family.** `.btn-quiet`, `.tb-chip`, and `.mode-switch button`
   define no `:active`, so the base `button:active { background: var(--btn-bg-active) }` wins on
   press — a transparent control flashes the bordered tier's pressed background. One rule fixes
   all three (press = `--bg-hover`, same as their hover family).
2. **`button.ghost` is an undocumented 4th tier.** Rule 6 says three tiers; the file ships four.
   Either it earns a sentence in rule 6 or it merges into `.btn-quiet`.

## The big gap: a type ramp (proposed rule 24)

22 sizes is the weight-rot pattern on a third axis — six of them (11 → 13.5) sit within 2.5px of
each other. Primer's shape is the right one to borrow: a small base ramp plus *composite roles*
(size + line-height + letter-spacing together), not three parallel token sets. Sketch:

| Proposed | Value | Absorbs |
|---|---|---|
| `--fs-micro` | 10px | 9, 9.5, 10 |
| `--fs-label` | 10.5px | 10.5 (uppercase micro-labels) |
| `--fs-chip` | 11.5px | 11, 11.5 |
| `--fs-body` | 12.5px | 12, 12.5 (the app's voice — 45 uses) |
| `--fs-code` | 13px | 13, 13.5 |
| `--fs-title` | 16px | 14.5, 15, 16 |
| landing/spec | keep display-face freedom | 17–58px, marketing scale |

The absorptions marked here are **stare decisions, not mechanical** — each merge changes real
pixels. Letter-spacing folds into the ranks that use it (the two uppercase label ranks), which
retires 14 of the 16 distinct values. Lint learns the ramp the same commit rule 24 lands.

## Spacing: tokenize the restatements, rule on the rest

- **Mechanical, zero visual change:** 69 literals that exactly restate `--gap-*` values
  (4/8/12/16px) become tokens. Lint then bans a literal that equals a token value.
- **Judgment call to make once:** the 139 off-grid values (5px ×14, 9px ×7, 18px ×19…) are
  largely deliberate optical nudges from stare passes. The standards would quantize them; I
  wouldn't — but the contract should *say* the 4px grid is default and off-grid is an optical
  decision, so drift and intent stay distinguishable.

## The second color system: `code.ts`

The CodeMirror palette holds **17 raw colors per theme** in `DARK`/`LIGHT` objects — only `bg`
reads a token. This is the one place "a theme is a token block" is currently false: a third theme
would silently not theme the editor. Fix: point the palette at the existing `--c-*` syntax tokens
(they already exist in both blocks) and let `code.ts` carry only what has no token.

## Small-change backlog

- `--bar-h: 44px` (stated in contract comments ×8, never became a token) · `--r-pill: 999px` ·
  `--focus-glow` for the `0 0 0 3px` recipe ×6 · tokenize the one raw dialog shadow
- Delete 4 dead tokens: `--accent-hover`, `--btn-inset`, `--c-punct`, `--warn-soft` — and teach
  the linter a defined-but-unused check (Primer's `no-unused-vars`, ours for free)
- The repeated `color-mix(danger 45%, border)` recipe ×3 → token; the other 18 single-use
  recipes are fine inline
- Focus ring: add the `prefers-contrast` dotted fallback Carbon ships

## Suggested order

1. State defects (bug fixes, minutes)
2. Type ramp — rule 24 + stare-mapped merges + lint (the one real project)
3. Spacing restatements + grid rule (mechanical + one contract sentence)
4. `code.ts` palette onto tokens (theming correctness)
5. Small-change backlog + lint extensions

Not imported, deliberately: primitive color layer (pays off at 3+ themes), component token layer,
density modes, fluid/breakpoint scales, Storybook. The audit's summary judgment: jsonloupe is at
or above standard on 8 of 15 axes including the two hardest (enforcement, contrast); the type
ramp is the one place it's still pre-standard in shape, not just in polish.
