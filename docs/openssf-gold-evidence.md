# OpenSSF Gold evidence

This is the review worksheet for jsonloupe's
[OpenSSF Best Practices project 13920](https://www.bestpractices.dev/projects/13920).
It separates repository evidence from self-certification: **Branch-ready**
means the evidence exists on this branch but must not be submitted as a public
claim until the pull request is merged and its links resolve on `main`.

Snapshot on 2026-08-08: the live Gold form was 17% answered. The complete FLOSS
suite passed 658 tests with 5 intentionally skipped and measured 90.08%
statement coverage (6,275/6,966) and 81.47% branch coverage (4,068/4,993). The
source-notice gate checked 108 TypeScript, JavaScript, CSS, HTML, SVG, and YAML
files. Two
clean build paths produced 34 byte-identical files with manifest SHA-256
`31cd7b66c439819c05b67dfc00fdde04dac14d88150a30e4c16f45dcf5374c9b`.

## Criteria

| Criterion | Draft status | Evidence or justification |
|---|---|---|
| `achieve_silver` | **Blocked: Unmet** | Silver remains at 98% because [one-week access continuity](openssf-silver-evidence.md#owner-controlled-gate) does not exist. |
| `bus_factor` | **Blocked: Unmet** | The project has one active maintainer. Public process cannot create a second person. |
| `contributors_unassociated` | **Blocked: Unmet** | The project does not yet have two unassociated significant contributors as OpenSSF defines them. The two [newcomer tasks](https://github.com/priyanshuN/jsonloupe/issues?q=is%3Aissue%20state%3Aopen%20label%3A%22good%20first%20issue%22) are a path toward contributors, not a claim that they already exist. |
| `copyright_per_file` | Branch-ready: Met | [`lint:headers`](../scripts/check-source-headers.mjs) checks every tracked or untracked source file and currently reports 108 files with an identified copyright holder. |
| `license_per_file` | Branch-ready: Met | The same gate requires `SPDX-License-Identifier: MIT` near the beginning of every source file and blocks CI if one is missing. |
| `repo_distributed` | Ready: Met | The public source repository uses Git, a distributed version-control system. |
| `small_tasks` | **Live: Met** | Unassigned, bounded newcomer tasks [#19](https://github.com/priyanshuN/jsonloupe/issues/19) and [#20](https://github.com/priyanshuN/jsonloupe/issues/20) are both labeled `good first issue` and `help wanted`. |
| `require_2FA` | Ready: Met | GitHub requires contributors selected by its mandatory 2FA program—including release creators and administrators/contributors of repositories that publish packages—to enable 2FA before accessing GitHub. The project has no separate account system. See [GitHub's mandatory 2FA policy](https://docs.github.com/en/authentication/securing-your-account-with-two-factor-authentication-2fa/about-mandatory-two-factor-authentication). |
| `secure_2FA` | **Owner confirmation required** | Mark Met only if the maintainer's current GitHub second factor is cryptographic, such as TOTP, a passkey/security key, or GitHub Mobile. If SMS is the only factor, mark this SHOULD criterion Unmet with that justification. Do not publish factor details. |
| `code_review_standards` | Branch-ready: Met | [Review procedure](../CONTRIBUTING.md#code-review-procedure) documents how review is conducted, what is checked, and acceptance conditions. |
| `two_person_review` | **Blocked: Unmet** | A sole maintainer cannot truthfully claim that another person reviews at least 50% of proposed changes before release. The documented self-review is evidence, not a substitute. |
| `build_reproducible` | Branch-ready: Met | [Pinned independent rebuild procedure](../REPRODUCIBLE-BUILD.md) plus [`check:reproducible-build`](../scripts/check-repeatable-build.mjs) require two clean installs in different paths to produce byte-identical bundles and npm tarballs. |
| `test_invocation` | Ready: Met | `npm test` is the standard invocation documented in [CONTRIBUTING](../CONTRIBUTING.md#get-it-running). |
| `test_continuous_integration` | Ready: Met | [CI](../.github/workflows/ci.yml) runs the full suite on every push and pull request to `main`. |
| `test_statement_coverage90` | Branch-ready: Met | `npm run coverage` fails below 90% statement coverage; the recorded full-suite result is 90.08%. |
| `test_branch_coverage80` | Branch-ready: Met | The same FLOSS Vitest/V8 gate fails below 80% branch coverage; the recorded result is 81.47%. |
| `crypto_used_network` | Ready: Met | Runtime network calls use fixed HTTPS provider URLs; HTTP is limited to the explicitly local loopback server. |
| `crypto_tls12` | Ready: Met | TLS is delegated to supported browser/Node stacks and GitHub/npm/provider HTTPS endpoints, all supporting TLS 1.2 or later; no downgrade path exists. |
| `hardened_site` | **Edge action required** | HTML now has a strict CSP fallback and the packaged server sends applicable headers, but the live GitHub Pages origin still omits CSP, HSTS, `nosniff`, and X-Frame-Options. Apply the [Cloudflare edge procedure](../SECURITY-HEADERS.md#cloudflare-edge-configuration), then require `npm run check:site-headers` to pass before marking Met. |
| `security_review` | **Human review required** | The assurance case defines security requirements and boundaries, and a [review record](security-review-2026-08-08.md) is prepared. OpenSSF requires a human review; automation or this worksheet alone is insufficient. |
| `hardening` | Ready: Met | Worker isolation, safe DOM sinks, strict types, input/output limits, exact-number handling, and fail-closed behavior are justified in the [assurance case](../SECURITY-ASSURANCE.md#common-weakness-countermeasures). |
| `dynamic_analysis` | Branch-ready: Met | OpenSSF explicitly permits an automated suite with at least 80% branch coverage as dynamic analysis. The release workflow now runs the 81.47%-covered suite before every proposed production release, and `fast-check` varies security-sensitive inputs. |
| `dynamic_analysis_enable_assertions` | Branch-ready: Met | The release-time dynamic run enables thousands of Vitest `expect` assertions, including the generated security properties in [`security-properties.test.ts`](../src/security-properties.test.ts). |

## Submission rule

Do not use the percentage as evidence. After merge, rerun the full validation
on the exact public commit, replace every **Branch-ready** link with its public
`main` URL where BadgeApp requires one, and read back the saved JSON record.
Leave the people-dependent MUST criteria Unmet until reality changes. Mark the
site and human-review criteria Met only after their live checks are complete.
