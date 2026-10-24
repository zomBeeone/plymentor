// A stand-in for Plymentor's releases on GitHub, on 127.0.0.1, for the end-to-end test of updates: what electron-updater
// asks a GitHub host for — the Atom feed of the releases, the newest release (the API of a GitHub host other than
// github.com), the files of a release, also in byte ranges (differential downloads). It counts the bytes it sends.
import { createServer } from 'node:http';

export async function startFakeGitHub({ owner = 'zomBeeone', repo = 'plymentor' } = {}) {
  const base = `/${owner}/${repo}/releases`;
  let latest = null; // the newest release's version
  const files = new Map(); // "v1.2.3/name" → bytes
  const sent = new Map(); // file name → bytes sent
  const requests = [];

  const feed = () => `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en-US">
  <id>tag:github.com,2008:https://github.com/${owner}/${repo}/releases</id>
  <link type="text/html" rel="alternate" href="https://github.com/${owner}/${repo}/releases"/>
  <title>Release notes from ${repo}</title>
  <updated>2026-10-23T10:00:00Z</updated>${
    latest
      ? `
  <entry>
    <id>tag:github.com,2008:Repository/1/v${latest}</id>
    <updated>2026-10-23T10:00:00Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/${owner}/${repo}/releases/tag/v${latest}"/>
    <title>Plymentor ${latest}</title>
    <content type="html">&lt;p&gt;Unsigned notes from the feed&lt;/p&gt;</content>
  </entry>`
      : ''
  }
</feed>`;

  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    requests.push({ path, headers: req.headers });
    const send = (status, body, type = 'application/octet-stream', headers = {}) => {
      res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), ...headers });
      res.end(body);
    };
    if (path === `${base}.atom`) return send(200, feed(), 'application/atom+xml');
    if (path === `/api/v3/repos/${owner}/${repo}/releases/latest`) return latest ? send(200, JSON.stringify({ tag_name: `v${latest}` }), 'application/json') : send(404, '{}', 'application/json');
    if (path.startsWith(`${base}/download/`)) {
      const key = path.slice(base.length + '/download/'.length);
      const bytes = files.get(key);
      if (!bytes) return send(404, 'Not Found', 'text/plain');
      const name = key.split('/').pop();
      const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
      if (range) {
        const [start, end] = [Number(range[1]), Math.min(Number(range[2]), bytes.length - 1)];
        const part = bytes.subarray(start, end + 1);
        sent.set(name, (sent.get(name) || 0) + part.length);
        return send(206, part, 'application/octet-stream', { 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Accept-Ranges': 'bytes' });
      }
      sent.set(name, (sent.get(name) || 0) + bytes.length);
      return send(200, bytes, 'application/octet-stream', { 'Accept-Ranges': 'bytes' });
    }
    send(404, 'Not Found', 'text/plain');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    sent,
    /** Makes version the newest release, with its files ({ name: bytes }; latest.yml among them). */
    release(version, releaseFiles) {
      for (const [name, bytes] of Object.entries(releaseFiles)) files.set(`v${version}/${name}`, Buffer.from(bytes));
      latest = version;
    },
    close: () => new Promise(resolve => server.close(resolve)),
  };
}
