"""GLB read / write and SeedThree's two glTF extensions as a post-pass (pure Python).

Blender's glTF exporter writes neither extension the app's export-glb.js adds with
GLTFExporter plugins, so the Blender edition exports a plain GLB and then edits
its JSON chunk:

  MSFT_lod   the de-facto glTF LOD extension. Nodes named <base>_LOD<n> are grouped
             by base; the LOD0 node gets {"ids": [the other levels' node indices]}
             and extras.MSFT_screencoverage (one entry per level + the cull
             threshold) from the live switch distances: coverage(d) =
             min(1, (height / (2 d tan 25deg))^2), the app's 50-degree reference camera.
  KHR_materials_diffuse_transmission
             the leaf / card / spine translucency: diffuseTransmissionFactor,
             diffuseTransmissionColorFactor and a diffuseTransmissionColorTexture
             appended to the binary chunk.
"""

import json
import math
import struct

GLB_MAGIC = 0x46546C67
JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942


def read_glb(path_or_bytes):
    data = path_or_bytes if isinstance(path_or_bytes, (bytes, bytearray)) else open(path_or_bytes, 'rb').read()
    magic, version, length = struct.unpack_from('<III', data, 0)
    if magic != GLB_MAGIC:
        raise ValueError('not a GLB')
    off = 12
    doc, binary = None, b''
    while off < length:
        clen, ctype = struct.unpack_from('<II', data, off)
        chunk = data[off + 8: off + 8 + clen]
        if ctype == JSON_CHUNK:
            doc = json.loads(chunk.decode('utf-8'))
        elif ctype == BIN_CHUNK:
            binary = bytes(chunk)
        off += 8 + clen
    return doc, binary


def write_glb(path, doc, binary):
    js = json.dumps(doc, separators=(',', ':')).encode('utf-8')
    js += b' ' * ((4 - len(js) % 4) % 4)
    binary = bytes(binary)
    binary += b'\0' * ((4 - len(binary) % 4) % 4)
    if doc.get('buffers'):
        doc['buffers'][0]['byteLength'] = len(binary)
        js = json.dumps(doc, separators=(',', ':')).encode('utf-8')
        js += b' ' * ((4 - len(js) % 4) % 4)
    total = 12 + 8 + len(js) + (8 + len(binary) if binary else 0)
    with open(path, 'wb') as fh:
        fh.write(struct.pack('<III', GLB_MAGIC, 2, total))
        fh.write(struct.pack('<II', len(js), JSON_CHUNK))
        fh.write(js)
        if binary:
            fh.write(struct.pack('<II', len(binary), BIN_CHUNK))
            fh.write(binary)
    return total


def screen_coverage(height, distances):
    """MSFTLodExtension.coverages: the switch distances of levels 1.. -> coverage, + 0.001."""
    if not height:
        return None
    t = math.tan(25 * math.pi / 180)
    return [min(1.0, (height / (2 * d * t)) ** 2) if d > 0 else 1.0 for d in distances] + [0.001]


def add_msft_lod(doc, coverages_by_base=None):
    """Group <base>_LOD<n> nodes; the LOD0 node carries MSFT_lod + extras.MSFT_screencoverage."""
    import re
    groups = {}
    for i, node in enumerate(doc.get('nodes', [])):
        m = re.match(r'^(.*)_LOD(\d+)$', node.get('name') or '')
        if m:
            groups.setdefault(m.group(1), []).append((int(m.group(2)), i))
    done = 0
    for base, lst in groups.items():
        if len(lst) < 2:
            continue
        lst.sort()
        node = doc['nodes'][lst[0][1]]
        node.setdefault('extensions', {})['MSFT_lod'] = {'ids': [i for _, i in lst[1:]]}
        cov = (coverages_by_base or {}).get(base)
        if cov:
            node.setdefault('extras', {})['MSFT_screencoverage'] = cov[:len(lst) - 1] + [cov[-1]]
        done += 1
    if done:
        used = doc.setdefault('extensionsUsed', [])
        if 'MSFT_lod' not in used:
            used.append('MSFT_lod')
    return done


def add_image(doc, binary, png_bytes, name=None):
    """Append a PNG to the binary chunk: -> (texture index, new binary)."""
    binary = bytearray(binary)
    pad = (4 - len(binary) % 4) % 4
    binary += b'\0' * pad
    offset = len(binary)
    binary += png_bytes
    bv = {'buffer': 0, 'byteOffset': offset, 'byteLength': len(png_bytes)}
    doc.setdefault('bufferViews', []).append(bv)
    img = {'bufferView': len(doc['bufferViews']) - 1, 'mimeType': 'image/png'}
    if name:
        img['name'] = name
    doc.setdefault('images', []).append(img)
    if not doc.get('samplers'):
        doc['samplers'] = [{'magFilter': 9729, 'minFilter': 9987, 'wrapS': 10497, 'wrapT': 10497}]
    doc.setdefault('textures', []).append({'sampler': 0, 'source': len(doc['images']) - 1})
    if not doc.get('buffers'):
        doc['buffers'] = [{'byteLength': 0}]
    return len(doc['textures']) - 1, binary


def add_diffuse_transmission(doc, binary, by_material):
    """by_material: {material name: {'factor', 'color', 'png' (bytes or None), 'texName'}}.
    Equal PNGs share one texture. -> (materials written, binary)."""
    done = 0
    cache = {}
    for mat in doc.get('materials', []):
        info = by_material.get(mat.get('name'))
        if not info:
            continue
        ext = {'diffuseTransmissionFactor': float(info.get('factor', 1.0))}
        if info.get('color') is not None:
            ext['diffuseTransmissionColorFactor'] = [float(c) for c in info['color']]
        png = info.get('png')
        if png:
            key = hash(png)
            if key not in cache:
                cache[key], binary = add_image(doc, binary, png, info.get('texName'))
            ext['diffuseTransmissionColorTexture'] = {'index': cache[key]}
        mat.setdefault('extensions', {})['KHR_materials_diffuse_transmission'] = ext
        done += 1
    if done:
        used = doc.setdefault('extensionsUsed', [])
        if 'KHR_materials_diffuse_transmission' not in used:
            used.append('KHR_materials_diffuse_transmission')
    return done, binary
