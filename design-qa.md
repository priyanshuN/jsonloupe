# Design QA — model connection

- reference: `docs/design/openrouter-auth-modal-reference.png` (1487 × 1058)
- implementation: `docs/design/openrouter-auth-modal-implementation.png` (1280 × 720 in-app browser surface)
- focused source/implementation comparison: `docs/design/openrouter-auth-modal-comparison.png`
- state: sample document open, Query visible, English mode selected, unanswered question present, no model credential, modal open

## Review

- The modal remains centered over the workbench and keeps the query context visible beneath the backdrop.
- Hierarchy matches the target: one recommended OpenRouter action, a short authorization explanation, three privacy facts, an advanced manual-key disclosure, and a tab-storage footer.
- The first comparison exposed a P1 fidelity issue: the privacy area rendered like a text table and lacked the target's icon-led hierarchy.
- The corrected implementation uses the target's stacked label/value rows, clean section dividers, muted recommendation pill, and real link, document, message, and key icons from the MIT-licensed Tabler set. The paths are bundled into jsonloupe's existing SVG sprite, so there is no runtime icon CDN or network request.
- Spacing, border treatment, typography, control geometry, focus treatment, and backdrop use existing jsonloupe tokens and dialog conventions.
- Manual-key entry is collapsed by default, includes the complete pre-input disclosure, and exposes persistence only through an unchecked “remember on this device” choice.
- The advanced disclosure was expanded in the in-app browser and its key textbox, unchecked persistence checkbox, and save action were all present and named.
- Modal dismissal restores the full workbench. Split and Functions were exercised after dismissal and did not reopen or reserve space for model authorization.
- OpenRouter authorization itself was not activated during visual QA because it creates an external credential; the PKCE URL and code-exchange paths are covered by unit tests.
- The browser integration does not expose a console-reader capability; no runtime error surfaced during DOM snapshots or interaction checks. Unit, contract, security, build, and light/dark accessibility suites all pass.
- The reference and post-fix implementation were opened independently and together in the focused comparison. No P1 or P2 visual, interaction, responsive, or accessibility mismatch remains.

final result: passed
