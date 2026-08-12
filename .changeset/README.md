# Changesets

Each file here is one pending change: which packages it touches, whether it is a
patch/minor/major for each, and a line for the changelog.

```bash
pnpm changeset          # describe a change (writes a file here)
pnpm version-packages   # consume them: bump versions, write CHANGELOGs
pnpm release            # build, then publish what changed
```

Six packages depend on each other, so a bump to `@zswarm/core` cascades to
`@zswarm/cli`, `@zswarm/mcp`, and `@zswarm/wasm`, and to the root `zswarm`
meta-package that pins exact versions of the first two. That cascade is the
reason this exists — doing it by hand across six manifests is where releases
quietly go wrong.
