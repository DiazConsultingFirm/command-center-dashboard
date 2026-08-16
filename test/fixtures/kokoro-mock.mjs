/**
 * A stand-in for kokoro-js, so the Kokoro code path in jarvis.html can be
 * tested without downloading a few hundred megabytes — or any network at all.
 *
 * This does NOT prove the real library works. It proves OUR half works: export
 * detection, the progress callback, voice-list substitution, every result
 * shape we accept, and the fallback when we get something we do not recognise.
 * The real library is verified by a human hearing it speak, once.
 *
 * Behaviour is selected by query string, because ES modules are cached per URL
 * and each test needs a fresh one:
 *
 *   ?mode=toBlob    result exposes toBlob()            (the common case)
 *   ?mode=raw       result is { audio, sampling_rate }  (exercises our WAV encoder)
 *   ?mode=garbage   result is unrecognisable            (must fall back)
 *   ?mode=loadfail  from_pretrained throws              (must fall back)
 *   ?mode=novoice   model lacks the configured voice    (must substitute)
 *   ?mode=noexport  module has no KokoroTTS export      (must fall back)
 */

const MODE = new URL(import.meta.url).searchParams.get('mode') || 'toBlob';

/** A real, playable WAV so playback is exercised rather than simulated. */
function tone(seconds = 0.3, rate = 24000) {
  const n = Math.floor(seconds * rate);
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = Math.sin((i / rate) * 2 * Math.PI * 220) * 0.2;
  return { samples, rate };
}

function wav(samples, rate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([view], { type: 'audio/wav' });
}

class KokoroTTSImpl {
  static async from_pretrained(model, opts = {}) {
    if (MODE === 'loadfail') throw new Error('mock: model host unreachable');
    /* TWO files on purpose. transformers.js reports 0→100 per file, and a
       single-file mock cannot catch a throttle that goes quiet once the first
       file completes — which is exactly the bug a global high-water mark had.
       The second file is what makes that test able to fail. */
    if (opts && typeof opts.progress_callback === 'function') {
      for (const file of ['model_q8.onnx', 'voices.bin']) {
        for (const progress of [0, 10, 50, 100]) {
          opts.progress_callback({ status: 'progress', file, progress });
        }
      }
    }
    return new KokoroTTSImpl(model, opts);
  }

  constructor(model, opts) {
    this.model = model;
    this.opts = opts;
    this.lastVoice = null;
  }

  list_voices() {
    /* novoice deliberately omits bm_george, the configured default, but keeps
       another British one so the substitution has a correct answer to find. */
    return MODE === 'novoice'
      ? ['am_adam', 'af_sarah', 'bf_emma']
      : ['bm_george', 'bf_emma', 'am_adam'];
  }

  async generate(text, opts = {}) {
    this.lastVoice = opts.voice;
    if (MODE === 'garbage') return { unexpected: 'shape' };
    const t = tone();
    if (MODE === 'raw') return { audio: t.samples, sampling_rate: t.rate };
    return { toBlob: () => wav(t.samples, t.rate) };
  }
}

/* noexport withholds the export on purpose, to prove we detect a missing or
   renamed API and fall back, rather than throwing an opaque TypeError later. */
export const KokoroTTS = MODE === 'noexport' ? undefined : KokoroTTSImpl;
