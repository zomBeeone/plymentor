// Applies the board theme and piece set (lichess assets).
export const BOARD_THEMES = [
  ['brown', 'png'],
  ['wood4', 'jpg'],
  ['blue', 'png'],
  ['green', 'png'],
  ['ic', 'png'],
  ['purple', 'png'],
  ['wood', 'jpg'],
  ['maple', 'jpg'],
  ['blue3', 'jpg'],
  ['marble', 'jpg'],
  ['olive', 'jpg'],
  ['grey', 'jpg'],
  ['leather', 'jpg'],
  ['blue-marble', 'jpg'],
  ['canvas', 'jpg', 'canvas2'],
  ['green-plastic', 'png'],
  ['pink', 'png', 'pink-pyramid'],
  ['metal', 'jpg'],
];
export const boardImage = ([name, ext, file]) => `/assets/board/${file || name}.${ext}`;

// Only piece sets under free licences (GPL, AGPL, Apache, MIT — see licenses.html). A set saved in the settings that is
// not here any more shows as cburnett.
export const PIECE_SETS = ['cburnett', 'merida', 'chessnut', 'fantasy', 'pirouetti', 'mpchess', 'kosal'];
const pieceSet = name => (PIECE_SETS.includes(name) ? name : 'cburnett');

const ROLES = { pawn: 'P', knight: 'N', bishop: 'B', rook: 'R', queen: 'Q', king: 'K' };

let styleEl;
export function applyBoardTheme(board = {}) {
  document.body.dataset.board = board.theme || 'brown';
  document.body.classList.toggle('no-coords', board.coords === false);
  const set = pieceSet(board.pieces);
  if (!styleEl) {
    styleEl = document.createElement('style');
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = Object.entries(ROLES)
    .flatMap(([role, l]) => ['white', 'black'].map(c => `.cg-wrap piece.${role}.${c}{background-image:url(/assets/piece/${set}/${c[0]}${l}.svg)}`))
    .join('\n');
}

export const pieceUrl = (set, color, role) => `/assets/piece/${pieceSet(set)}/${color[0]}${ROLES[role]}.svg`;
