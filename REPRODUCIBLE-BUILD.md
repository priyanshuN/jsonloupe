# Reproducible build

jsonloupe's browser, CLI, MCP, and npm-package outputs are reproducible from an
exact source commit. The build uses the committed `package-lock.json`, Node
24.16.0, npm 11.13.0, UTC, the C locale, and a fixed `SOURCE_DATE_EPOCH`.

## Independent verification

On a clean machine, check out the exact commit to verify and run:

```sh
nvm install
nvm use
npm install --global npm@11.13.0
npm ci --ignore-scripts
npm run check:reproducible-build
```

The check copies the source to two different temporary paths, performs a fresh
locked dependency installation in each path, builds all three distributions,
creates the npm tarball, and compares every output byte. It fails if any file
is missing or differs. On success it prints the Node/npm versions and one
SHA-256 digest over the sorted output manifest; two parties verifying the same
commit can compare that digest directly.

The test deliberately ignores the caller's `node_modules`. npm's shared
download cache may avoid fetching the same package twice, but each build gets
its own dependency tree created by `npm ci` from the lockfile.

## CI and release evidence

Every pull request and push to `main` runs the same check on a fresh GitHub
Actions runner. Release publishing separately starts from a clean checkout,
installs from the lockfile, runs the test suite and build, and attaches npm
provenance to the published package. The CI log for an exact commit is the
public verification record; rerunning the workflow provides an independent
fresh-run comparison.

The `engines.node` field remains `>=18` because it describes the supported
runtime for people installing the package. `devEngines`, `.nvmrc`, and the
workflow pins describe the narrower toolchain used to reproduce release bytes.
