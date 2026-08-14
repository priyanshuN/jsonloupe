# Design QA — OpenRouter model choice

- source visual truth: `docs/design/openrouter-auth-modal-reference.png` (1487 × 1058 px)
- implementation: `docs/design/openrouter-free-model-selector-implementation.png` (1280 × 720 px in-app-browser capture)
- rendered viewport: 1207 × 1044 CSS px at device pixel ratio 2; browser capture is scaled to the in-app surface
- state: sample document open, Query visible, English mode selected, no credential, modal open, **Free models** selected

## Full-view comparison evidence

The source and implementation captures were opened together for comparison. The modal remains centered over the workbench with the same hierarchy, typography, token palette, border treatment, icon set, privacy disclosure, API-key fallback, and session-storage footer. The requested model selector is an intentional addition between authorization and privacy; it uses the existing modal width and control rhythm rather than introducing a second pane.

## Focused comparison evidence

The modal occupies the meaningful detail region in both full-view captures, so a separate crop was not needed. Text, radios, selected state, badges, icons, borders, and footer copy remain readable in the implementation capture.

## Findings

- No actionable P0/P1/P2 visual mismatch remains.
- Typography: existing jsonloupe font, weights, sizes, and muted secondary copy remain consistent with the source.
- Spacing and layout: the 500 px modal width is preserved; the new two-row selector adds height without clipping or hiding the footer.
- Colors and tokens: selected, hover, focus, border, and background colors use existing theme tokens and retain contrast.
- Image and icon fidelity: the source's Tabler icon treatment is unchanged; no placeholder or custom-drawn assets were introduced.
- Copy: free usage is explicit (`No credits needed · up to 50 requests/day`), while the paid option clearly says it uses OpenRouter credits.
- Interaction: Free models defaults on first use; choosing Claude persists through closing and reopening the modal; switching back to Free also persists. Split and Functions remain independent. Browser console warnings/errors: none.

## Comparison history

- Initial modal QA established the icon-led privacy hierarchy and compact OpenRouter authorization design.
- This iteration added an explicit free/paid selector without changing the established hierarchy. No P0/P1/P2 fix loop was required.

## Residual test gap

- OAuth was not submitted during visual QA because that would create/exchange an external credential. PKCE and key exchange remain unit-tested.

final result: passed
