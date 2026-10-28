// The coach's voice in the window: what its speak tool says, and where it says nothing (the Book reader, where the
// book's voice reads). The system voice is a stand-in here: nothing is said out loud.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const said = [];
globalThis.window = {
  plymentor: {}, // (the desktop window may play sound before the first click)
  speechSynthesis: { speak: u => said.push(u.text), cancel() {}, getVoices: () => [] },
  addEventListener() {},
};
globalThis.SpeechSynthesisUtterance = class {
  constructor(text) {
    this.text = text;
  }
};
globalThis.location = { hash: '#/books/1a2b3c' };

const { setState } = await import('../../app/js/store.js');
const { coachSays } = await import('../../app/js/voice.js');

test('the coach does not talk in the Book reader; elsewhere it does', () => {
  setState({ settings: { language: 'English', voice: { enabled: true, engine: 'browser', rate: 1 } } });
  coachSays({ text: 'A word from your coach.' });
  location.hash = '#/books';
  coachSays({ text: 'Another word.' });
  assert.deepEqual(said, [], 'nothing said in the Book reader (a book, or the list of books)');
  location.hash = '#/analysis';
  coachSays({ text: 'Knight to f3.' });
  assert.deepEqual(said, ['Knight to f3.']);
  // (a screen whose name only begins like it is not the Book reader)
  location.hash = '#/bookshelf';
  coachSays({ text: 'Still talking.' });
  assert.deepEqual(said, ['Knight to f3.', 'Still talking.']);
});
