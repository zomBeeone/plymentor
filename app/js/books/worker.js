// The Book reader's worker for diagrams (bundled as /js/bookscan.js): finds the boards in a scanned page's picture or
// in an EPUB's picture, and reads the positions of a book's boards (diagrams.js), away from the window.
import { grayFrom, findBoards, findPictureBoard, packBoard, unpackBoard, readBoards, placement, pieceExample } from './diagrams.js';

self.onmessage = e => {
  const { id, op } = e.data;
  try {
    if (op === 'find') {
      const img = grayFrom(new Uint8Array(e.data.rgba), e.data.width, e.data.height);
      const boards = findBoards(img).map(b => ({ x: b.x, y: b.y, width: b.width, height: b.height, board: packBoard(b) }));
      self.postMessage({ id, boards });
    } else if (op === 'picture') {
      const b = findPictureBoard(grayFrom(new Uint8Array(e.data.rgba), e.data.width, e.data.height));
      self.postMessage({ id, board: b ? packBoard(b) : null });
    } else if (op === 'read') {
      const boards = e.data.boards.map(unpackBoard);
      // (the app's pieces, to start from: e.data.glyphs, grey pictures of them alone on a light square)
      readBoards(boards, { examples: (e.data.glyphs || []).map(g => pieceExample(g.type, g)) });
      self.postMessage({ id, readings: boards.map(b => ({ placement: b.pieces ? placement(b) : null, sure: b.sure || 0, alts: b.alts || [] })) });
    } else throw new Error(`unknown request ${op}`);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
