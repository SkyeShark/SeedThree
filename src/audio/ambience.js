// Ambient soundscape — a looping WIND bed (Stable-Audio-3-generated, seamless
// loop, one per biome) plus randomly-interspersed BIRD CALLS. Temperate = leafy
// wind + crow/mallard; desert = dry wind + roadrunner/cactus-wren. Each bird kind
// has multiple variant recordings; a call picks a random variant, plays it SUBTLY
// with a fade in and fade out, at a random pan/pitch.
//
// Autoplay policy: browsers block audio until a user gesture, so nothing starts on
// load. The bottom-left button is that gesture — first click creates/resumes the
// AudioContext; thereafter it mutes/unmutes. Missing files are skipped gracefully.

// All clips resolve through the same Vite glob the textures use (works in dev AND
// a production build). Keyed by basename sans extension.
// Wind is WAV (gapless looping — MP3/OGG padding replays as a click every cycle);
// bird calls are MP3. Both resolve here, keyed by basename sans extension.
const modules = import.meta.glob('/assets/audio/*.{mp3,wav}', { eager: true, query: '?url', import: 'default' });
const URLS = {};
for (const [p, url] of Object.entries(modules)) URLS[p.split('/').pop().replace(/\.(mp3|wav)$/, '')] = url;

// Bird KINDS per biome; variants are any file named "<kind>" or "<kind>_<n>".
const BIRD_KINDS = { temperate: ['crow', 'mallard'], desert: ['roadrunner', 'cactus_wren'] };
const INTERVAL = { temperate: [6, 18], desert: [8, 24] }; // seconds between calls
const variantsOf = (kind) => Object.keys(URLS).filter((n) => n === kind || n.startsWith(kind + '_'));

const WIND_LEVEL = 0.01;   // barely-there faint bed (whisper-quiet)
const MASTER_ON = 1.0;
const BIRD_PEAK = [0.06, 0.14]; // quiet, per-call random
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const pick = (a) => a[Math.floor(Math.random() * a.length)];

export function createAmbience() {
  let ctx = null, master = null, birdBus = null;
  let enabled = false;
  let biome = 'temperate';
  let curWind = null;            // { biome, src, gain }
  const buffers = {};            // name -> AudioBuffer | Promise | 'missing'
  let birdTimer = 0;
  // "Live" = the user wants sound AND the context is actually running (autoplay
  // policy keeps it suspended until the first real interaction). The UI icon
  // tracks THIS, not intent — it must not show ON while the browser has us gagged.
  let onLiveChange = null;
  const isLive = () => enabled && !!ctx && ctx.state === 'running';
  const notify = () => onLiveChange?.(isLive());

  async function load(name) {
    const cached = buffers[name];
    if (cached === 'missing') return null;
    if (cached instanceof AudioBuffer) return cached;
    if (cached instanceof Promise) return cached;
    const url = URLS[name];
    if (!url) { buffers[name] = 'missing'; return null; }
    const p = fetch(url)
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.arrayBuffer(); })
      .then((ab) => ctx.decodeAudioData(ab))
      .then((buf) => { buffers[name] = buf; return buf; })
      .catch((e) => { console.warn(`[ambience] "${name}" unavailable:`, e.message); buffers[name] = 'missing'; return null; });
    buffers[name] = p;
    return p;
  }

  // Start the biome's wind loop, crossfading out whatever is currently playing.
  async function startWind(b) {
    if (!ctx) return;
    if (curWind && curWind.biome === b) return;
    const buf = await load('wind_' + b);
    const now = ctx.currentTime;
    if (curWind) {                       // fade the old bed out, then stop it
      const old = curWind; curWind = null;
      old.gain.gain.cancelScheduledValues(now);
      old.gain.gain.setValueAtTime(old.gain.gain.value, now);
      old.gain.gain.linearRampToValueAtTime(0.0001, now + 1.6);
      try { old.src.stop(now + 1.7); } catch { /* already stopped */ }
    }
    if (!buf) return;
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    const gain = ctx.createGain(); gain.gain.value = 0.0001;
    src.connect(gain).connect(master);
    src.start(now);
    gain.gain.linearRampToValueAtTime(WIND_LEVEL, now + 1.6); // fade the new bed in
    curWind = { biome: b, src, gain };
  }

  function playBird(name) {
    const buf = buffers[name];
    if (!(buf instanceof AudioBuffer)) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const rate = rand(0.96, 1.05);
    src.playbackRate.value = rate;
    const dur = buf.duration / rate;
    const peak = rand(BIRD_PEAK[0], BIRD_PEAK[1]);
    const fin = Math.min(0.35, dur * 0.3);          // fade in
    const fout = Math.min(0.8, dur * 0.45);         // fade out
    const g = ctx.createGain();
    const now = ctx.currentTime;
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(peak, now + fin);
    g.gain.setValueAtTime(peak, now + Math.max(fin, dur - fout));
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    src.connect(g);
    if (ctx.createStereoPanner) {
      const pan = ctx.createStereoPanner(); pan.pan.value = rand(-0.7, 0.7);
      g.connect(pan); pan.connect(birdBus);
    } else g.connect(birdBus);
    try { src.start(now); src.stop(now + dur + 0.05); } catch { /* ctx not running */ }
  }

  function scheduleNextBird() {
    clearTimeout(birdTimer);
    const [lo, hi] = INTERVAL[biome];
    birdTimer = setTimeout(async () => {
      if (enabled) {
        const kind = pick(BIRD_KINDS[biome]);
        const variant = pick(variantsOf(kind));
        if (variant) { await load(variant); if (enabled) playBird(variant); }
      }
      scheduleNextBird();
    }, rand(lo, hi) * 1000);
  }

  const preloadBirds = () => { for (const k of BIRD_KINDS[biome]) for (const v of variantsOf(k)) load(v); };

  async function enable() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      ctx.onstatechange = notify; // resume from ANY path (unlock, click) → icon flips
      master = ctx.createGain(); master.gain.value = 0; master.connect(ctx.destination);
      birdBus = ctx.createGain(); birdBus.gain.value = 1.0; birdBus.connect(master);
    }
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch { /* ignore */ } }
    enabled = true;
    notify();
    master.gain.setTargetAtTime(MASTER_ON, ctx.currentTime, 0.35);
    await startWind(biome);
    preloadBirds();
    scheduleNextBird();
  }

  function disable() {
    enabled = false;
    clearTimeout(birdTimer);
    if (ctx && master) master.gain.setTargetAtTime(0, ctx.currentTime, 0.25);
    notify();
  }

  // Default-ON: build the graph and start playing immediately. Browser autoplay
  // policy usually leaves the context 'suspended' until a user gesture, so if it
  // didn't start running, arm a one-time unlock on the first interaction (orbiting
  // the camera = a pointerdown on the canvas counts).
  async function autostart() {
    await enable();
    if (!ctx || ctx.state === 'running') return;
    const unlock = () => {
      for (const ev of ['pointerdown', 'keydown', 'touchstart']) window.removeEventListener(ev, unlock);
      if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    };
    for (const ev of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(ev, unlock, { passive: true });
  }

  return {
    isEnabled: () => enabled,
    isLive,
    onLive(cb) { onLiveChange = cb; },
    autostart,
    async toggle() { if (enabled) disable(); else await enable(); return enabled; },
    setBiome(b) {
      const next = b === 'desert' ? 'desert' : 'temperate';
      if (next === biome) return;
      biome = next;
      if (enabled) { startWind(biome); preloadBirds(); scheduleNextBird(); }
    },
  };
}

