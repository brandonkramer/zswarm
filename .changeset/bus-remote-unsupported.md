---
"@zswarm/core": patch
---

Refuse `bus --install` / `--clear` over direct SSH with `bus_remote_unsupported` before session discovery or marker writes. Run those mutations on the Zellij host or through `--serve`; read-only remote bus reports are unchanged.
