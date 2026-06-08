#!/usr/bin/env python3
"""Validate the published catalog/ files are field-consumable.

Mirrors material-request.js expansion (asmLines -> prefer flat[]; lineQty:
Len -> round(runFt*fct1/fct2), else round(fct1)) and checks every active
assembly produces finite, >=1 quantities with a description. Run after publish.
"""
import json, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CAT = os.path.join(ROOT, 'catalog')


def asm_lines(a):
    flat = a.get('flat')
    return flat if isinstance(flat, list) and flat else (a.get('lines') or [])


def num(v, d):
    try:
        return float(v)
    except (TypeError, ValueError):
        return d


def line_qty(line, run_ft):
    f1, f2 = num(line.get('fct1'), 0), num(line.get('fct2'), 1)
    if line.get('base') == 'Len':
        return max(1, round(run_ft * f1 / (f2 or 1)))
    return max(1, round(f1 or 1))


items = json.load(open(os.path.join(CAT, 'items.json'), encoding='utf-8'))['items']
descs = [it['description'].lower() for it in items]
print('items:', len(items),
      ' | no-unit:', sum(1 for it in items if not it.get('unit')),
      ' | dup-desc:', len(descs) - len(set(descs)),
      ' | with-keywords:', sum(1 for it in items if it.get('keywords')))

asm = json.load(open(os.path.join(CAT, 'assemblies.json'), encoding='utf-8'))
problems, bases, len_count = [], {}, 0
for a in asm['assemblies']:
    nonref = [l for l in asm_lines(a) if not l.get('ref')]
    if not nonref:
        problems.append((a.get('name'), 'no expandable lines')); continue
    if any(l.get('base') == 'Len' for l in nonref):
        len_count += 1
    for l in nonref:
        bases[l.get('base')] = bases.get(l.get('base'), 0) + 1
        if not (l.get('description') or '').strip():
            problems.append((a.get('name'), 'line missing description'))
        q = line_qty(l, 100)
        if not (q == q and q >= 1):
            problems.append((a.get('name'), f'bad qty {q}: {l.get("description")}'))

print('assemblies:', len(asm['assemblies']), ' | base counts:', bases)
print('  run-length-scaled (>=1 Len line):', len_count)
print('  PROBLEMS:', len(problems))
for p in problems[:25]:
    print('    ', p)

print('--- sample: qty at 50ft vs 150ft (first 3 Len assemblies) ---')
shown = 0
for a in asm['assemblies']:
    lines = [l for l in asm_lines(a) if not l.get('ref')]
    if not any(l.get('base') == 'Len' for l in lines):
        continue
    print(' ', a['name'], '|', a.get('group'))
    for l in lines[:6]:
        print('     %-44s %s  50ft=%-4d 150ft=%d' % (
            (l.get('description') or '')[:44], l.get('base'),
            line_qty(l, 50), line_qty(l, 150)))
    shown += 1
    if shown >= 3:
        break
