# Governance

jsonloupe is an independently maintained open-source project. This document
explains who makes decisions, how changes are accepted, and where authority
lives. It does not grant access to any system or disclose recovery material.

## Roles and responsibilities

### Maintainer

Priyanshu Nandan (`@priyanshuN`) is the current maintainer and release owner.
The maintainer:

- sets product scope and resolves design decisions;
- reviews and merges contributions;
- keeps CI, dependencies, documentation, and releases healthy;
- triages ordinary bug reports and handles private vulnerability reports;
- owns npm trusted-publishing configuration and the `jsonloupe.dev` domain;
- appoints or removes additional maintainers and emergency stewards.

### Contributors

Anyone may propose issues or pull requests. Contributors are responsible for
following [CONTRIBUTING.md](CONTRIBUTING.md), certifying their contribution
under the Developer Certificate of Origin, adding appropriate tests, and
updating affected documentation. A contribution does not confer maintainer or
release authority.

### Security reporters

Security reporters follow [SECURITY.md](SECURITY.md). They are not expected to
fix the issue they report. The maintainer coordinates validation, remediation,
credit, and disclosure with them.

## Decision process

Normal decisions are made in public issues and pull requests. The maintainer
prefers the smallest change that preserves the documented local-first,
lossless-number, and bounded-processing contracts. Significant changes should
start with an issue so alternatives and compatibility costs can be discussed
before implementation.

There is currently no voting body. The maintainer has final responsibility for
accepting a change and must explain a rejection in terms of project scope,
security, compatibility, maintenance cost, or evidence. Security-sensitive
work may remain private until coordinated disclosure is safe; the resulting
fix and public advisory are published when the embargo ends.

## Releases

Only the maintainer may publish an official version. Releases follow
[RELEASING.md](RELEASING.md), use Semantic Versioning, are built by GitHub
Actions, and are published to npm through trusted publishing rather than a
stored registry token.

## Continuity

The project currently has one active maintainer, so its bus factor is one. The
OpenSSF Silver continuity requirement will be marked as met only after a real
emergency arrangement exists that can restore repository, npm, domain, issue,
merge, and release authority within one week if the maintainer is permanently
unavailable. Acceptable arrangements include an entrusted emergency steward
with the necessary access or legally effective offline escrow and succession
instructions.

Names, recovery codes, private keys, and account-recovery instructions must
never be committed to this repository. Once an arrangement exists, this
section may state that it was tested and when, without publishing its secrets.

## Changing governance

Governance changes use the same pull-request process as code changes. Changes
that transfer release or security authority must name the affected role,
document the effective date, and be accepted by the incoming role holder.
