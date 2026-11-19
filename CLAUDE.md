# Reword

Inline copy editor shipped as a WXT browser extension, plus bookmarklet, userscript and drop-in builds. [README.md](README.md) covers features and the prompt format. [docs/reviewer-guide.md](docs/reviewer-guide.md) is for non-technical reviewers.

## Remotes

- `consultran` is Ben's copy, `Consultran/reword`. Push here.
- `origin` is the upstream repo, which we can't push to.

## Releasing

Every change merged to `main` bumps `version` in `package.json`. The extension manifest takes its version from there, so `chrome://extensions` shows which build is loaded.

- Bump the minor version (`0.3.0` to `0.4.0`) for a new feature or a change in behavior.
- Bump the patch version (`0.3.0` to `0.3.1`) for a fix that changes nothing else.
- Commit the bump on `main`, tag it `vX.Y.Z`, and push `main` and the tag to `consultran`.
- Run `pnpm build` from an up-to-date `main` in the main checkout. Ben's Chrome loads `.output/chrome-mv3` from there, then he reloads Reword in `chrome://extensions`.

Building from a stale checkout installs an old version, so check that `main` matches `consultran/main` first.
