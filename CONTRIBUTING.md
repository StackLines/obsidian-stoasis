# Contributing

Thanks for helping. This page is short on purpose; the rules are here so that
the repository stays safe to open and easy to review.

## Setup

```sh
npm ci
npm run dev        # watch build into main.js
npm test           # unit tests
npm run check      # lint, tests, build, README status and leak check
```

To try a build, copy `main.js`, `manifest.json` and `styles.css` into
`<vault>/.obsidian/plugins/stoa/` of a test vault and reload Obsidian.

The plugin runs on desktop and mobile, so code under `src/` must not use Node
or Electron APIs. Keep logic that does not need the app in pure modules (see
`src/protocol.ts`) so it can be unit tested without a vault.

## Keeping your own files out of the repository

The tracked `.gitignore` covers build output, secrets and a private working
folder. Anything that is personal to you stays untracked:

- **Your own ignore rules** go in `.git/info/exclude` of your clone (worktrees
  of the same clone share it) or in a global excludes file
  (`git config --global core.excludesfile ~/.config/git/ignore`). Nothing in
  the tracked `.gitignore` should name a particular editor or tool.
- **A private folder** named `.local/` at the repository root is ignored.
  Use it for notes, working copies of documents that are not public, and the
  local leak-check denylist.
- **Tool and assistant instruction files** are personal: keep them untracked
  and ignored through one of the two mechanisms above. Rules that apply to
  everyone belong in this file.

Check what is ignored with `git status --ignored` and
`git check-ignore -v <path>`. The leak check fails if a tracked file matches
an ignore rule or sits outside the expected layout.

## The leak check

`npm run leak-check` scans tracked files, commit messages, tag and branch
names and the built bundle for private addresses, internal-looking hostnames,
task keys, credentials and tooling traces. It prints a rule id and a masked
excerpt, never the match.

Repository-specific strings are kept out of the repository. Put one
case-insensitive regular expression per line in `.local/leak-denylist.txt`
(ignored), or provide the same list in the `LEAKCHECK_DENYLIST` environment
variable. Maintainers can ask for the shared list.

## Commits and pull requests

- Subjects use Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`,
  `ci:`, `chore:`), in the imperative, at most 72 characters. The body, when
  there is one, explains why.
- One logical change per commit.
- No trailers or footers added by tools, no `Co-Authored-By` lines, no session
  or conversation references, and no task-tracker keys or internal ticket
  numbers in commit messages, tags, pull request titles or bodies, issues or
  release notes.
- Optional but recommended: enable the commit-msg hook that checks all of
  this locally with `git config core.hooksPath .githooks`.
- Pull requests are squash-merged with the pull request title as the subject.

### README upkeep

Every pull request that adds, changes or removes a user-visible behaviour,
setting, command, requirement or disclosure updates `README.md` in the same
pull request: the Features table, the Status section, and the Install or
Pairing text where affected. Releases are blocked until the README reflects the
shipped behaviour (see `RELEASE-CHECKLIST.md`, item 7).

## Wording in tracked files

Everything that is tracked, including code, comments, tests, fixtures, docs and
workflow files, follows these rules:

- The server is described only as "a compatible server" or "your server".
- No internal product names, hostnames, domains, private addresses, real
  people's names, real note content or ticket numbers.
- Examples and fixtures use invented values: `alice`, `bob`, `example.com`,
  `https://notes.example.test`, and the documentation address ranges
  `192.0.2.0/24`, `198.51.100.0/24` and `203.0.113.0/24`. Never use `10.x`,
  `172.16-31.x` or `192.168.x`, even as examples.
- Comments explain behaviour, not where a request came from.
- User interface strings say "your server", never an environment-specific
  name.

## Third-party code

If you bundle a dependency or adapt code from another project, add it to
`THIRD_PARTY_NOTICES.md` in the same commit, with its licence text.

## Releases

Releases follow `RELEASE-CHECKLIST.md`. Tags are the bare version and are
created by a maintainer.
