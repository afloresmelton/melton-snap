#!/usr/bin/env python3
"""Publish the UNIVERSAL field catalog from the master tool exports.

Reads the master `materials-catalog.json` (all items, all statuses) and the
master `assemblies.json` (active + retired) and writes the slim, ACTIVE-ONLY
files the field PWA consumes:

  catalog/items.json       {description, unit, keywords}  (active, de-duped)
  catalog/assemblies.json  active kits, with `group` baked from category name

These are COMPANY-WIDE (not per-job): every job's field form reads the same one.

Re-publish workflow: export `materials-catalog.json` + `assemblies.json` from
the grouping tool, drop them into ./catalog-src/ (gitignored — local only),
run this script, then commit + push the regenerated catalog/ files.

Usage:  py tools/publish-catalog.py [src_dir]
  src_dir holds the two master exports. Defaults to ./catalog-src/.
"""
import json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'catalog-src')
OUT_DIR = os.path.join(ROOT, 'catalog')
os.makedirs(OUT_DIR, exist_ok=True)


def load(name):
    with open(os.path.join(SRC_DIR, name), encoding='utf-8') as f:
        return json.load(f)


# ── items: master catalog → slim active, de-duped by description ──────────────
cat = load('materials-catalog.json')
seen, order = {}, []
for it in cat.get('items', []):
    if not it:
        continue
    status = it.get('status', 'active')
    if status and status != 'active':
        continue
    desc = (it.get('description') or '').strip()
    if not desc:
        continue
    kw = it.get('keywords') or []
    kw = [str(k).strip() for k in (kw if isinstance(kw, list) else [kw]) if str(k).strip()]
    key = desc.lower()
    if key in seen:
        e = seen[key]
        for k in kw:
            if k.lower() not in e['_kw']:
                e['_kw'].add(k.lower()); e['keywords'].append(k)
        if not e['unit'] and it.get('unit'):
            e['unit'] = it.get('unit')
    else:
        e = {'description': desc, 'unit': it.get('unit') or '',
             'keywords': list(kw), '_kw': set(k.lower() for k in kw)}
        seen[key] = e; order.append(e)

items = [{'description': e['description'], 'unit': e['unit'],
          'keywords': ' '.join(e['keywords'])} for e in order]

with open(os.path.join(OUT_DIR, 'items.json'), 'w', encoding='utf-8') as f:
    json.dump({'schema': 'field-items/1', 'generated_from': 'materials-catalog/2',
               'source_generated_at': cat.get('generated_at'),
               'count': len(items), 'items': items},
              f, ensure_ascii=False, separators=(',', ':'))

# ── assemblies: active only, bake group = category (already a friendly name) ─
asm = load('assemblies.json')
active = []
for a in asm.get('assemblies', []):
    if not a or a.get('retired') or not (a.get('name') or '').strip():
        continue
    b = dict(a)
    if not b.get('group'):
        b['group'] = b.get('category') or ''
    active.append(b)

with open(os.path.join(OUT_DIR, 'assemblies.json'), 'w', encoding='utf-8') as f:
    json.dump({'schema': asm.get('schema', 'assemblies/2'),
               'generated_from': 'assemblies-tool',
               'source_generated_at': asm.get('generated_at'),
               'categories': asm.get('categories', []),
               'companions': asm.get('companions', []),
               'count': len(active), 'assemblies': active},
              f, ensure_ascii=False, separators=(',', ':'))

groups = sorted({a.get('group') for a in active if a.get('group')})
print('items   active+deduped:', len(items), '(from', len(cat.get('items', [])), 'master)')
print('assembl active:', len(active), '(from', len(asm.get('assemblies', [])), 'master)')
print('groups:', len(groups))
for g in groups:
    print('   -', g)
for n, p in (('items.json', os.path.join(OUT_DIR, 'items.json')),
             ('assemblies.json', os.path.join(OUT_DIR, 'assemblies.json'))):
    print('%-16s %6.1f KB' % (n, os.path.getsize(p) / 1024))
