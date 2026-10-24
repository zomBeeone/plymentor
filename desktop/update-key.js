// Studio Nox's release key, its public half (Ed25519, base64 DER SPKI): Plymentor installs only updates whose release
// is signed with it (see update-manifest.js). The private half is on the computer the releases are made on, never in
// this repository (scripts/release-key.mjs). A new key would go here next to this one, for one release at least.
export const RELEASE_KEYS = ['MCowBQYDK2VwAyEAcv3x9qbilmhjQ4YVqVYCBBQIqpYdUl0LgAbZbVXM3rc='];
