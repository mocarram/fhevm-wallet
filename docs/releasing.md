# Releasing

A release is one `chore(release): X.Y.Z` commit on `main` (version in `package.json` and
`package-lock.json`, a `## X.Y.Z — date` section in `CHANGELOG.md`), a `vX.Y.Z` tag on
that commit, and the package on npm. `fhew --version` reads `package.json`, so the
version lives in those two files and the changelog only.

## 1. Prepare the release commit (skip for 2.0.0: it is on `main`)

```bash
git checkout staging && git pull --ff-only
```

```bash
npm version X.Y.Z --no-git-tag-version
```

Move the `Unreleased` notes in `CHANGELOG.md` under `## X.Y.Z — YYYY-MM-DD`, then commit
`chore(release): X.Y.Z`, push `staging`, wait for CI, and fast-forward `main`:

```bash
git checkout main && git merge --ff-only staging && git push origin main
```

## 2. Check out exactly what you publish

```bash
git checkout main && git pull --ff-only && git status
```

`git status` must be clean, and `node -v` must be 24.11 or later.

```bash
npm ci
```

```bash
npm run verify
```

## 3. Look at the package before it goes out

```bash
npm pack --dry-run
```

It should list only `dist/`, `README.md`, `CHANGELOG.md`, `LICENSE` and `package.json`: no `.env`, no
tests, no data files. To try the exact tarball first:

```bash
npm pack
```

```bash
npm install -g ./fhevm-wallet-X.Y.Z.tgz
```

```bash
fhew --version
```

Then run through [docs/manual-testing.md](manual-testing.md) on Sepolia.

## 4. Publish

```bash
npm whoami
```

It must print the account that owns `fhevm-wallet` on npm. If not, `npm login` first.

```bash
npm publish
```

`prepublishOnly` cleans `dist/` and runs `npm run verify` again before anything is
uploaded. With two-factor authentication npm asks for a one-time code (or pass
`--otp <code>`). The release goes to the `latest` tag; a pre-release would use
`npm publish --tag next` so `npm install fhevm-wallet` does not pick it up.

## 5. Tag and announce

```bash
git tag -a vX.Y.Z -m "fhevm-wallet X.Y.Z" && git push origin vX.Y.Z
```

On GitHub, create a release from the tag (Releases › Draft a new release) and paste the
version's section from `CHANGELOG.md`.

## 6. Check it

```bash
npm view fhevm-wallet version
```

```bash
npm install -g fhevm-wallet@X.Y.Z && fhew --version
```

## If something is wrong after publishing

Publish a fixed `X.Y.Z+1` rather than removing the release: a version number can never be
reused on npm, even after it is unpublished. To warn people off a bad version:

```bash
npm deprecate fhevm-wallet@X.Y.Z "Use X.Y.Z+1: <reason>"
```

npm only allows unpublishing a recent version under its unpublish policy; check
[npm's documentation](https://docs.npmjs.com/policies/unpublish) before relying on it.
