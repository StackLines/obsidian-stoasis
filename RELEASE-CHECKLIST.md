# Release checklist

Work through this list, in order, before tagging a release. Tags are the bare
version (`0.1.0`, never `v0.1.0`) and must equal the version in
`manifest.json`.

1. The working tree is clean, you are on `main`, and CI is green on the commit
   to be tagged.
2. `npm ci && npm run check` passes locally (lint, tests, build, README status
   and leak check).
3. `CHANGELOG.md` has a section for the new version with today's date and
   user-facing notes only.
4. The version is bumped with `npm version <patch|minor|major>`, never by
   hand. Confirm that `manifest.json`, `versions.json` and `package.json`
   agree: `node scripts/check-release.mjs <version>`.
5. `minAppVersion` is still correct for the APIs used. If it was raised,
   `versions.json` maps the version accordingly.
6. `THIRD_PARTY_NOTICES.md` covers every bundled or adapted file.
7. `README.md` is current: the Features table, the Status section, the
   disclosures, and the Install and Pairing text match the shipped behaviour.
8. The leak check passes with history and the local denylist loaded:
   `npm run leak-check -- --history --require-denylist`.
9. Spot-check: `git ls-files` lists no tooling, backlog, scratch or
   private-contract files, and the bundle contains none of the denylist
   strings.
10. The tag is annotated or lightweight, equals the manifest version, and its
    message (if any) is the version only.
11. Dry run: `npm run build`, then
    `node scripts/stage-release.mjs "$(mktemp -d)"` lists exactly `main.js`,
    `manifest.json` and `styles.css`. Copy them into a clean test vault under
    `.obsidian/plugins/stoa/`, enable the plugin, open its settings, and
    confirm the status reads "not paired".
12. After pushing the tag, the release workflow finishes and the release has
    exactly the three assets. A version with a suffix such as `-beta.1` is
    published as a prerelease for testers; the community directory only
    installs plain `x.y.z` versions.

The release workflow needs no secrets. It builds and checks the assets with a
read-only token, then publishes exactly the three assets in a separate job
that runs no project code. When the repository is public, that job also adds a
build provenance attestation for each asset. An optional repository secret
named `LEAKCHECK_DENYLIST`, holding the same newline-separated list as the
local denylist, adds the repository-specific rules to the leak check in CI;
item 8 is what guarantees they ran before a release.
