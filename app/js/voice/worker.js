// The coach's natural voice: Kokoro-82M (Apache-2.0) through kokoro-js and onnxruntime-web, in a Web Worker of the
// Plymentor window so speech is generated without slowing the page. The model (about 90 MB, 8-bit) is downloaded
// once from Hugging Face and kept in the window's cache (%LOCALAPPDATA%\Plymentor\app); it then runs offline.
//
// Messages: { type: 'load' } -> progress events, then { type: 'loaded' } | { type: 'error' }
//           { type: 'speak', id, text, voice, speed } -> { type: 'audio', id, samples (Float32Array), rate } | { type: 'error', id }
import { KokoroTTS } from 'kokoro-js';
import { env } from '@huggingface/transformers';

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const VOICES = new Set(['af_heart', 'af_bella', 'af_nicole', 'am_michael', 'am_fenrir', 'am_puck', 'bf_emma', 'bm_george', 'bm_fable']);
const MAX_TEXT = 500;

// onnxruntime's WebAssembly files come with the app (not from a CDN).
env.backends.onnx.wasm.wasmPaths = '/voice/';
env.allowLocalModels = false;

let tts = null;
let loading = null;
let queue = Promise.resolve(); // one generation at a time

function load() {
  if (tts) return Promise.resolve(tts);
  if (!loading) {
    let shown = -1;
    loading = KokoroTTS.from_pretrained(MODEL, {
      dtype: 'q8',
      device: 'wasm',
      progress_callback: p => {
        if (p.status !== 'progress' || !String(p.file).endsWith('.onnx')) return;
        const pct = Math.floor((p.progress || 0) / 5) * 5;
        if (pct !== shown) self.postMessage({ type: 'progress', percent: pct });
        shown = pct;
      },
    })
      .then(model => {
        tts = model;
        return model;
      })
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}

self.onmessage = e => {
  const m = e.data || {};
  if (m.type === 'load') {
    load().then(
      () => self.postMessage({ type: 'loaded' }),
      err => self.postMessage({ type: 'error', message: err?.message || String(err) }),
    );
  } else if (m.type === 'speak') {
    const job = queue.then(async () => {
      try {
        const model = await load();
        const text = String(m.text || '').slice(0, MAX_TEXT);
        const voice = VOICES.has(m.voice) ? m.voice : 'af_heart';
        const speed = Math.max(0.7, Math.min(1.4, Number(m.speed) || 1));
        const audio = await model.generate(text, { voice, speed });
        const samples = audio.audio instanceof Float32Array ? audio.audio : new Float32Array(audio.audio);
        self.postMessage({ type: 'audio', id: m.id, samples, rate: audio.sampling_rate || 24000 }, [samples.buffer]);
      } catch (err) {
        self.postMessage({ type: 'error', id: m.id, message: err?.message || String(err) });
      }
    });
    queue = job.catch(() => {});
  }
};
