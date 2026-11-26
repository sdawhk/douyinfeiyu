// First start of 1.1 (runs once, before the game is launched; does nothing once <data>/features.json exists).
//
// Upgrade from 1.0 (the data folder already has saves or a previous bridge.json):
//   1. backs up <data> (saves, world, layouts…) and the 1.0 layout files to <install>/backups/before-1.1-<time>/
//   2. copies the 1.0 furniture layouts, which 1.0 wrote into the folder ABOVE the install, into <data>/layouts/
//      (1.1 keeps them inside the install: the bridge starts the game with --layout <data>/layouts/home-grid-layout.json).
//      The old files are copied, not moved or deleted.
//   3. writes features.json with every "ask" module OFF (they change the look or the balance, so the 1.0 player keeps
//      the 1.0 version until they choose) and every other module ON.
// Fresh install also keeps optional modules off until the installer explains each choice.
// A receipt goes to <data>/update-receipts/first-run.json. Nothing is deleted.
import fs from 'node:fs'; import path from 'node:path';

const LAYOUTS = ['home', 'park', 'shop', 'arcade', 'restaurant'].map(s => s + '-grid-layout.json');

export function firstRun({ dataDir, installDir, descriptions, now = () => new Date() }) {
  const features = path.join(dataDir, 'features.json');
  if (fs.existsSync(features)) return { skipped: 'features.json exists' };
  const hasFiles = d => fs.existsSync(d) && fs.readdirSync(d).length > 0;
  const upgrade = hasFiles(path.join(dataDir, 'saves')) || fs.existsSync(path.join(dataDir, 'bridge.json')) || hasFiles(path.join(dataDir, 'world'));
  const at = now().toISOString(), out = { upgrade, at };
  const parent = path.dirname(path.resolve(installDir)), layoutsDir = path.join(dataDir, 'layouts');
  const oldLayouts = LAYOUTS.flatMap(f => [f, f + '.bak']).map(f => path.join(parent, f)).filter(f => fs.existsSync(f));
  if (upgrade) {
    const backup = path.join(installDir, 'backups', 'before-1.1-' + at.replace(/[:.]/g, '-'));
    fs.mkdirSync(backup, { recursive: true });
    fs.cpSync(dataDir, path.join(backup, 'data'), { recursive: true, filter: src => !src.includes(path.sep + 'backups' + path.sep) });
    if (oldLayouts.length) { fs.mkdirSync(path.join(backup, 'layouts-1.0'), { recursive: true }); for (const f of oldLayouts) fs.copyFileSync(f, path.join(backup, 'layouts-1.0', path.basename(f))); }
    out.backup = backup;
  }
  // 1.0 layouts -> <data>/layouts (never overwrites a 1.1 layout that is already there)
  out.layoutsCopied = [];
  for (const f of oldLayouts) {
    const dest = path.join(layoutsDir, path.basename(f));
    if (!fs.existsSync(dest)) { fs.mkdirSync(layoutsDir, { recursive: true }); fs.copyFileSync(f, dest); out.layoutsCopied.push(path.basename(f)); }
  }
  const modules = Object.fromEntries(descriptions.modules.map(m => [m.id, m.ask ? false : Boolean(m.default)]));
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(features + '.tmp', JSON.stringify({ version: 1, modules, savedAt: at, firstRun: upgrade ? 'upgrade-from-1.0' : 'fresh' }, null, 2) + '\n');
  fs.renameSync(features + '.tmp', features);
  out.modules = modules;
  fs.mkdirSync(path.join(dataDir, 'update-receipts'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'update-receipts', 'first-run.json'), JSON.stringify(out, null, 2) + '\n');
  return out;
}
