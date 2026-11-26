import {CONTINUOUS_USES} from './activity-duration.mjs';
// Keep furniture as data, not hundreds of model tool schemas. Deterministic pages
// preserve the entire accessible catalog; no popularity/AI ranking hides entries.
export function discover(resident, custom = [], args = {}) {
  const offset = integer(args.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = integer(args.limit, 20, 1, 50);
  const query = String(args.query || '').trim().toLocaleLowerCase();
  const space = String(args.space || '');
  const spaces = [...resident.spaces.values()];
  const rows = [...resident.objects.values(), ...custom.map(o => ({
    ...o, space: spaces.find(s => s.scene === o.scene)?.id || o.space || '',
    bridge: o.uses?.length ? 'supported' : 'decoration',
  }))];
  const matches = rows.filter(o => {
    const room = resident.spaces.get(o.space);
    if (room?.owner && room.owner !== 'resident:' + resident.key && !resident.visits?.has(o.space)) return false;
    if (space && o.space !== space && o.space !== 'any') return false;
    if (args.object && o.id !== args.object) return false;
    return !query || [o.id, o.name, o.description, room?.fullName,
      ...(o.uses || []).flatMap(u => [u.id, u.label, u.description])]
      .filter(Boolean).join(' ').toLocaleLowerCase().includes(query);
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return {
    ok: true, actor: resident.key, total: matches.length, offset, limit,
    nextOffset: offset + limit < matches.length ? offset + limit : null,
    objects: matches.slice(offset, offset + limit).map(o => ({
      id: o.id, name: o.name, space: o.space, description: o.description,
      supported: o.bridge === 'supported',
      uses: (o.uses || []).map(u => ({id: u.id, label: u.label,
        ...(CONTINUOUS_USES.has(u.id)?{durationSeconds:[0,3600],zeroMeansHold:true,canFinishEarly:true}:{}),
        ...(u.mode ? {mode: u.mode} : {}),
        ...(u.shelf ? {buys: resident.catalog.products.filter(p => p.shelf === u.shelf).map(p => ({id: p.id, name: p.name}))} : {}),
      })),
    })),
    hint: '使用返回的 id 调用 cabin_use；未找到时换关键词或清空 query 翻页。装饰无动作；下棋用 play 或 play_gomoku，电玩城电脑对手 mode=npc，住户开桌 duo、加入 join。',
  };
}

function integer(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw Error('分页参数必须为有效整数，limit 为 1–50，offset 不小于 0');
  return n;
}
