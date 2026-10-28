// The coach's natural voice: Kokoro-82M (Apache-2.0) through kokoro-js and onnxruntime-web, in a Web Worker of the
// Plymentor window so speech is generated without slowing the page. The model (32-bit, about 330 MB) is downloaded once
// from Hugging Face and kept in the window's cache (%LOCALAPPDATA%\Plymentor\app); it then runs offline — on the
// graphics card when there is one (WebGPU: a sentence is made in a tenth of the time it takes to say it), else on the
// processor (WebAssembly: a little faster than it is said). Not the smaller models: the 16-bit one makes no sound on
// graphics cards (its samples are NaN), and the 8-bit one (about 90 MB, the natural voice's first model) is made more
// slowly than it is said — a computer that has only that one speaks with it until the 32-bit one has come, in the
// background.
//
// Messages: { type: 'load' } -> progress events, then { type: 'loaded', device } | { type: 'error' }
//           { type: 'speak', id, text, voice, speed, trim } -> { type: 'audio', id, samples (Float32Array), rate } | { type: 'error', id }
//           { type: 'cancel', ids } -> the speech of these ids is not made (when it has not been yet)
//           and from the worker: { type: 'upgrading' }, then { type: 'upgraded', device } (the 32-bit model, in use)
import { KokoroTTS } from 'kokoro-js';
import { env } from '@huggingface/transformers';

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const FILE = dtype => `https://huggingface.co/${MODEL}/resolve/main/onnx/model${dtype === 'q8' ? '_quantized' : ''}.onnx`;
const VOICES = new Set(['af_heart', 'af_bella', 'af_nicole', 'am_michael', 'am_fenrir', 'am_puck', 'bf_emma', 'bm_george', 'bm_fable']);
const MAX_TEXT = 500;

// onnxruntime's WebAssembly files come with the app (not from a CDN).
env.backends.onnx.wasm.wasmPaths = '/voice/';
env.allowLocalModels = false;

let tts = null; // { model, device: 'webgpu' | 'wasm' }
let loading = null;
let upgrading = false;
let queue = Promise.resolve(); // one generation at a time
const dropped = new Set(); // ids whose speech is no longer wanted

/** Where the 32-bit model runs: on a graphics card ('webgpu', not one WebGPU only imitates in software), else 'wasm'. */
async function device() {
  try {
    const adapter = await self.navigator.gpu?.requestAdapter();
    return adapter && !adapter.info?.isFallbackAdapter && !adapter.isFallbackAdapter ? 'webgpu' : 'wasm';
  } catch {
    return 'wasm';
  }
}

async function cached(dtype) {
  try {
    return !!(await (await caches.open('transformers-cache')).match(FILE(dtype)));
  } catch {
    return false;
  }
}

function open(dtype, device, onProgress = null) {
  let shown = -1;
  return KokoroTTS.from_pretrained(MODEL, {
    dtype,
    device,
    progress_callback: p => {
      if (!onProgress || p.status !== 'progress' || !String(p.file).endsWith('.onnx')) return;
      const pct = Math.floor((p.progress || 0) / 5) * 5;
      if (pct !== shown) onProgress(pct);
      shown = pct;
    },
  });
}

/**
 * The 32-bit model on `where`, ready to speak: on the graphics card, its first speech compiles its shaders (seconds) —
 * made now, not on the first sentence; on the processor if the graphics card fails.
 */
async function best(where, onProgress = null) {
  if (where === 'webgpu')
    try {
      const model = await open('fp32', 'webgpu', onProgress);
      await model.generate('Ready.', { voice: 'af_heart' });
      return { model, device: 'webgpu' };
    } catch (e) {
      console.warn('the natural voice cannot use the graphics card:', e);
    }
  return { model: await open('fp32', 'wasm', onProgress), device: 'wasm' };
}

