# Releases and verification

The official installable release of jsonloupe is the public npm package named
[`jsonloupe`](https://www.npmjs.com/package/jsonloupe). The publish workflow
creates each version's tag and GitHub Release after npm has the package;
GitHub's automatic source archives are not the npm artifact users install.

## Release process

1. Update `package.json` and `CHANGELOG.md` using Semantic Versioning. Set
   the same version twice in `server.json` (`version` and
   `packages[0].version`); the tests refuse a mismatch.
2. Run the same gates used by CI:

   ```sh
   npm ci
   npm run lint:contract
   npm run lint:headers
   npm run lint:security
   npm run coverage
   npm run build
   npm run check:reproducible-build
   npm run check:site-headers
   npm audit
   ```

3. Merge the version change to `main` with all required checks green. A pull
   request with auto-merge on merges itself when they pass.
4. The merge starts `.github/workflows/publish.yml`. It sees that npm does not
   have the version in `package.json` yet, and then:
   - stops if `CHANGELOG.md` has no entry for the version;
   - rebuilds and retests the package, then publishes it with npm trusted
     publishing. GitHub supplies a short-lived OIDC identity; no npm token or
     project signing key is stored in the repository;
   - waits until npm serves the new version. Both announcements below send
     their readers to npm: the registry reads `mcpName` from the published
     `package.json`, and Glama's Auto-Release builds `jsonloupe@latest` on
     each GitHub Release;
   - creates the `vX.Y.Z` tag and its GitHub Release on the merged commit,
     with the version's `CHANGELOG.md` entry as the notes;
   - lists the version in the
     [MCP Registry](https://registry.modelcontextprotocol.io) through GitHub
     OIDC.

   No one needs to create the tag or the GitHub Release by hand. The workflow
   checks npm, the tag and the registry before each step, so a run that failed
   part way can be re-run from the Actions tab.
5. Verify the registry version, provenance, and clean installation before
   announcing it.

If the workflow cannot list the version in the MCP Registry, list it from the
repository root after npm shows the new version. Install the publisher once
with `brew install mcp-publisher`.

```sh
mcp-publisher login github
mcp-publisher publish
```

Only the current minor line is maintained. Patch releases carry compatible bug
and security fixes; users on an older minor line upgrade with
`npm install jsonloupe@latest`. Any future incompatible migration must be
documented in `CHANGELOG.md` before release.

## What is signed

npm signs the published package with the registry's ECDSA key. Trusted
publishing also attaches a Sigstore-signed SLSA provenance statement linking
the package bytes to this public repository, commit, and GitHub Actions build.
Sigstore uses an ephemeral signing key and publishes the certificate and proof
to its transparency infrastructure; there is no long-lived private release key
on npm or GitHub.

The public verification keys are discovered by npm through the npm registry
key endpoint and the public Sigstore trust root. The details are documented by
[npm provenance](https://github.com/npm/provenance) and
[npm's verification guide](https://docs.npmjs.com/generating-provenance-statements/#verifying-provenance-attestations).

## Verify an installed release

Use a current npm CLI in a clean directory, install without executing package
scripts, and verify registry signatures and provenance:

```sh
mkdir jsonloupe-verification
cd jsonloupe-verification
npm init -y
npm install --ignore-scripts jsonloupe@1.4.0
npm audit signatures
```

The command must report verified registry signatures and verified
attestations. Replace `1.4.0` with the version being checked. You can inspect
the published metadata without installing it:

```sh
npm view jsonloupe@1.4.0 dist.attestations dist.signatures --json
```

On npmjs.com, the green provenance indicator links to the source commit and
workflow run. Confirm that the source repository is
`github.com/priyanshuN/jsonloupe` and that the build came from
`.github/workflows/publish.yml` before relying on it.

## Git tags and GitHub assets

Important Git tags are not currently signed with a separate maintainer key.
This is recorded as an unmet suggested OpenSSF criterion rather than being
represented as stronger protection than exists. The npm artifact's registry
signature and Sigstore provenance remain the authoritative verification path.

If downloadable binaries or archives are added to GitHub Releases later, they
must receive their own Sigstore bundle or SLSA provenance and verification
instructions; npm provenance does not cover unrelated GitHub assets.
