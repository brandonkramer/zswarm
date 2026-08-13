#!/usr/bin/env node
// A global install links only the installed package's own bins, never its
// dependencies'. This re-exposes the CLI so `npm i -g zswarm` yields `zswarm`.
import "@zswarm/cli";
