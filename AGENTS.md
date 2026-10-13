# Repository guidelines

## Development

Runtime modules live at the package root; `ui/` contains internal rendering primitives, `skills/` contains on-demand coordination guidance, and `test/` mirrors those boundaries. [SPEC.md](SPEC.md) is the design contract; [docs/ui.md](docs/ui.md) describes the UI layer. `preview.ts` and `ui/preview-runtime.ts` are development-only and excluded from the package tarball.

```bash
npm install
npm test
npm run typecheck
npm run check
npm run preview
```

## Versioning and publishing

Every push of repository changes must include a new package version and its matching release tag, including documentation-only changes. A request to commit and push includes this release procedure; a request only to edit files does not authorize a push or publication.

1. Review the complete outgoing diff and any unpublished commits for private paths, credentials, session transcripts, and personal configuration. Keep those out of commits and the npm package; use a GitHub noreply email for commit metadata.
2. Bump the version before committing. Use `npm version patch --no-git-tag-version` for fixes and documentation-only changes; choose minor or major for changes that warrant them. Commit both `package.json` and `package-lock.json`, including the lockfile's root package version. Never reuse a published version or move an existing release tag.
3. Run the tests, type check, and code checks listed above. Inspect `npm pack --dry-run` to verify what will be published.
4. Commit the changes and version bump together. Create `v<version>` on that exact commit, with the version matching `package.json`. Push the branch and this specific tag together using `git push --atomic origin HEAD "v<version>"` (replace the placeholder with the actual version). Do not push unrelated tags or force-push. Do not push only the branch and leave npm on the old version.
5. Use `gh run list` and `gh run view` to check the Publish workflow for that tag and commit. Report publication as complete only after the workflow succeeds and the new version is visible on npm. If it fails, report the failure rather than equating a successful Git push with a successful release.

[The Publish workflow](.github/workflows/publish.yml) runs on pushed `v*` tags, not ordinary branch pushes. It verifies that the tag matches the package version, installs dependencies, checks types and code style, runs tests, then publishes `@chthub/pi-subagents` to npm through OIDC trusted publishing. No npm token belongs in this repository. Version bumps and tags are maintainer responsibilities; the workflow does not create them automatically.
