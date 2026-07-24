const os = require('os');
const path = require('path');

// The Second Brain vault this app reads/writes. Override with SECOND_BRAIN_VAULT env var.
const VAULT_PATH =
  process.env.SECOND_BRAIN_VAULT ||
  path.join(os.homedir(), 'Desktop', 'Projects', 'second_brain');

module.exports = { VAULT_PATH };
