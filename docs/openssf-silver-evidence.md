# OpenSSF Silver evidence

This is the review worksheet for jsonloupe's
[OpenSSF Best Practices project 13920](https://www.bestpractices.dev/projects/13920).
It separates evidence from self-certification: a row marked **Ready** has a
repository-backed answer prepared for BadgeApp; it is not represented as saved
externally until the project owner reviews and submits it.

Snapshot on 2026-08-08: 573 tests passed and 5 were skipped; statement coverage
was 85.27%; two clean checkout paths produced 30 matching generated files,
including byte-identical npm tarballs. The published `jsonloupe@1.2.0` returned
one verified npm registry signature and one verified provenance attestation from
`npm audit signatures`. BadgeApp remained at Passing with the Silver form 15%
answered; no Silver answers from this worksheet had been submitted.

## Owner-controlled gate

`access_continuity` is the one remaining MUST criterion that code and public
documentation cannot create. Before Silver is claimed, the maintainer must
either appoint an emergency steward with effective GitHub, npm, domain, issue,
merge, and release access, or establish legally effective offline escrow and
succession instructions that can restore those capabilities within one week.
Do not put identities, recovery codes, keys, or instructions in this repository.

Once that arrangement exists and has been checked, update the continuity
section of [GOVERNANCE.md](../GOVERNANCE.md) to state the date and mechanism at
a non-secret level, then mark the criterion Met in BadgeApp.

## Basics

| Criterion | Draft status | Evidence or justification |
|---|---|---|
| `achieve_passing` | Ready: Met | The live project already holds the Passing badge. |
| `contribution_requirements` | Ready: Met | [Contribution acceptance rules](../CONTRIBUTING.md#what-a-good-change-looks-like) |
| `dco` | Ready: Unmet with justification | [DCO sign-off is mandatory for new non-trivial contributions](../CONTRIBUTING.md#developer-certificate-of-origin), but earlier sole-maintainer commits predate the policy and have not been represented as retroactively attested. |
| `governance` | Ready: Met | [Decision model](../GOVERNANCE.md#decision-process) |
| `code_of_conduct` | Ready: Met | [Contributor Covenant](../CODE_OF_CONDUCT.md) |
| `roles_responsibilities` | Ready: Met | [Named roles and responsibilities](../GOVERNANCE.md#roles-and-responsibilities) |
| `access_continuity` | **Owner action required** | [The exact unclaimed gate](../GOVERNANCE.md#continuity) |
| `bus_factor` | Ready: Unmet with justification | The project has one active maintainer; continuity is handled separately, and claiming a second active maintainer would be false. |
| `documentation_roadmap` | Ready: Met | [Twelve-month roadmap and non-goals](../ROADMAP.md) |
| `documentation_architecture` | Ready: Met | [Architecture and data flow](../ARCHITECTURE.md) |
| `documentation_security` | Ready: Met | [Security requirements](../SECURITY-ASSURANCE.md#security-requirements) and [user-facing limits](../SECURITY.md) |
| `documentation_quick_start` | Ready: Met | [README quick start](../README.md#quick-start) |
| `documentation_current` | Ready: Met | Documentation changes are required with behavior changes; [CHANGELOG](../CHANGELOG.md) records shipped behavior. |
| `documentation_achievements` | Ready: Met | The repository front page links the live Best Practices and Scorecard badges. |
| `accessibility_best_practices` | Ready: Unmet with justification | Contrast, reduced motion, focus, and token checks exist in [DESIGN-AUDIT.md](../DESIGN-AUDIT.md), but a complete assistive-technology audit is not yet available; it is a roadmap item. |
| `internationalization` | Ready: Unmet with justification | The early-stage UI is English-only and has no localization framework; document keys and values are preserved without locale coercion. Localization remains deferred rather than being claimed. |
| `sites_password_security` | Ready: N/A | The static site, GitHub repository, and npm download channel do not store project-user passwords. |

## Change control and reporting

| Criterion | Draft status | Evidence or justification |
|---|---|---|
| `maintenance_or_update` | Ready: Met | [Supported-version and upgrade policy](../SECURITY.md#supported-versions) plus Semantic Versioning and [CHANGELOG](../CHANGELOG.md) |
| `report_tracker` | Ready: Met | Public defects use GitHub Issues; sensitive reports use `security@jsonloupe.dev`, whose forwarding delivery the maintainer confirmed on 2026-08-08. |
| `vulnerability_report_credit` | Ready: N/A | No externally reported vulnerability has been resolved in the project's first twelve months; future reporters are credited unless they request anonymity. |
| `vulnerability_response_process` | Ready: Met | [Acknowledgement, assessment, correction, disclosure, and credit process](../SECURITY.md#reporting-a-vulnerability) |

## Quality

| Criterion | Draft status | Evidence or justification |
|---|---|---|
| `coding_standards` | Ready: Met | [The required Biome, strict-TypeScript, and project contract standard](../CONTRIBUTING.md#coding-standards-and-automated-gates) |
| `coding_standards_enforced` | Ready: Met | Biome style rules, strict TypeScript, and the contract linter run in [CI](../.github/workflows/ci.yml). |
| `build_standard_variables` | Ready: N/A | The project produces no native compiler/linker build. |
| `build_preserve_debug` | Ready: N/A | This is a TypeScript/JavaScript package, the criterion's documented typical N/A case. |
| `build_non_recursive` | Ready: N/A | The JavaScript build has no recursive native subdirectory make graph. |
| `build_repeatable` | Ready: Met | [`check:repeatable-build`](../scripts/check-repeatable-build.mjs) builds and packs from two paths and compares every byte in CI. |
| `installation_common` | Ready: Met | Users install through standard npm/npx commands in [README](../README.md#run-it). |
| `installation_standard_variables` | Ready: Met | npm owns install location and honors its standard prefix/configuration mechanisms; jsonloupe adds no custom installer. |
| `installation_development_quick` | Ready: Met | A clean checkout uses `npm ci`, `npm test`, and `npm run build` in [CONTRIBUTING](../CONTRIBUTING.md#get-it-running). |
| `external_dependencies` | Ready: Met | `package.json` and `package-lock.json` are machine-processable dependency inventories. |
| `dependency_monitoring` | Ready: Met | [Dependabot](../.github/dependabot.yml), `npm audit`, CodeQL, and Scorecard run automatically. |
| `updateable_reused_components` | Ready: Met | Standard npm dependencies and lockfile updates identify and replace reused components. |
| `interfaces_current` | Ready: Met | Dependencies and APIs are actively updated; deprecated APIs are treated as defects when FLOSS replacements exist. |
| `automated_integration_testing` | Ready: Met | [CI](../.github/workflows/ci.yml) runs the suite and reports success/failure on pushes and pull requests. |
| `regression_tests_added50` | Ready: Met | [The six-month audit below](#six-month-regression-test-audit) maps all 29 known fixed defects to automated behavioral or contract regressions, exceeding the required 50%. |
| `test_statement_coverage80` | Ready: Met | `npm run coverage` enforces 80%; the recorded full-suite result is 85.27%. |
| `test_policy_mandated` | Ready: Met | [Major functionality MUST add tests](../CONTRIBUTING.md#what-a-good-change-looks-like). |
| `tests_documented_added` | Ready: Met | The same policy is part of public change-proposal instructions. |
| `warnings_strict` | Ready: Met | Strict TypeScript failures block all browser, CLI, and MCP builds. |

## Security

| Criterion | Draft status | Evidence or justification |
|---|---|---|
| `implement_secure_design` | Ready: Met | [Secure-design argument](../SECURITY-ASSURANCE.md#secure-design-argument) |
| `crypto_weaknesses` | Ready: N/A | jsonloupe does not implement or select a cryptographic algorithm for a product security mechanism. |
| `crypto_algorithm_agility` | Ready: N/A | Cryptography is delegated to browser TLS, npm, and Sigstore rather than selected by project code. |
| `crypto_credential_agility` | Ready: Met | User-supplied API keys are separate from code and replaceable without recompilation; see [SECURITY](../SECURITY.md#api-keys). |
| `crypto_used_network` | Ready: Met | External runtime calls use fixed HTTPS endpoints; HTTP is limited to the explicit loopback-only local server. |
| `crypto_tls12` | Ready: Met | TLS is provided and updated by supported browsers/Node and the HTTPS providers, all of which support TLS 1.2 or later. |
| `crypto_certificate_verification` | Ready: Met | Standard browser/Node HTTPS verification is enabled; jsonloupe installs no bypass. |
| `crypto_verification_private` | Ready: Met | Private provider headers are sent only through verified HTTPS fetches; no insecure fallback exists. |
| `signed_releases` | Ready: Met | [npm registry signatures, SLSA provenance, trust roots, and verification commands](../RELEASING.md#what-is-signed) |
| `version_tags_signed` | Ready: Unmet | Important Git tags are not separately signed; this is a suggested criterion and is stated honestly in [RELEASING](../RELEASING.md#git-tags-and-github-assets). |
| `input_validation` | Ready: Met | [Trust-boundary and common-weakness evidence](../SECURITY-ASSURANCE.md#trust-boundaries), including generated security properties and explicit size/path validation |
| `hardening` | Ready: Met | Worker isolation, safe DOM sinks, strict types, limits, property tests, CodeQL, and fail-closed output behavior are documented in the [assurance case](../SECURITY-ASSURANCE.md#common-weakness-countermeasures). |
| `assurance_case` | Ready: Met | [Threat model, boundaries, argument, countermeasures, and residual risks](../SECURITY-ASSURANCE.md) |

## Analysis

| Criterion | Draft status | Evidence or justification |
|---|---|---|
| `static_analysis_common_vulnerabilities` | Ready: Met | [Biome's MIT/Apache-licensed security rules](../biome.json) analyze TypeScript/JavaScript and HTML in every CI run; [CodeQL security-extended](../.github/workflows/codeql.yml) remains a complementary deeper check. |
| `dynamic_analysis_unsafe` | Ready: N/A | Production code is TypeScript/JavaScript and contains no memory-unsafe native project code. |

## Six-month regression-test audit

The repository began on 2026-07-29, so the six-month window is its complete
history through this worksheet's 2026-08-08 snapshot. The audit treats each
distinct defect named in a fix commit body as one bug; multi-defect commits are
counted individually. It includes product, security, packaging, and automated
test-tool defects rather than narrowing the denominator after the fact.

Behavioral tests execute the affected seam. Contract tests inspect markup or
source where the regression is structural—such as a command/package mapping,
pre-paint ordering, a forbidden ambient capability, or a one-handle filesystem
invariant. Both run automatically in CI; the large MCP smoke also runs after the
bundle is built.

| Fix | Bugs | Automated regression evidence |
|---|---:|---|
| `9f27190` spreadsheet tab-prefix bypass | 1 | [`security-properties.test.ts`](../src/security-properties.test.ts) generated CSV properties |
| `b18b51e` MCP path stat/read race | 1 | [`regression-contracts.test.ts`](../src/regression-contracts.test.ts) one-handle invariant |
| `0317d52` raw NUL bytes in converter source | 1 | `regression-contracts.test.ts` text-source and escaped-separator invariant |
| `8a8048e` run sandbox authority and message-shape gaps | 2 | [`run-sandbox.test.ts`](../src/run-sandbox.test.ts) executes both boundaries |
| `65ea93f` smoke-test CSV stat/read race | 1 | `regression-contracts.test.ts` one-buffer invariant plus [`smoke:mcp`](../scripts/mcp-smoke.mjs) |
| `4158652` invalid MCP registration command | 1 | `regression-contracts.test.ts` checks package bin, launcher, and documented command together |
| `c6a187c` saved-query cap off by one | 1 | [`db.test.ts`](../src/db.test.ts) storage regressions |
| `d8f1c71` browser crash on oversized intake | 1 | `regression-contracts.test.ts` pins declared-size and post-decode caps |
| `8eb5175` API-key password field outside a form | 1 | `regression-contracts.test.ts` checks form containment and submit handling |
| `92faac1` stale deployed chunks and vertical status wrapping | 2 | `regression-contracts.test.ts` checks one-shot recovery; [`lint-contract.mjs`](../scripts/lint-contract.mjs) enforces status layout |
| `d4f0ebb` unescaped semantic path labels | 1 | [`semantic.test.ts`](../src/semantic.test.ts) escaping regression |
| `d67511b` non-canonical exact numbers floated | 1 | [`worker.test.ts`](../src/worker.test.ts) lossless-number regressions |
| `f637c1a` spec theme flash and platform-specific save hint | 2 | `regression-contracts.test.ts` checks both static-page contracts |
| `9bb0b82` landing CTA ignored stored documents | 1 | `regression-contracts.test.ts` checks last-used-document handoff |
| `46297b7` unstyled first development paint | 1 | `regression-contracts.test.ts` checks stylesheet-before-module ordering |
| `181bf43` first-paint theme/returning-user flash | 1 | `regression-contracts.test.ts` checks the pre-paint gate and escape path |
| `5e921ff` CSV formula injection and loopback rebinding | 2 | `security-properties.test.ts` and [`devKeyGuard.test.ts`](../src/devKeyGuard.test.ts) |
| `642ce3d` eight browser UI defects from the live sweep | 8 | `regression-contracts.test.ts` covers line wrapping, picker fallback, source formatting, sample errors, Ask reset, Enter, production key hints; `lint-contract.mjs` covers apply/status layout |
| **Total** | **29 / 29 covered (100%)** | Required minimum: 50% |

## Submission rule

Before saving the Silver form, rerun all validation on the exact commit, review
every Met/N/A justification, confirm the continuity arrangement, and read back
the public BadgeApp record. A higher percentage is not a reason to make a claim
that the repository evidence or owner-controlled state does not support.
