#!/usr/bin/env python3
"""Publish the UNIVERSAL field catalog from the master tool exports.

FALLBACK path. The grouping tool's "Publish to field" button now exports the
field files (items.json + assemblies.json) directly, so the normal flow doesn't
need this. Use this only to regenerate the field files from the MASTER exports
(materials-catalog.json + assemblies.json) -- it applies the same rules:

  catalog/items.json       {description, unit, keywords}
                           active items PLUS any item an ACTIVE assembly references
                           (so the field can order everything its bills call for),
                           de-duped by description.
  catalog/assemblies.json  active assemblies, group baked from category, NO flat[]
                           (the field PWA flattens kit refs from lines[] at runtime).

COMPANY-WIDE (not per-job): every job's field form reads the same files.

Usage:  py tools/publish-catalog.py [src_dir]
  src_dir holds materials-catalog.json + assemblies.json. Defaults to ./catalog-src/.
"""
import json, math, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'catalog-src')
OUT_DIR = os.path.join(ROOT, 'catalog')
os.makedirs(OUT_DIR, exist_ok=True)


def load(name):
    with open(os.path.join(SRC_DIR, name), encoding='utf-8') as f:
        return json.load(f)


# ── load catalog + assemblies; build kit index ───────────────────────────────
cat = load('materials-catalog.json')
asm = load('assemblies.json')
ASM_BY_ID = {a['id']: a for a in asm.get('assemblies', []) if a and a.get('id')}


def flatten_asm(a, seen):
    """Expand kit `ref` lines into leaf items (faithful to the tool's flattenAsm).
    Used only to discover which items the active assemblies reference -- the field
    PWA flattens at runtime, so we no longer ship flat[]."""
    out = []
    for l in a.get('lines', []):
        ref = l.get('ref')
        if ref:
            sub = ASM_BY_ID.get(ref)
            if (not sub) or (ref in seen):
                continue
            s2 = set(seen); s2.add(ref)
            out.extend(flatten_asm(sub, s2))
        else:
            out.append(l)
    return out


def is_active_asm(a):
    return bool(a and not a.get('retired') and (a.get('name') or '').strip())


# itemIds referenced by ACTIVE assemblies -- kept in the field even if retired.
used_iids = set()
for a in asm.get('assemblies', []):
    if not is_active_asm(a):
        continue
    for l in a.get('lines', []):
        if not l.get('ref') and l.get('itemId'):
            used_iids.add(l['itemId'])
    if any(l.get('ref') for l in a.get('lines', [])):
        for k in flatten_asm(a, set([a['id']])):
            if k.get('itemId'):
                used_iids.add(k['itemId'])

# ── items: active OR used-by-an-active-assembly, de-duped by description ──────
seen, order, kept_for_asm = {}, [], 0
for it in cat.get('items', []):
    if not it:
        continue
    status = it.get('status', 'active')
    if status and status != 'active':
        if it.get('id') not in used_iids:
            continue
        kept_for_asm += 1
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

# ── assemblies: active only, bake group, NO flat[] (PWA flattens at runtime) ──
active = []
for a in asm.get('assemblies', []):
    if not is_active_asm(a):
        continue
    b = dict(a)
    b.pop('flat', None)
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
print('items   active+deduped:', len(items), '(from', len(cat.get('items', [])), 'master;',
      kept_for_asm, 'retired items kept because an active assembly uses them)')
print('assembl active:', len(active), '(from', len(asm.get('assemblies', [])), 'master) -- no flat[], PWA flattens')
print('groups:', len(groups))
for g in groups:
    print('   -', g)
for n, p in (('items.json', os.path.join(OUT_DIR, 'items.json')),
             ('assemblies.json', os.path.join(OUT_DIR, 'assemblies.json'))):
    print('%-16s %6.1f KB' % (n, os.path.getsize(p) / 1024))
