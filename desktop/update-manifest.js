// The signed description of a Plymentor release, which updates rely on (the app: updates.js; the release:
// scripts/sign-release.mjs).
//
// Every release on GitHub has a latest.yml — the file electron-updater reads — with an extra entry
//   plymentor: { payload, signature }
// payload is JSON text: the version, the release notes, and the name, size and SHA-512 of the installer (and of a
// portable .exe, when a release has one — Plymentor's releases have only the installer). signature is its Ed25519
// signature with Studio Nox's release key, whose private half stays on the
// computer the releases are made on (never on GitHub). The app has the public half built in (update-key.js) and uses an
// update only when the signature is right, its description matches latest.yml, and the downloaded file has the signed
// size and SHA-512 — so neither someone who got into the GitHub account nor anyone on the way can make Plymentor
// install anything else.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { createReadStream } from 'node:fs';

export const RELEASE_KIND = 'plymentor-release';
const FORMAT = 1;
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const SHA512_RE = /^[A-Za-z0-9+/]{86}==$/;

export const setupName = version => `Plymentor-${version}-setup.exe`;
export const portableName = version => `Plymentor-${version}-portable.exe`;

/** Is version a newer than b? (x.y.z) */
export function isNewer(a, b) {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

/** The size and SHA-512 (base64, as in latest.yml) of a file. */
export function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512');
    let size = 0;
    createReadStream(file, { highWaterMark: 1 << 20 })
      .on('data', chunk => {
        size += chunk.length;
        hash.update(chunk);
      })
      .on('error', reject)
      .on('end', () => resolve({ size, sha512: hash.digest('base64') }));
  });
}

/** Throws unless the file is the one described ({ size, sha512 }). */
export async function checkFile(file, expected) {
  const { size, sha512 } = await hashFile(file);
  if (size !== expected.size || sha512 !== expected.sha512) throw new Error('The downloaded file is not the one Studio Nox released (its checksum differs), so it is not used.');
}

/**
 * The signed entry for a release: { payload, signature }.
 * release: { version, date, notes, setup: { size, sha512 }, portable?: { size, sha512 } }; privateKey: PEM (PKCS #8).
 */
export function signRelease(release, privateKey) {
  const { version, date, notes, setup, portable } = release;
  const files = { setup: { name: setupName(version), size: setup.size, sha512: setup.sha512 } };
  if (portable) files.portable = { name: portableName(version), size: portable.size, sha512: portable.sha512 };
  const payload = JSON.stringify({ kind: RELEASE_KIND, format: FORMAT, app: 'Plymentor', version, date, notes, files });
  readPayload(payload); // the same checks as the app's
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('The release key must be an Ed25519 key.');
  return { payload, signature: sign(null, Buffer.from(payload, 'utf8'), key).toString('base64') };
}

const keyCache = new Map();
function publicKey(spki) {
  if (!keyCache.has(spki)) {
    const key = createPublicKey({ key: Buffer.from(spki, 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('Not an Ed25519 key');
    keyCache.set(spki, key);
  }
  return keyCache.get(spki);
}

function readPayload(payload) {
  let p;
  try {
    p = JSON.parse(payload);
  } catch {
    throw new Error('The description of this update cannot be read.');
  }
  const file = (f, name) => f && f.name === name && Number.isSafeInteger(f.size) && f.size > 0 && SHA512_RE.test(f.sha512 || '');
  const ok =
    p &&
    p.kind === RELEASE_KIND &&
    p.format === FORMAT &&
    p.app === 'Plymentor' &&
    VERSION_RE.test(p.version || '') &&
    typeof p.date === 'string' &&
    typeof p.notes === 'string' &&
    file(p.files?.setup, setupName(p.version)) &&
    (p.files.portable === undefined || file(p.files.portable, portableName(p.version)));
  if (!ok) throw new Error('The description of this update is not one of a Plymentor release.');
  return p;
}

/**
 * The release electron-updater found (the parsed latest.yml), if it is signed with one of the keys (base64 SPKI) and
 * its latest.yml describes the signed installer: { version, date, notes, files: { setup, portable? } }. Throws otherwise.
 */
export function readRelease(info, keys) {
  const signed = info?.plymentor;
  if (!signed || typeof signed.payload !== 'string' || typeof signed.signature !== 'string') throw new Error('This update is not signed by Studio Nox, so it is not installed.');
  if (signed.payload.length > 200_000) throw new Error('The description of this update is too long.');
  const signature = Buffer.from(signed.signature, 'base64');
  const data = Buffer.from(signed.payload, 'utf8');
  if (signature.length !== 64 || !keys.some(k => verify(null, data, publicKey(k), signature))) throw new Error('This update is not signed with Studio Nox’s key, so it is not installed.');
  const p = readPayload(signed.payload);
  // what electron-updater downloads (latest.yml's files) must be the signed installer
  const files = Array.isArray(info.files) ? info.files : [];
  const f = files[0];
  if (info.version !== p.version || files.length !== 1 || !f || f.url !== p.files.setup.name || f.sha512 !== p.files.setup.sha512 || Number(f.size) !== p.files.setup.size)
    throw new Error('This update’s files do not match its signed description, so it is not installed.');
  return p;
}
