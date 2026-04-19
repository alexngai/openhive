#!/usr/bin/env node

// OpenHive CLI entry point.
// The package is published as ESM (`"type": "module"`), so this bin shim
// must use dynamic import rather than `require`. Older versions used
// `require('../dist/cli.js')` and crashed at startup with
// "require is not defined in ES module scope".
import('../dist/cli.js');
