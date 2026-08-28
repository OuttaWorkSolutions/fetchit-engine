# Releasing

Releases publish automatically from GitHub Actions using OIDC trusted
publishing. No tokens are stored anywhere, and no one-time passwords are
typed. `.github/workflows/publish.yml` runs the full gate on every push, and
on a `v*` tag it additionally publishes whatever versions are not already on
the registries (already-published versions are skipped, so re-running a tag
is always safe).

## Releasing a new version

1. Make the change in the primary repo's `packages/` (single source of
   truth), pass the gate there, and sync the changed files here as usual.
2. Bump the versions: `js/package.json`, `py/pyproject.toml` (these two move
   in exact lockstep and must match the tag), and `js/review/package.json`
   (same major.minor; may take its own patches). Bump the review package's
   `peerDependencies` range only if the new engine falls outside
   `>=0.1.2 <1.0.0`.
3. Update `CHANGELOG.md`, commit, push `main`.
4. Tag and push the tag (this is the publish trigger):

       git tag v0.3.0
       git push origin main
       git push origin v0.3.0

5. Watch the run at https://github.com/OuttaWorkSolutions/fetchit-engine/actions
   and confirm from the registries themselves:

       node engine-core/check-published.mjs

## One-time registry setup (owner, once per registry)

The workflow authenticates with short-lived OIDC tokens that the registries
mint only for THIS repo and THIS workflow file. That trust link is configured
on each registry once:

**npm** (do this twice: once on the `@fetchitai/engine` package page, once on
`@fetchitai/review`):

1. Sign in at npmjs.com, open the package page, then the Settings tab.
2. In the Trusted Publisher section choose GitHub Actions and enter:
   organization or user `OuttaWorkSolutions`, repository `fetchit-engine`,
   workflow filename `publish.yml`. Leave environment blank.
3. Save. Publishes from this workflow now need no token; npm also attaches
   provenance attestations automatically.

**PyPI** (once):

1. Sign in at pypi.org, open Your projects, then `fetchit-engine`, then
   Manage, then Publishing.
2. Add a new publisher: GitHub, owner `OuttaWorkSolutions`, repository
   `fetchit-engine`, workflow name `publish.yml`. Leave environment blank.
3. Add.

Nothing is configured on the GitHub side: the workflow declares its own
`id-token: write` permission and the repo stores no secrets.

## Validating the setup without publishing anything

After the registry setup, push a tag for the CURRENT versions:

    git tag v0.2.0
    git push origin v0.2.0

Every version is already live, so the npm steps print "already on the
registry, skipping" and the PyPI action authenticates via OIDC and skips the
existing files. A green run proves the pipeline end to end with zero risk.
(The npm OIDC exchange itself is first exercised on the next real release,
since skipped publishes never reach it; the PyPI exchange is exercised by the
validation tag.)

## Notes

- Manual publishing still works exactly as before (`npm publish --access
  public` with OTP, `twine upload` with the token). The workflow just makes
  it unnecessary.
- Optional hardening later: pin the action versions to commit SHAs, restrict
  npm publishing access to the trusted publisher only (package Settings), or
  add a GitHub environment with required reviewers to the publish jobs.
