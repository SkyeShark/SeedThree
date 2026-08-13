This repository contains an unofficial WebGPU/TSL adaptation derived from N8AO.

Upstream project:

- N8AO by N8python
- Repository: https://github.com/N8python/n8ao
- npm package: https://www.npmjs.com/package/n8ao

This package intentionally preserves parts of the upstream mental model where practical:

- configuration names and default values
- quality presets and display modes
- transparency conventions via `userData.treatAsOpaque` and `userData.cannotReceiveAO`
- blue-noise sampling asset vendored from upstream `src/BlueNoise.js`

Important upstream licensing note:

- The upstream repository README and LICENSE file describe CC0-1.0.
- The upstream npm package metadata currently lists ISC.

This repository now uses `CC0-1.0` at the root to stay aligned with the upstream GitHub repository's published LICENSE and README.

Current status:

- public GitHub repository: ready
- npm package publication: ready
- remaining caveat: upstream npm metadata previously appeared as ISC, so this repo intentionally documents that it followed the upstream GitHub license source instead
