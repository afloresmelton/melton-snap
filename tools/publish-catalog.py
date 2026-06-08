#!/usr/bin/env python3
"""Publish the UNIVERSAL field catalog from the master tool exports.

FALLBACK path. The grouping tool's "Publish to field" button normally exports the
field files (items.json + assemblies.json) directly. Use this only to regenerate
them from the MASTER exports (materials-catalog.json + assemblies.json). Rules:

  catalog/items.json       {description, unit, keywords}
                           active items PLUS any item an ACTIVE assembly references
                           (so the field can order everything its bills call for),
                           de-duped by description.
  catalog/assemblies.json  active assemblies, group baked from category, WITH flat[]
                           (pre-expanded kit leaves).

  flat[] note: the field PWA (v-flatten and later) recomputes kit leaves from lines[]
  at runtime and ignores flat[]. But OLDER cached PWA code still relies on flat[], and
  the service worker serves code cache-first -- so we keep shipping flat[] until every
  phone has the new code. Dropping it later is a pure size optimization, safe only once
  the new code is universal.

COMPANY-WIDE (not per-job): every job's field form reads the same files.

Usage:  py tools/publish-catalog.py [src_dir]   (src_dir defaults to ./catalog-src/)
"""
import json, math, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'catalog-src')
OUT_DIR = os.path.join(ROOT, 'catalog')
os.makedirs(OUT_DIR, exist_ok=True)


def load(name):
    with open(os.path.join(SRC_DIR, name), encoding='utf-8') as f:
        return json.load(f)


cat = load('materials-catalog.json')
asm = load('assemblies.json')
ASM_BY_ID = {a['id']: a for a in asm.get('assemblies', []) if a and a.get('id')}


def _jr(x):                       # JS Math.round (all factors here are positive)
    return math.floor(x + 0.5)


def flatten_asm(a, seen):
    """Faithful port of the grouping tool's flattenAsm: expand kit `ref` lines into
    effective-factor leaf items. Used both to find assembly-referenced items and to
    build flat[]."""
    out = []
    for l in a.get('lines', []):
        ref = l.get('ref')
        if ref:
            sub = ASM_BY_ID.get(ref)
            if (not sub) or (ref in seen):
                out.append({'itemId': '', 'description': l['description'] + (' (circular)' if sub else ' (missing kit)'),
                            'base': l['base'], 'fct1': l['fct1'], 'fct2': l['fct2'], 'matched': False})
                continue
            s2 = set(seen); s2.add(ref)
            for k in flatten_asm(sub, s2):
                ln = (l['base'] == 'Len') or (k['base'] == 'Len')
                out.append({'itemId': k['itemId'], 'description': k['description'],
                            'base': 'Len' if ln else 'Cnt',
                            'fct1': _jr(l['fct1'] * k['fct1'] * 1e4) / 1e4,
                            'fct2': (l['fct2'] if l['base'] == 'Len' else (k['fct2'] if k['base'] == 'Len' else 1)),
                            'matched': k['matched']})
        else:
            out.append({'itemId': l['itemId'], 'description': l['description'], 'base': l['base'],
                        'fct1': l['fct1'], 'fct2': l['fct2'], 'matched': l.get('matched', True) is not False})
    return out


def is_active_asm(a):
    return bool(a and not a.get('retired') and (a.get('name') or '').strip())


# itemIds referenced by ACTIVE assemblies -- kept in the field even if retired.
used_iids = set()
for a in asm.get('assemblies', []):
    if not is_active_asm(a):
        continue
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

# ── assemblies: active only, bake group, WITH flat[] (for old cached PWA code) ─
active = []
for a in asm.get('assemblies', []):
    if not is_active_asm(a):
        continue
    b = dict(a)
    if not b.get('group'):
        b['group'] = b.get('category') or ''
    if any(l.get('ref') for l in b.get('lines', [])):
        b['flat'] = flatten_asm(b, set([b['id']]))
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
print('assembl active:', len(active), '(from', len(asm.get('assemblies', [])), 'master) -- WITH flat[]')
print('groups:', len(groups))
for n, p in (('items.json', os.path.join(OUT_DIR, 'items.json')),
             ('assemblies.json', os.path.join(OUT_DIR, 'assemblies.json'))):
    print('%-16s %6.1f KB' % (n, os.path.getsize(p) / 1024))
