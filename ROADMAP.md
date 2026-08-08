# Roadmap: August 2026 to July 2027

This roadmap states direction, not a promise that every item ships on a fixed
date. Security and correctness regressions take priority over feature work.

## August–October 2026: trustworthy releases

- Complete OpenSSF Best Practices Silver evidence without overstating
  single-maintainer controls.
- Keep statement coverage above 80% and clean builds byte-for-byte repeatable.
- Add accessibility checks for the highest-use browser workflows.
- Stabilize the JSON-to-spreadsheet converter across browser, CLI, and MCP.

## November 2026–January 2027: Local Playbooks

- Turn saved queries, comparisons, conversion mappings, transport budgets, and
  assertions into named, reusable local investigations.
- Allow a playbook to be exported, reviewed, and rerun without uploading its
  source documents or requiring an account.
- Keep every automated result linked to the affected paths, rows, or fields so
  a user can inspect the evidence rather than accept one opaque score.

## February–April 2027: agent and large-file depth

- Keep browser, CLI, and MCP operations behaviorally aligned.
- Expand bounded streaming operations where they replace ad-hoc scripts while
  preserving exact numbers and compact responses.
- Publish repeatable performance fixtures for large JSON, JSONL, compressed
  payloads, and complete exports.

## May–July 2027: stability and extension points

- Freeze and document the durable query, converter-spec, and playbook formats.
- Add migrations for persisted local data before changing a stored format.
- Prefer small, auditable extension points over additional frameworks or
  runtime dependencies.

## Explicit non-goals for this period

- No hosted document backend, accounts, telemetry, analytics, or cloud sync.
- No server-side processing of user documents.
- No execution of model-generated code; model output remains constrained data.
- No attempt to become a general spreadsheet editor, IDE, or hosted ETL
  platform.
- No silent coercion of int64 or precise decimal values.

The roadmap is reviewed with each minor release and updated when priorities
change. Completed behavior belongs in [CHANGELOG.md](CHANGELOG.md), not here.
