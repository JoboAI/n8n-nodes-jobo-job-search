// n8n discovers this package's nodes and credentials through the `n8n` block in
// package.json, not through this entry point — but npm resolves `main`, and a
// `main` pointing at a file that isn't in the published tarball is exactly the
// kind of inconsistency the verification pre-check flags. Mirrors the layout of
// n8n-nodes-starter.
module.exports = {};
