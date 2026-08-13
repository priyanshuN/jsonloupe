# Browser accessibility audit

The required browser suite covers the highest-use jsonloupe journeys in a real
Chromium page. `npm run test:a11y` builds evidence at two levels:

- axe-core checks the landing, open-document tree, Code view, Query results,
  saved Checks, converter, and compact Documents drawer against WCAG 2.0 A/AA,
  WCAG 2.1 A/AA, and WCAG 2.2 AA rules;
- explicit keyboard assertions cover tree arrow navigation, roving focus,
  drawer focus entry, Escape dismissal, and focus restoration. These behaviors
  cannot be established by static markup analysis alone.

CI installs its own pinned Chromium and runs the suite after the production
build. A violation or keyboard regression blocks the same required `test` job
as unit coverage, strict TypeScript, security linting, and reproducible builds.

## Manual assistive-technology checklist

Automated checks do not establish screen-reader usability. Before claiming a
complete assistive-technology audit, run this checklist on a tagged release and
record the browser, screen reader, version, date, and findings here:

1. VoiceOver + Safari on macOS: navigate the landing landmarks and open the
   sample without the pointer.
2. VoiceOver + Safari on macOS: traverse the JSON tree, expand `orders`, and
   confirm key, type, value, level, selected state, and expanded state are read.
3. NVDA + Firefox on Windows: switch Tree → Code → Query and confirm each pane
   has one clear name and that focus lands on a useful control.
4. NVDA + Firefox on Windows: run a local query, save it as a Check, and confirm
   the result and saved state are announced without moving focus unexpectedly.
5. At a 390 × 844 viewport: open and close Documents with the keyboard, verify
   focus remains inside the modal drawer, and verify Escape returns focus to
   the trigger.
6. With `prefers-reduced-motion: reduce` and forced/high contrast enabled:
   repeat the sample, Query, and converter journeys and confirm focus remains
   visible and state is not communicated by color alone.

Until those manual runs are recorded, OpenSSF
`accessibility_best_practices` remains honestly marked Unmet even though the
automated browser evidence is enforced.
