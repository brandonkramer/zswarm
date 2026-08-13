---
"@zswarm/core": patch
---

Nudge Zellij into pushing a manifest to a cold plugin, and accept flags before the op.

Zellij pushes a pane manifest on change and never on subscribe, and the plugin
API cannot ask for one, so a freshly launched bus instance sat at `ready:false`
in a quiet session and every call fell back to polling. Renaming a pane to the
title it already has is an invisible change that forces the push.

`parseCliArgv` also took the first argument as the op unconditionally, so
`zswarm --session crew list` reported `--session` as an unknown op.

Both landed in git before the meta-package was published, but the wrapper shipped
pinning the previous versions, so neither reached npm.
