#!/usr/bin/env python3
"""One-click field-catalog publish from the grouping tool's Downloads exports.

The grouping tool's "Publish to field" button now exports the FINAL field files
directly:  items.json  +  assemblies.json  (active-only, de-duped, kit-flattened).
So there is NO transform step anymore -- this script just grabs the newest pair
from Downloads, drops them straight into ./catalog/, shows the diff, and
(optionally) commits + pushes to deploy.

(publish-catalog.py is kept only as a fallback for the old master-file flow.)

Usage:
  py tools/publish-from-downloads.py [--push] [--no-git] [--force] [--downloads DIR]
    --push        commit + push without asking (deploy immediately)
    --no-git      just update catalog/ locally; don't stage/commit/push
    --force       publish even if the Downloads export is OLDER than what's deployed
    --downloads   look in DIR instead of the auto-detected Downloads folder(s)
"""
import json, os, sys, glob, shutil, subprocess, datetime

ROOT    = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, 'catalog')

ARGS      = sys.argv[1:]
FORCE     = '--force'  in ARGS
NO_GIT    = '--no-git' in ARGS
AUTO_PUSH = '--push'   in ARGS

def arg_val(name, default=None):
    if name in ARGS:
        i = ARGS.index(name)
        if i + 1 < len(ARGS):
            return ARGS[i + 1]
    return default

def fail(msg):
    print('  [x]', msg)
    print('\nAborted -- nothing changed.')
    sys.exit(1)

def fmt_ts(iso):
    if not iso:
        return '?'
    try:
        return datetime.datetime.fromisoformat(iso.replace('Z', '+00:00')).astimezone().strftime('%Y-%m-%d %H:%M')
    except Exception:
        return iso

def downloads_dirs():
    override = arg_val('--downloads')
    if override:
        return [override] if os.path.isdir(override) else []
    home  = os.path.expanduser('~')
    cands = [os.path.join(home, 'Downloads')]
    for var in ('OneDrive', 'OneDriveConsumer', 'OneDriveCommercial'):
        od = os.environ.get(var)
        if od:
            cands.append(os.path.join(od, 'Downloads'))
    seen, out = set(), []
    for d in cands:
        if d not in seen and os.path.isdir(d):
            seen.add(d); out.append(d)
    return out

def newest(pattern, dirs):
    hits = []
    for d in dirs:
        hits += glob.glob(os.path.join(d, pattern))
    return max(hits, key=os.path.getmtime) if hits else None

# canon filename -> (glob pattern, expected schema prefix, array key to count).
# Note: globs deliberately DON'T match the master backups (materials-catalog.json,
# master-assemblies.json) so those can't be mistaken for the field files.
EXPECT = {
    'items.json':      ('items*.json',      'field-items', 'items'),
    'assemblies.json': ('assemblies*.json', 'assemblies',  'assemblies'),
}

print('Publishing field catalog ' + '=' * 30)
dirs = downloads_dirs()
if not dirs:
    fail('No Downloads folder found. Pass --downloads DIR.')
print('  Downloads:', dirs[0] if len(dirs) == 1 else dirs)

picked = {}
for canon, (pat, schema_pfx, arrkey) in EXPECT.items():
    p = newest(pat, dirs)
    if not p:
        fail('No %s found in Downloads (looked for %s). Click "Publish to field" in the tool first.' % (canon, pat))
    try:
        with open(p, encoding='utf-8') as f:
            d = json.load(f)
    except Exception as e:
        fail('%s is not valid JSON: %s' % (os.path.basename(p), e))
    sch = str(d.get('schema', ''))
    if not sch.startswith(schema_pfx):
        fail('%s has schema %r (wanted %s/*) -- is this a field export, not a master backup?' % (os.path.basename(p), sch, schema_pfx))
    arr = d.get(arrkey) or []
    if not arr:
        fail('%s has an empty %s list -- refusing to publish an empty catalog.' % (os.path.basename(p), arrkey))
    picked[canon] = {'path': p, 'count': len(arr), 'gen': d.get('generated_at')}
    print('  [ok] %-16s exported %s   (%.1f MB, %s %s)' % (
        os.path.basename(p), fmt_ts(d.get('generated_at')),
        os.path.getsize(p) / 1e6, format(len(arr), ','), arrkey))

# freshness guard: never deploy an export older than what's already live
if not FORCE:
    for canon, info in picked.items():
        cur = os.path.join(OUT_DIR, canon)
        if os.path.exists(cur):
            try:
                curgen = json.load(open(cur, encoding='utf-8')).get('generated_at')
            except Exception:
                curgen = None
            if curgen and info['gen'] and info['gen'] < curgen:
                fail('%s in Downloads (%s) is OLDER than what is deployed (%s). Use --force to override.'
                     % (canon, fmt_ts(info['gen']), fmt_ts(curgen)))

# copy the field files STRAIGHT into catalog/ -- no transform
os.makedirs(OUT_DIR, exist_ok=True)
for canon, info in picked.items():
    shutil.copy2(info['path'], os.path.join(OUT_DIR, canon))
print('\nCopied items.json + assemblies.json straight into catalog\\  (no transform step)')

def git(*a):
    return subprocess.run(['git', *a], cwd=ROOT, capture_output=True, text=True)

diff = git('diff', '--stat', '--', 'catalog/')
print('\nChanges vs deployed (git):')
print(diff.stdout.rstrip() or '  (no changes -- catalog already up to date)')

if NO_GIT:
    print('\n--no-git: updated catalog/ locally, staged nothing. Done.')
    sys.exit(0)
if not diff.stdout.strip():
    print('\nNothing to commit. Done.')
    sys.exit(0)

do = AUTO_PUSH
if not AUTO_PUSH:
    try:
        do = input('\nCommit + push to deploy to the field? [y/N]: ').strip().lower() in ('y', 'yes')
    except EOFError:
        do = False
if not do:
    print('Left changes in catalog/ for you to review. Re-run with --push when ready to deploy.')
    sys.exit(0)

msg = 'Publish field catalog: %s items, %s assemblies (%s)' % (
    picked['items.json']['count'], picked['assemblies.json']['count'], datetime.date.today().isoformat())
if git('add', 'catalog/').returncode != 0:
    fail('git add failed.')
c = git('commit', '-m', msg)
print((c.stdout + c.stderr).rstrip())
if c.returncode != 0:
    fail('git commit failed.')
p = git('push')
print((p.stdout + p.stderr).rstrip())
if p.returncode != 0:
    fail('git push failed -- your commit is saved locally; push manually when ready.')
print('\n[ok] Deployed to the field.')
