// rank.mjs — 候选打分：用网易云官方元数据做参照，尽量不让你下到 DJ 版/翻唱/伴奏。

export const BAD_WORDS = [
  'dj', '慢摇', 'remix', '混音', '伴奏', '铃声', '彩铃', '清唱', '钢琴版', '吉他版',
  '纯音乐', '八音盒', '童声', '合唱版', '恶搞', '串烧', '车载', '加快版', '慢速版',
  'slowed', 'sped up', 'cover by', '翻自', '模仿', 'live', '现场', '演唱会',
];
// 明显是"同一首歌的不同录音室版本"的关键词，命中不重罚
export const MILD_WORDS = ['新版', '重制', 'remaster', 'acoustic', '不插电', 'demo'];
export const GOOD_WORDS = ['原唱', '原版', '正式版', 'official', 'hi-res', 'hires', '无损', 'flac', 'studio'];

/**
 * @param {object} c 站点候选 {name, artist, album, duration, minfo[]}
 * @param {object|null} ref 网易云参照 {name, artists, album, duration}
 */
export function scoreCandidate(c, ref) {
  const name = (c.name || '').toLowerCase();
  const artist = (c.artist || '').toLowerCase();
  const album = (c.album || '').toLowerCase();
  const low = `${name} ${artist} ${album}`;
  let s = 0;
  const reasons = [];

  if (ref) {
    const rTitle = (ref.name || '').toLowerCase();
    const refArtists = String(ref.artists || '').toLowerCase().split('/').filter(Boolean);

    const artistHit = refArtists.some((a) => a && (artist.includes(a) || a.includes(artist) && artist.length > 1));
    const artistLoose = refArtists.some((a) => a && low.includes(a));
    if (artistHit) { s += 50; reasons.push('歌手精确命中+50'); }
    else if (artistLoose) { s += 26; reasons.push('歌手模糊命中+26'); }
    else { s -= 22; reasons.push('歌手不匹配-22'); }

    const nTitle = stripSuffix(name);
    const nRef = stripSuffix(rTitle);
    if (nTitle && nRef && nTitle === nRef) { s += 34; reasons.push('歌名精确+34'); }
    else if (nRef && (name.includes(nRef) || nRef.includes(name))) { s += 18; reasons.push('歌名包含+18'); }
    else { s -= 12; reasons.push('歌名不符-12'); }

    if (ref.duration) {
      const d = Math.abs((c.duration || 0) - ref.duration);
      if (d <= 5) { s += 10; reasons.push('时长吻合+10'); }
      else if (d <= 15) { s += 4; reasons.push('时长接近+4'); }
      else if (d > 60) { s -= 8; reasons.push('时长偏差大-8'); }
    }
  }

  const bad = BAD_WORDS.filter((w) => low.includes(w));
  const mild = MILD_WORDS.filter((w) => low.includes(w));
  const realBad = bad.filter((w) => !(w === 'live' || w === '现场' || w === '演唱会'));
  if (realBad.length) { s -= 26 * realBad.length; reasons.push(`过滤词(${realBad.join('/')})-${26 * realBad.length}`); }
  const good = GOOD_WORDS.filter((w) => low.includes(w));
  if (good.length) { s += 7 * good.length; reasons.push(`正向词+${7 * good.length}`); }

  const fmts = new Set((c.minfo || []).map((m) => String(m.format || '').toLowerCase()));
  if (fmts.has('flac')) { s += 12; reasons.push('有FLAC+12'); }
  else if ((c.minfo || []).some((m) => String(m.bitrate) === '320')) { s += 6; reasons.push('有320K+6'); }

  const dur = c.duration || 0;
  if (dur >= 150 && dur <= 360) s += 6;
  else if (dur > 600 || (dur > 0 && dur < 60)) { s -= 10; reasons.push('时长异常-10'); }

  return { score: Math.round(s * 10) / 10, reasons, bad: realBad, mild };
}

function stripSuffix(t) {
  return String(t || '')
    .replace(/[（(【\[].*?[)）】\]]/g, '')
    .replace(/-?\s*(原唱|原版|正式版|无损|flac|hi-?res|dj版?|remix|伴奏|live|现场).*$/i, '')
    .replace(/\s+/g, '')
    .trim();
}

export function rankCandidates(cands, ref) {
  const scored = cands.map((c) => {
    const r = scoreCandidate(c, ref);
    return { ...c, _score: r.score, _reasons: r.reasons, _bad: r.bad };
  });
  scored.sort((a, b) => b._score - a._score);
  return scored;
}

/** 在候选的音质列表里挑目标格式。 */
export function pickVariant(cand, quality = 'flac') {
  const mins = cand.minfo || [];
  const want = { flac: ['flac', '2000'], lossless: ['flac', '2000'], '320': ['mp3', '320'], '128': ['mp3', '128'] }[quality]
    || ['flac', '2000'];
  return mins.find((m) => String(m.format).toLowerCase() === want[0] && String(m.bitrate) === want[1])
    || mins.find((m) => String(m.format).toLowerCase() === want[0])
    || mins.find((m) => String(m.bitrate) === '320')
    || mins[0] || null;
}
