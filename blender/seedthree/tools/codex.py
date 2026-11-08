"""harvest-codex-image.mjs in Python: pull generated PNGs out of the newest Codex
session log (~/.codex/sessions/**/rollout-*.jsonl) into asset files.

    from seedthree.tools.codex import harvest_codex_image
    harvest_codex_image(['leaf_albedo.png'])                 # the most recent image
    harvest_codex_image(['a.png', 'b.png'], match='willow')  # the last two of the newest
                                                             # session whose prompt says 'willow'
    harvest_codex_image(list_only=True)                      # {'session', 'images'}

Never prints the base64, only a summary.
"""

import base64
import json
import os
import re


def sessions_root(home=None):
    return os.path.join(home or os.path.expanduser('~'), '.codex', 'sessions')


def newest_session(match=None, root=None):
    """The newest rollout-*.jsonl; with `match`, the newest whose first 4 MB contain it."""
    root = root or sessions_root()
    if not os.path.isdir(root):
        return None
    best, best_t = None, -1.0
    kw = match.lower() if match else None
    for d, _dirs, files in os.walk(root):
        for f in files:
            if not (f.startswith('rollout-') and f.endswith('.jsonl')):
                continue
            full = os.path.join(d, f)
            t = os.stat(full).st_mtime * 1000
            if t <= best_t:
                continue
            if kw:
                with open(full, 'rb') as fh:
                    head = fh.read(4194304).decode('utf-8', 'replace').lower()
                if kw not in head:
                    continue
            best_t, best = t, full
    return best


def images_from(session_file):
    """Distinct generated images (base64 strings) in generation order."""
    out, seen = [], set()
    with open(session_file, 'r', encoding='utf-8', errors='replace') as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
            except ValueError:
                continue
            p = o.get('payload') if isinstance(o, dict) else None
            if not isinstance(p, dict):
                continue
            r = p.get('result')
            if p.get('type') in ('image_generation_call', 'image_generation_end') and isinstance(r, str) and len(r) > 5000:
                key = '%d:%s' % (len(r), r[:32])
                if key in seen:
                    continue
                seen.add(key)
                out.append(r)
    return out


def harvest_codex_image(outs=None, match=None, list_only=False, root=None):
    """Write the last len(outs) images of the newest (matching) session to `outs`, in order.
    -> {'session', 'saved': [{'out', 'bytes', 'isPng'}]} (or {'session', 'images'})."""
    sess = newest_session(match, root)
    if not sess:
        raise FileNotFoundError('no codex session found%s' % (' matching "%s"' % match if match else ''))
    imgs = images_from(sess)
    if list_only or not outs:
        rep = {'session': os.path.basename(sess), 'images': len(imgs)}
        print(json.dumps(rep))
        return rep
    if len(imgs) < len(outs):
        raise ValueError('only %d image(s) in session, need %d' % (len(imgs), len(outs)))
    chosen = imgs[len(imgs) - len(outs):]
    report = []
    for out, b64 in zip(outs, chosen):
        buf = base64.b64decode(re.sub(r'^data:image/\w+;base64,', '', b64))
        with open(out, 'wb') as fh:
            fh.write(buf)
        report.append({'out': out, 'bytes': len(buf), 'isPng': buf[:4] == b'\x89PNG'})
    rep = {'session': os.path.basename(sess), 'saved': report}
    print(json.dumps(rep, indent=1))
    return rep


def cli_harvest_codex_image(args):
    args = list(args)
    match = None
    if '--match' in args:
        i = args.index('--match')
        match = args[i + 1]
        del args[i:i + 2]
    if not args or args[0] == '--list':
        harvest_codex_image(match=match, list_only=True)
        return 0
    harvest_codex_image(args, match=match)
    return 0