function load() {
  if (tts) return Promise.resolve(tts);
  loading ||= (async () => {
    const progress = percent => self.postMessage({ type: 'progress', percent });
    const where = await device();
    if ((await cached('fp32')) || !(await cached('q8'))) return (tts = await best(where, progress));
    tts = { model: await open('q8', 'wasm', progress), device: 'wasm' };
    upgrade(where);
    return tts;
  })().finally(() => {
    loading = null;
  });
  return loading;
}

/**
 * The 32-bit model, downloaded in the background while the 8-bit one speaks; then it speaks instead. (The file goes
 * into the cache by the browser itself — transformers.js would read it here, chunk by chunk, between the speeches this
 * worker makes meanwhile: much slower —; the model is then opened from there.)
 */
function upgrade(where) {
  if (upgrading) return;
  upgrading = true;
  self.postMessage({ type: 'upgrading' });
  (async () => {
    const cache = await caches.open('transformers-cache');
    if (!(await cache.match(FILE('fp32')))) {
      const res = await fetch(FILE('fp32'));
      if (!res.ok) throw new Error(`the download failed (HTTP ${res.status})`);
      await cache.put(FILE('fp32'), res);
    }
    return best(where);
  })()
    .then(t => {
      const old = tts;
      tts = t;
      // (the 8-bit model's memory is freed once the speech it is making has been made)
      queue = queue.then(() => old?.model.model.dispose?.()).catch(() => {});
      self.postMessage({ type: 'upgraded', device: t.device });
    })
    .catch(e => console.warn('the natural voice’s 32-bit model could not be downloaded:', e));
}

async function generate(m) {
  const { model, device: where } = await load();
  const text = String(m.text || '').slice(0, MAX_TEXT);
  const voice = VOICES.has(m.voice) ? m.voice : 'af_heart';
  const speed = Math.max(0.5, Math.min(2, Number(m.speed) || 1)); // (up to 2: the Book reader's fast reading)
  try {
    return await model.generate(text, { voice, speed });
  } catch (e) {
    if (where !== 'webgpu') throw e;
    // (the graphics card failed — its device lost —: the processor from now on)
    console.warn('the natural voice failed on the graphics card:', e);
    tts = await best('wasm');
    return tts.model.generate(text, { voice, speed });
  }
}

/** The speech without most of the silence the model puts before and after it (40 ms kept before it, 80 ms after). */
function trim(samples, rate) {
  const win = Math.round(rate / 100);
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  const floor = Math.max(0.002, peak * 0.01);
  const loud = i => {
    let sum = 0;
    const end = Math.min(samples.length, i + win);
    for (let j = i; j < end; j++) sum += samples[j] * samples[j];
    return Math.sqrt(sum / Math.max(1, end - i)) > floor;
  };
  let a = 0;
  while (a < samples.length && !loud(a)) a += win;
  let b = samples.length;
  while (b - win > a && !loud(b - win)) b -= win;
  if (a >= b) return samples;
  return samples.slice(Math.max(0, a - Math.round(rate * 0.04)), Math.min(samples.length, b + Math.round(rate * 0.08)));
}

self.onmessage = e => {
  const m = e.data || {};
  if (m.type === 'load') {
    load().then(
      t => self.postMessage({ type: 'loaded', device: t.device }),
      err => self.postMessage({ type: 'error', message: err?.message || String(err) }),
    );
  } else if (m.type === 'cancel') {
    for (const id of m.ids || []) dropped.add(id);
  } else if (m.type === 'speak') {
    const job = queue.then(async () => {
      if (dropped.delete(m.id)) return;
      try {
        const audio = await generate(m);
        const rate = audio.sampling_rate || 24000;
        let samples = audio.audio instanceof Float32Array ? audio.audio : new Float32Array(audio.audio);
        for (let i = 0; i < samples.length; i++) if (Number.isNaN(samples[i])) samples[i] = 0; // (never a sound that is no number)
        if (m.trim) samples = trim(samples, rate);
        self.postMessage({ type: 'audio', id: m.id, samples, rate }, [samples.buffer]);
      } catch (err) {
        self.postMessage({ type: 'error', id: m.id, message: err?.message || String(err) });
      }
    });
    queue = job.catch(() => {});
  }
};
