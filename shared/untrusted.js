// Text from outside the app — games and PGN files, game databases, backups, websites, and the coach's own earlier
// output — on its way to the coach. A model reads characters a person never sees: control characters (a terminal runs
// escape sequences), Unicode tag characters and variation selectors (whole hidden sentences), direction and zero-width
// marks. Those go. And "[App]", the mark of the app's own requests, cannot be imitated.

// C0 controls but tab and line feed, DEL, C1 controls; soft hyphen; Arabic letter mark; Hangul fillers; Khmer and
// Mongolian invisible marks; zero-width and direction marks, embeddings and overrides; word joiner, invisible operators
// and direction isolates; variation selectors; byte-order mark; interlinear annotation and other specials; tag
// characters; supplementary variation selectors. (Written as escapes: this file holds no invisible character itself.)
const HIDDEN =
  /[\0-\x08\x0b-\x1f\x7f-\x9f\xad\u{61c}\u{115f}\u{1160}\u{17b4}\u{17b5}\u{180b}-\u{180f}\u{200b}-\u{200f}\u{202a}-\u{202e}\u{2060}-\u{206f}\u{3164}\u{fe00}-\u{fe0f}\u{feff}\u{ffa0}\u{fff0}-\u{fffb}\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;
const APP_MARK = /\[\s*app\s*\]/gi;
const LINE_BREAK = /\r\n?|[\u{2028}\u{2029}]/gu;

/** Without control characters (but tab and line feed) and invisible ones. */
export const stripHidden = text => String(text ?? '').replace(HIDDEN, '');

/** What the coach may read of text from outside: no hidden characters, line breaks as \n, no "[App]". */
export const untrustedText = text => stripHidden(String(text ?? '').replace(LINE_BREAK, '\n')).replace(APP_MARK, '(App)');
