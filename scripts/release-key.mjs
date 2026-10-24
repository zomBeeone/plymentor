// Studio Nox's release key for Plymentor's updates (Ed25519): makes it once, and shows its public half.
//   node scripts/release-key.mjs
// The private half stays on the computer the releases are made on — %USERPROFILE%\.plymentor\release-signing-key.pem
// (PLYMENTOR_SIGNING_KEY: another file) — outside the repository and OneDrive. Never commit or upload it; keep a copy
// somewhere safe (a USB stick, a password manager). Without it no update can be signed, and the installed copies would
// then have to be updated by hand once, to a version with a new key.
// The public half is in desktop/update-key.js: the app installs only updates signed with this key.
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const KEY_FILE = process.env.PLYMENTOR_SIGNING_KEY || join(homedir(), '.plymentor', 'release-signing-key.pem');

/** The public half (base64 DER SPKI, as in desktop/update-key.js) of a private key in PEM. */
export const publicHalf = pem => createPublicKey(createPrivateKey(pem)).export({ type: 'spki', format: 'der' }).toString('base64');

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/').split('/').pop())) {
  if (existsSync(KEY_FILE)) {
    console.log(`The release key is ${KEY_FILE}`);
  } else {
    const { privateKey } = generateKeyPairSync('ed25519');
    mkdirSync(dirname(KEY_FILE), { recursive: true });
    writeFileSync(KEY_FILE, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
    console.log(`Made a new release key: ${KEY_FILE}\nKeep a copy of it somewhere safe, and never commit or upload it.`);
  }
  console.log(`Its public half (desktop/update-key.js): ${publicHalf(readFileSync(KEY_FILE, 'utf8'))}`);
}
