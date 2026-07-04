// Panel GPU effect: "living sap veins" — thin organic veins meandering through
// dark wood, pulsing with amber-green light, via a domain-warped fbm fragment
// shader. Opaque (no glassmorphism), cheap (quarter-res canvas, 30fps cap),
// and unmistakably SeedThree.

const FS = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform float uT;
uniform float uAmber; // 0 = forest green sap, 1 = desert amber sap
out vec4 o;
float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n2(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p){ float s = 0.0, a = 0.5; for (int k = 0; k < 5; k++){ s += a * n2(p); p *= 2.03; a *= 0.5; } return s; }
void main(){
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = uv * vec2(uRes.x / uRes.y, 1.0) * 2.3;
  // domain warp: veins meander like growth rings gone wandering
  vec2 w = vec2(fbm(p + uT * 0.012), fbm(p + 5.2 - uT * 0.009));
  float v = fbm(p + 1.8 * w);
  // Sap veins — fatter, brighter filaments plus a broad green "pooling" between
  // them so the effect reads as flowing liquid, not faint threads.
  float band = abs(fract(v * 4.0) - 0.5);
  float vein = smoothstep(0.030, 0.003, band - 0.462);      // fatter filaments
  float gate = smoothstep(0.40, 0.66, fbm(p * 0.9 + 13.0)); // more veins carry sap
  float flow = 0.5 + 0.5 * sin(v * 30.0 - uT * 0.9);        // light traveling the thread
  float pool = smoothstep(0.55, 0.96, v) * gate;            // broad green pools between veins
  // dark bark, faint moss tinge — brown base, green rides on top
  vec3 wood = mix(vec3(0.043, 0.040, 0.031), vec3(0.074, 0.066, 0.048), fbm(p * 3.1));
  wood += vec3(0.008, 0.016, 0.007) * fbm(p * 1.3);
  // sap base shifts green→amber for the desert biome (uAmber)
  vec3 green = mix(vec3(0.11, 0.36, 0.16), vec3(0.44, 0.26, 0.07), uAmber);
  vec3 sap = mix(green, vec3(0.90, 0.64, 0.24), flow * flow * 0.65);
  vec3 col = wood + pool * green * 0.30 + vein * gate * sap * (0.32 + 0.62 * flow);
  col += 0.012 * fbm(p * 9.0); // grain
  o = vec4(col, 1.0);
}`;

const VS = `#version 300 es
void main(){
  vec2 p = vec2[](vec2(-1,-1), vec2(3,-1), vec2(-1,3))[gl_VertexID];
  gl_Position = vec4(p, 0, 1);
}`;

export function mountPanelFX(host) {
  const canvas = document.createElement('canvas');
  canvas.className = 'st-fx';
  host.prepend(canvas);
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
  if (!gl) { canvas.remove(); return; }

  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { canvas.remove(); return; }
  gl.useProgram(prog);
  const uRes = gl.getUniformLocation(prog, 'uRes');
  const uT = gl.getUniformLocation(prog, 'uT');
  const uAmber = gl.getUniformLocation(prog, 'uAmber');

  const fit = () => {
    // quarter-res is plenty for soft veins — keeps the effect ~free
    const w = Math.max(2, Math.floor(host.clientWidth / 2));
    const ht = Math.max(2, Math.floor(host.clientHeight / 2));
    if (canvas.width !== w || canvas.height !== ht) {
      canvas.width = w;
      canvas.height = ht;
      gl.viewport(0, 0, w, ht);
    }
  };
  new ResizeObserver(fit).observe(host);

  let last = 0;
  const loop = (t) => {
    requestAnimationFrame(loop);
    if (t - last < 33) return; // 30fps cap
    last = t;
    fit();
    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.uniform1f(uT, t / 1000);
    // read the biome straight off the body class each frame — no plumbing needed
    gl.uniform1f(uAmber, document.body.classList.contains('biome-desert') ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  requestAnimationFrame(loop);
}
