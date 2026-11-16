# AST context supply chain

| Asset | Source | Pin | SHA-256 |
|---|---|---|---|
| `web-tree-sitter` (npm) | `tree-sitter/tree-sitter`, MIT, no runtime deps | exact `0.27.2` in `package.json` + lockfile | covered by `package-lock.json` integrity |
| `vendor/tree-sitter-c.wasm` | official npm tarball `tree-sitter-c@0.24.1` (gitHead `7fa1be1b694b6e763686793d97da01f36a0e5c12`, integrity `sha512-lkYwWN3SRecpvaeqmFKkuPNR3ZbtnvHU+4XAEEkJdrp3JfSp2pBrhXOtvfsENUneye76g889Y0ddF2DM0gEDpA==`) | `0.24.1` | `c852c2a85ebf2beb636aa3b0ef7f7e70458684d74f6741b20dcb296885bed9f9` |

Third-party wasm bundles (e.g. `tree-sitter-wasms`) are intentionally not used.
Upgrade = re-download the official tarball, update this table, re-run `npm run eval:context`.
`npm install` must use `--ignore-scripts`; `tree-sitter-c` is never installed (native build deps).
