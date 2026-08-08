# Security assurance case

This document argues why jsonloupe's published security requirements are met.
It is an assurance case, not a guarantee that the software contains no defects.
Operational reporting and response details live in [SECURITY.md](SECURITY.md),
and component/data-flow details live in [ARCHITECTURE.md](ARCHITECTURE.md).

## Top-level claim

When used as documented on an uncompromised browser or Node.js installation,
jsonloupe keeps document processing local by default, treats document and model
content as untrusted data, preserves security-relevant value fidelity, bounds
resource-heavy operations, and produces releases whose origin users can
verify.

## Security requirements

1. **Local document processing.** Opening, parsing, storing, querying,
   comparing, and converting a document must not upload its values to a
   jsonloupe service; no such service exists.
2. **Explicit external disclosure.** Network communication must be absent by
   default. The optional Ask feature may send only the disclosed document shape
   and question to the provider explicitly selected by the user.
3. **Untrusted content remains data.** Document text and model responses must
   not become HTML or executable code.
4. **Credential containment.** An LLM key must be replaceable without rebuilding
   the software and sent only to its selected provider. Development key files
   must not be read for non-loopback requests.
5. **Exactness.** Int64 values and non-canonical decimal spellings must not be
   silently rounded on supported read, query, edit, compare, and export paths.
6. **Bounded work.** Oversized inputs and outputs must fail explicitly or use
   bounded/streaming behavior rather than silently truncate or exhaust normal
   resources.
7. **Safe exports.** Spreadsheet exports must neutralize formula prefixes and
   report destination limits rather than silently producing dangerous or
   misleading cells.
8. **Constrained file access.** CLI and MCP operations may read or write only
   paths explicitly supplied by their caller; existing outputs must not be
   replaced without explicit overwrite intent.
9. **Verifiable origin.** Official npm packages must be produced by the public
   release workflow, carry registry signatures and build provenance, and have
   documented verification instructions.

## Assets and threat actors

Protected assets include private document values, LLM API keys, exact numeric
content, local files reachable by CLI/MCP, mapping/playbook integrity, and the
identity of published packages. Relevant threats are:

- a malicious or malformed document;
- a malicious spreadsheet formula embedded in document text;
- a hostile website attempting loopback or DNS-rebinding access;
- an untrusted or compromised model response;
- a script copied from an untrusted source into the explicit Run surface;
- a caller supplying unsafe paths or oversized work to CLI/MCP;
- a compromised dependency, publishing credential, or release channel;
- accidental maintainer mistakes that violate a documented invariant.

## Trust boundaries

| Boundary | Untrusted side | Trusted side | Enforcement |
|---|---|---|---|
| Intake | Pasted, dropped, or opened bytes | Parser/worker | Type detection, decompression and decoded-size limits, lossless parser |
| Worker protocol | UI messages and document-derived paths | Worker document state | Typed message protocol, bounded responses, validation in shared engines |
| DOM | Document/model strings | Browser rendering | `createElement`/`textContent`; no executable DOM sink |
| Ask provider | User question and document shape | External HTTPS provider | Explicit enablement, visible payload, fixed provider URLs, constrained query parser |
| Run worker | User-approved script and a plain-JSON document copy | Ephemeral execution worker | Network/storage/import capabilities removed, input shape checked, first-result termination and timeout |
| Dev key endpoint | HTTP Host/Origin | Local key file | Loopback Host and expected Origin checks occur before file access |
| Spreadsheet | Exported cells | CSV/XLSX consumer | Formula-prefix neutralization, exact numeric rules, format-limit reporting |
| MCP/CLI filesystem | Client-supplied paths | Local files | Explicit paths, bounded reads, same-directory temporary output, overwrite flag |
| Release | Source/workflow identity | npm consumer | GitHub OIDC trusted publishing, npm registry signature, Sigstore/SLSA provenance |

## Secure-design argument

### Minimize authority and data movement

The primary browser application is static and has no account, telemetry,
analytics, document API, or hosted storage. Documents stay in a worker and
IndexedDB. The MCP server communicates over stdio and makes no network calls.
This removes a server-side document store, service credential, and cross-user
authorization system from the threat model instead of attempting to secure
them after the fact.

### Separate control from untrusted data

Document strings render as text nodes. Model output is parsed through a small
query grammar before the project's deterministic engine evaluates it. Converter
mappings are validated declarative data. The separate Run surface executes only
code a user explicitly places in its editor, inside a fresh capability-stripped
worker that is terminated after a result or timeout. These separations counter
DOM XSS, prompt-to-code execution, and configuration-as-code injection without
misrepresenting Run as a non-code feature.

### Fail closed at narrow boundaries

The development key endpoint rejects a request before reading a key unless its
Host and Origin are loopback-compatible. Invalid mappings return addressed
errors. Oversized inputs, export ceilings, response budgets, and existing output
paths produce explicit failures. Ambiguous dates remain text or require a user
choice rather than being guessed.

### Make invariants executable

Strict TypeScript, Biome's FLOSS security rules, the UI contract linter,
CodeQL, dependency monitoring, property tests, an 80% statement-coverage floor,
and byte-for-byte build checks run in CI. Security-sensitive regressions
therefore have both prose contracts and executable checks.

## Common weakness countermeasures

- **Injection and XSS:** DOM sinks use text APIs; document and model content
  cannot reach a code constructor; the explicit Run constructors are isolated
  in a capability-stripped worker; CSV formula prefixes are neutralized across
  data and headers.
- **Request forgery and DNS rebinding:** the only local credential endpoint
  validates loopback Host and Origin before file access and is absent from
  production builds.
- **Credential exposure:** Ask is opt-in, keys are scoped and replaceable, npm
  publishing uses short-lived OIDC rather than a repository token, and secrets
  are excluded from source.
- **Numeric integrity:** lossless parsing and exact-number comparison avoid
  JavaScript's unsafe-integer and decimal-coercion failures.
- **Path and overwrite errors:** filesystem operations require caller-supplied
  paths and complete exports publish atomically without replacement by default.
- **Resource exhaustion:** intake/decompression caps, worker isolation,
  bounded response defaults, streaming aggregates/exports, and explicit output
  budgets constrain attacker-controlled scale.
- **Supply-chain substitution:** lockfiles, Dependabot, Biome security analysis,
  CodeQL, pinned GitHub Actions, trusted publishing, registry signatures, and
  SLSA provenance make dependency and release changes visible and attributable.

## Assumptions and residual risk

- A compromised browser, operating system, Node.js runtime, extension, MCP
  host, or local user can observe the same documents and credentials as the
  user; jsonloupe does not claim to sandbox a hostile machine.
- Ask intentionally discloses field names and types. Field names can themselves
  be sensitive, so users with that threat model must leave Ask disabled.
- User-requested downloads and MCP/CLI exports create local files whose later
  handling is outside jsonloupe's control.
- Resource limits reduce denial-of-service risk but cannot guarantee that every
  accepted document fits every device's available memory.
- Registry provenance proves where and how a package was published; it does not
  prove that the source is vulnerability-free.
- A newly compromised maintainer account can still propose malicious source.
  CI, public history, provenance, and dependency controls improve detection but
  do not replace independent review.

## Maintenance of this case

Any change that adds a network call, data sink, executable extension point,
credential path, parser, output format, release channel, or trust boundary must
update this assurance case and [SECURITY.md](SECURITY.md) in the same pull
request. Security reviews use this document as their scope and record material
residual risks rather than silently broadening the claims.
