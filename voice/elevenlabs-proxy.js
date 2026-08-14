/**
 * ElevenLabs proxy for jarvis.html — a Cloudflare Worker.
 *
 * Why a proxy at all: jarvis.html is served from a PUBLIC GitHub Pages site.
 * An API key placed in that file is a key you have given away, and ElevenLabs
 * credits are spendable. The key lives here as a Worker secret instead, and
 * the page only ever calls this endpoint.
 *
 * A proxy is still a public endpoint, so it is guarded three ways:
 *   1. ALLOWED_ORIGINS — only your own pages may call it (browsers enforce
 *      this via CORS; the explicit check also rejects non-browser callers).
 *   2. MAX_CHARS — one morning brief is roughly 1,200 characters. This caps
 *      what a single call can cost you.
 *   3. SHARED_SECRET (optional) — set it and the page must send it too.
 *      Note that anything in a public page is readable, so this raises the
 *      effort required, it does not make the endpoint private.
 *
 * Deploy:
 *   npx wrangler init jarvis-voice          # then replace src/index.js with this file
 *   npx wrangler secret put ELEVENLABS_API_KEY
 *   npx wrangler deploy
 *
 * Then set VOICE_CONFIG.endpoint in jarvis.html to the deployed URL.
 * Leave it null and the page keeps using the browser's own voice.
 */

const ALLOWED_ORIGINS = [
  'https://diazconsultingfirm.github.io',
  'http://localhost:8080',
  'http://127.0.0.1:8080'
];

const MAX_CHARS = 2000;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Jarvis-Key',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin'
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405, cors);
    if (!allowed) return json({ error: 'Origin not allowed' }, 403, cors);

    if (env.SHARED_SECRET && request.headers.get('X-Jarvis-Key') !== env.SHARED_SECRET) {
      return json({ error: 'Bad key' }, 401, cors);
    }
    if (!env.ELEVENLABS_API_KEY) {
      return json({ error: 'ELEVENLABS_API_KEY secret is not set on this Worker' }, 500, cors);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Body must be JSON' }, 400, cors);
    }

    const text = String(body.text || '').trim();
    if (!text) return json({ error: 'No text' }, 400, cors);
    if (text.length > MAX_CHARS) {
      return json({ error: `Text is ${text.length} chars, limit is ${MAX_CHARS}` }, 413, cors);
    }

    /* Only ever pass through a voice id and model — never let the caller
       choose an arbitrary upstream path. */
    const voiceId = /^[A-Za-z0-9]{10,32}$/.test(body.voiceId || '') ? body.voiceId : 'JBFqnCBsd6RMkjVDRZzb';
    const model = /^[a-z0-9_.]{4,40}$/.test(body.model || '') ? body.model : 'eleven_turbo_v2_5';

    const upstream = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          model_id: model,
          /* Steady and a little understated — Jarvis is a butler, not a
             narrator. Raise style if you want more performance in it. */
          voice_settings: { stability: 0.45, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true }
        })
      }
    );

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      /* Pass the real status through so the page can log why it fell back to
         the browser voice instead of silently pretending it worked. */
      return json({ error: 'ElevenLabs error', status: upstream.status, detail: detail.slice(0, 400) }, upstream.status, cors);
    }

    return new Response(upstream.body, {
      headers: { ...cors, 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' }
    });
  }
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' }
  });
}
