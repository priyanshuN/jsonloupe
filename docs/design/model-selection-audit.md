# Model connection and selection audit

## Scope

- Surface: English → query model connection modal.
- User goal: connect without pasting a key, understand what leaves the browser, and choose free or paid inference confidently.
- Evidence: `audit-model-selection-01.png` captured from the local app on 2026-08-14.

## Step 1 — Connect and choose a model

Health: understandable, but the modal combines two decisions too early.

### Strengths

- OpenRouter authorization is the dominant action and does not ask for a pasted secret.
- The free choice is visible and clearly states that credits are unnecessary.
- Privacy and credential scope are explicit.
- Native radio semantics expose the choices to keyboard and assistive-technology users.

### UX risks

- A disconnected user must evaluate a model before they understand whether connection succeeded.
- “Recommended” and “Default” compete as two recommendation signals.
- “Free models” does not explain that OpenRouter may select a different available model per request.
- The model selector makes the first-connect modal tall and pushes the API-key fallback and storage explanation downward.

### Accessibility risks

- The radio labels are well structured, but the muted explanatory copy and small badges should retain AA contrast in both themes.
- Screenshot evidence cannot verify focus order, screen-reader announcements, zoom reflow, or error recovery.

## Recommendation

Use two states in one modal:

1. **Disconnected — “Connect to translate”**
   - One primary action: **Continue with OpenRouter**.
   - One reassurance beneath it: **Starts with Free models · no credits required**.
   - Keep the compact privacy disclosure and collapsed API-key fallback.
   - Do not show the full model selector yet.

2. **Connected — “Model settings”**
   - Status row: **OpenRouter connected · this tab only**.
   - Show the model choices here:
     - **Automatic free** — No credits required; OpenRouter chooses an available free model; limited availability.
     - **Claude Sonnet 5** — Uses OpenRouter credits; more consistent.
   - Use **Done** as the primary action and a quiet **Disconnect** action in the footer.

The Query toolbar should show the current state as a compact chip, for example **OpenRouter · Free**, which reopens Model settings. Split and Functions remain unrelated to model authentication.

## Evidence limits

This audit is based on the captured modal and DOM semantics. It does not claim complete WCAG compliance or evaluate the external OpenRouter authorization page.
