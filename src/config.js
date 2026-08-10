const os = require('os');
const path = require('path');
const fs = require('fs');

// The Second Brain vault this app reads/writes. Override with SECOND_BRAIN_VAULT env var.
// Vault location differs per machine (Windows benchmark box vs. Mac dev machine), so when no
// env override is set, pick the first candidate that actually exists on this OS.
function resolveVaultPath() {
  if (process.env.SECOND_BRAIN_VAULT) return process.env.SECOND_BRAIN_VAULT;

  const home = os.homedir();
  const candidates = [
    path.join(home, 'Documents', 'Projects', 'second_brain'), // Mac
    path.join(home, 'Desktop', 'Projects', 'second_brain'), // Windows
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  return found || candidates[0];
}

const VAULT_PATH = resolveVaultPath();

module.exports = { VAULT_PATH };
