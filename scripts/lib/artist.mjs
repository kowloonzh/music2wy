// 歌手搜索会话的直链刷新：同一页、同一 songid，绝不按旧序号替换歌曲。
import { findArtistCandidateById, pickVariant, rankArtistCandidates } from './rank.mjs';

export async function refreshArtistUrl({ session, candidate, quality, search, resolve }) {
  const platform = session.platform || 'kuwo';
  const query = session.siteQuery || session.artist || session.query;
  const result = await search(query, {
    platform, page: session.page || 1, size: session.size || 20, allowCache: false,
  });
  const ranked = rankArtistCandidates(result.list || [], session.artist || session.query);
  const fresh = findArtistCandidateById(ranked, candidate.songid);
  if (!fresh) throw new Error('原候选已不在刷新后的歌手搜索页中；请重新运行 artist 并选择编号，避免下错歌');
  const variant = pickVariant(fresh, quality);
  if (!variant) throw new Error('刷新后的候选没有可用音质');
  const info = await resolve({
    platform: fresh.platform || platform, songid: fresh.songid,
    time: fresh.time, sign: fresh.sign,
    format: variant.format, bitrate: variant.bitrate,
  });
  if (!info?.url) throw new Error('刷新歌手搜索页后，站点仍没有返回直链');
  return { info, candidate: fresh };
}
