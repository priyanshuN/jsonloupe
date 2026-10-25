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

---

# Design QA — Playbook view

- source visual truth: the playbook spec's wireframes (1440 × 900 sheet with an open failure; the empty playbook) and its narrow-width table
- implementation: in-app browser at 1280 × 800, 1440 × 900, 1536 × 864 and 375 × 812, light and dark, glass on; headless Chromium full-resolution captures of the same four widths, light and dark, glass off
- states: empty playbook; dock writing a check (no-matches, between, at-most), saved and previewed; dock writing a function, run, saved; run all with a failure, a pass with `| distinct`, a misfit, a batch of ticked functions; a failing row hovered; evidence revealed from a code source; edit and save; forget and undo; export and import; reload

## Full-view comparison evidence

At 1440 the column is 666 px beside a 524 px source, as drawn: one bar row (title, find, import, export, run all), sticky CHECKS and FUNCTIONS heads with their counts, rows at the names' one column, and the run all opened failure showing its verdict, query, matched paths and actions. The empty playbook matches its wireframe: two list-size empty states, export and run all disabled in place rather than hidden.

## Focused comparison evidence

- Verdict marks sit in the 34 px canvas lead cell; hovering a failing row tints the row button only, and the ✕ stays on canvas. The axe scan of `#run-pane` at rest and hovered passes in light, dark and all eleven schemes.
- A reveal from the code source switches the source pane to the tree in place, selects the node and puts the path in the status bar; the view, the open row and focus on the pressed path all stay.
- The phone shows `source | playbook`, the bar on two right-aligned rows, outcomes under names, and an evidence press that lands on the tree with "back to playbook" on the toast. Nothing scrolls sideways.

## Findings

Fixed during this pass:

- The dock's preview took the dock's full height: the Query card's `flex: 1 1 100%` preview rule was shared into a column, so the dock scrolled with 70 px of empty preview. The basis is now the card's alone.
- At 1280 with find shown, run all wrapped onto a second bar row. A wrapping row breaks on basis before anything shrinks, so find now asks for 14ch and grows to 24ch.
- At 1280 a long outcome (`2 matches · expected none · reads \`customerId\``) squeezed a name to "orders have custo…". Name and outcome now give way in proportion, and a name keeps at least min(40%, 22ch).
- The pass-condition select cut "…at most this many matches are fou…", and with `between` the second count wrapped under it. The dock's select asks for 30ch and grows to 44ch.
- A new `between` check opened at "between 0 and 0". Untouched counts now follow the draft's exact measured count, as the Query editor does.
- A function written, run and then saved showed `not run` for the outcome just watched. The dock's last run now carries over to the saved function when the code, number mode and document match.
- Stacked evidence paths were 22 px targets with no spacing (WCAG 2.5.8, caught by axe). They are 24 px.
- Run all re-closed a row it had opened even after you had worked in it; a row you use is now yours.
- Tick-all now shows the mixed state when some functions are ticked; on narrow widths the wrapped bar and dock rows keep the right edge.

## Residual test gap

- Import was driven through the file input in the browser and in the e2e, not the native file dialog.
- The run all stop button and the "document changed" abort were exercised in unit and source pins only; the sample document answers too fast to press stop mid-run by hand.

final result: passed
