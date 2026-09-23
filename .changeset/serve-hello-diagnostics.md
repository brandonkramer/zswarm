---
"@zswarm/core": patch
---

Add authenticated serve hello (protocol 1) and transport diagnostics: probeServe, UTF-8 JSONL reply caps sized for dump/status (8MiB capture, no silent truncate), required success `data`, and connect/hello/request error details without SSH fallback.
