// Builds the single-file ES module bundles the app imports from app/vendor/ (scripts/build.mjs then bundles them).
// Only needed when upgrading the frontend libraries: `npm install` then `node scripts/vendor.mjs`.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'app', 'vendor');
mkdirSync(out, { recursive: true });

const bundles = {
  'chessops.js': `
    export * from 'chessops';
    export { parseFen, makeFen, makeBoardFen, INITIAL_FEN, INITIAL_EPD, EMPTY_FEN } from 'chessops/fen';
    export { parseSan, makeSan, makeSanAndPlay, makeSanVariation } from 'chessops/san';
    export { parsePgn, parseComment, makeComment, startingPosition, makePgn, PgnParser, ChildNode } from 'chessops/pgn';
    export { chessgroundDests, chessgroundMove } from 'chessops/compat';
    export { castlingSide, normalizeMove } from 'chessops/chess';
  `,
  'chessground.js': `export { Chessground } from '@lichess-org/chessground';`,
  'preact.js': `
    import { h } from 'preact';
    import htm from 'htm';
    export { h, render, Fragment, createContext, createRef, Component, toChildArray, cloneElement } from 'preact';
    export { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, useReducer, useContext, useErrorBoundary, useId } from 'preact/hooks';
    export const html = htm.bind(h);
  `,
  'marked.js': `export { marked, Marked } from 'marked';`,
  'xterm.js': `
    export { Terminal } from '@xterm/xterm';
    export { FitAddon } from '@xterm/addon-fit';
    export { WebLinksAddon } from '@xterm/addon-web-links';
  `,
};

for (const [file, contents] of Object.entries(bundles)) {
  await build({
    stdin: { contents, resolveDir: root, loader: 'js' },
    bundle: true,
    format: 'esm',
    target: 'es2022',
    minify: true,
    legalComments: 'eof',
    outfile: join(out, file),
    logLevel: 'warning',
  });
  console.log('built', file);
}

copyFileSync(
  join(root, 'node_modules', '@lichess-org', 'chessground', 'assets', 'chessground.base.css'),
  join(out, 'chessground.base.css'),
);
console.log('copied chessground.base.css');
copyFileSync(join(root, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'), join(out, 'xterm.css'));
console.log('copied xterm.css');