// Bottom-left corner toggle. Self-contained (injects its own styles); retints in
// the desert via the existing body.biome-desert class. Returns the ambience.
export function mountAmbience(parent = document.body) {
  const ambience = createAmbience();

  if (!document.getElementById('ambience-style')) {
    const style = document.createElement('style');
    style.id = 'ambience-style';
    style.textContent = `
      #ambience-toggle {
        position: fixed; left: 14px; bottom: 14px; z-index: 30;
        width: 42px; height: 42px; padding: 0; display: grid; place-items: center;
        border-radius: 10px; cursor: pointer; color: #a7bba3;
        background: rgba(11,15,20,0.62); border: 1px solid #26402e;
        box-shadow: 0 6px 20px rgba(0,0,0,0.35); backdrop-filter: blur(3px);
        transition: color .18s ease, border-color .18s ease, background .18s ease, transform .1s ease;
      }
      #ambience-toggle:hover { color: #d8eccf; border-color: #4e8f5a; background: rgba(16,26,16,0.8); }
      #ambience-toggle:active { transform: translateY(1px); }
      #ambience-toggle svg { width: 22px; height: 22px; display: block; }
      #ambience-toggle .wave { transition: opacity .18s ease; }
      #ambience-toggle.on { color: #6fae6a; border-color: #4e8f5a; }
      #ambience-toggle.off .wave { opacity: 0; }
      #ambience-toggle.off .slash { opacity: 1; }
      #ambience-toggle .slash { opacity: 0; }
      body.biome-desert #ambience-toggle { border-color: #5a4327; }
      body.biome-desert #ambience-toggle:hover { border-color: #d9a441; color: #f0d9a8; }
      body.biome-desert #ambience-toggle.on { color: #d9a441; border-color: #b98a34; }
    `;
    document.head.appendChild(style);
  }

  const btn = document.createElement('button');
  btn.id = 'ambience-toggle';
  // Starts MUTED-looking: the browser blocks sound until the first interaction, so
  // showing ON before then would be a lie. autostart() arms the unlock; the onLive
  // callback below flips the icon the instant audio actually begins.
  btn.className = 'off';
  btn.title = 'Ambient sound (wind + birds)';
  btn.setAttribute('aria-label', 'Toggle ambient sound');
  btn.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" stroke="none"/>
      <path class="wave" d="M16 8.5a5 5 0 0 1 0 7"/>
      <path class="wave" d="M18.5 6a8.5 8.5 0 0 1 0 12"/>
      <path class="slash" d="M3 3l18 18"/>
    </svg>`;
  // Icon reflects LIVE state (sound actually playing), not intent — it flips to ON
  // when the first interaction unlocks the context, and back to muted on toggle-off.
  ambience.onLive((live) => {
    btn.classList.toggle('on', live);
    btn.classList.toggle('off', !live);
    btn.title = live ? 'Mute ambient sound' : 'Ambient sound (wind + birds)';
  });
  btn.addEventListener('click', () => ambience.toggle()); // onLive updates the icon
  parent.appendChild(btn);

  ambience.autostart(); // sound goes live on the first page interaction

  return ambience;
}
