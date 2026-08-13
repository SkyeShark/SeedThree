Vendored from npm `n8ao-webgpu@0.1.0` (github.com/marioandf/n8ao-webgpu, CC0-1.0),
a three.js WebGPU port of N8AO by N8python — endorsed by the original author.
Only change: bare `three` / `three/tsl` / `three/webgpu` import specifiers are
pinned to `npm:three@0.184.0` so Deno cannot resolve a second three instance
(the package's peer range is ^0.182.0). No code changes.
