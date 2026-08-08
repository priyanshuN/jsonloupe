# Security review record — 2026-08-08

Status: **prepared; human review pending**

OpenSSF Gold requires a security review within five years that considers the
project's security requirements and security boundary, with human judgment in
addition to automated tools. This record makes that review bounded and public;
its existence is not itself evidence that the review happened.

## Scope

The human reviewer should inspect:

- the nine requirements, assets, threat actors, and trust boundaries in
  [SECURITY-ASSURANCE.md](../SECURITY-ASSURANCE.md);
- operational disclosure and response behavior in [SECURITY.md](../SECURITY.md);
- browser intake, worker messages, DOM rendering, optional Ask disclosure,
  explicit Run execution, development-key containment, CSV/XLSX exports,
  CLI/MCP file access, and release provenance;
- the CSP and edge boundary in [SECURITY-HEADERS.md](../SECURITY-HEADERS.md);
- residual risks and whether any public claim is broader than its enforcement.

Automated supporting evidence includes strict TypeScript, Biome security rules,
CodeQL, dependency monitoring, generated security properties, the
coverage-gated dynamic suite, and reproducible-build comparison. These tools
support but do not replace the reviewer's design judgment.

## Review questions

- Are all sensitive assets and externally controlled inputs represented?
- Does every requirement map to an enforcement point or an explicit residual
  risk?
- Can document or model content reach an HTML or executable sink unexpectedly?
- Can an API key cross a boundary other than the provider the user selected?
- Can unsafe numbers, oversized work, unsafe spreadsheet cells, filesystem
  paths, or overwrite behavior bypass the documented checks?
- Do release and deployment controls support the origin and hardening claims?
- Did this review identify a finding that needs a private report or regression
  test before release?

## Completion record

After reviewing the exact pull request, a human maintainer records the review
date, reviewed commit, reviewer name, and outcome in a public PR comment. A
suitable outcome is: “I reviewed the security requirements and trust boundaries
in `SECURITY-ASSURANCE.md` against this change. No unresolved issue blocks
release.” If a finding exists, resolve or track it first and record that outcome
instead.

Only after that public record exists should this status become **complete** and
the OpenSSF `security_review` criterion be marked Met with links to this scope
and the human review comment.
