// CommonJS on purpose: ncc resolves ESM imports to web-tree-sitter's ESM build,
// whose `var require = createRequire(...)` breaks once bundled. require() picks the CJS build.
module.exports = require('web-tree-sitter')
