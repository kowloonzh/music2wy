// tag.mjs — 写元数据/封面/歌词。优先 ffmpeg；没有 ffmpeg 时降级为"只下载不打标"。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function has(bin) {
  return spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).status === 0;
}

export function run(cmd, args, timeout = 300000) {
  const p = spawnSync(cmd, args, { encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 });
  return { code: p.status, stdout: p.stdout || '', stderr: p.stderr || '' };
}

export function probe(file) {
  if (!has('ffprobe')) return null;
  const r = run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,bit_rate,format_name',
    '-show_entries', 'stream=codec_name,sample_rate,channels', '-of', 'json', file]);
  if (r.code !== 0) return null;
  try {
    const j = JSON.parse(r.stdout);
    const st = (j.streams || [])[0] || {};
    return {
      duration: j.format?.duration ? Number(j.format.duration) : null,
      bitRate: j.format?.bit_rate ? Number(j.format.bit_rate) : null,
      formatName: j.format?.format_name,
      codec: st.codec_name,
      sampleRate: st.sample_rate ? Number(st.sample_rate) : null,
      channels: st.channels,
    };
  } catch {
    return null;
  }
}

/**
 * 用 ffmpeg 就地写入 title/artist/album/封面/歌词（流拷贝，不重编码）。
 * @returns {{ok:boolean, error?:string, skipped?:boolean}}
 */
export function writeTags(file, meta, { cover, lyricsFile } = {}) {
  if (!has('ffmpeg')) return { ok: false, skipped: true, error: 'ffmpeg 未安装，跳过元数据写入' };
  const ext = path.extname(file).toLowerCase();
  const tmp = `${file}.tagging${ext}`;
  const args = ['-y', '-loglevel', 'error', '-i', file];
  const coverOk = cover && fs.existsSync(cover);
  if (coverOk) args.push('-i', cover);
  args.push('-map', '0:a');
  if (coverOk) args.push('-map', '1:v', '-c:v', 'copy', '-disposition:v', 'attached_pic');
  args.push('-c:a', 'copy');
  args.push('-metadata', `title=${meta.title ?? ''}`);
  args.push('-metadata', `artist=${meta.artist ?? ''}`);
  args.push('-metadata', `album=${meta.album || '未知专辑'}`);
  if (ext === '.flac') args.push('-metadata', `ALBUMARTIST=${meta.artist ?? ''}`);
  if (lyricsFile && fs.existsSync(lyricsFile)) {
    const lrc = fs.readFileSync(lyricsFile, 'utf8');
    if (lrc.trim()) args.push('-metadata', `lyrics=${lrc}`);
  }
  args.push(tmp);
  const r = run('ffmpeg', args);
  if (r.code !== 0 || !fs.existsSync(tmp)) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
    return { ok: false, error: (r.stderr || '').trim().slice(0, 300) };
  }
  fs.renameSync(tmp, file);
  return { ok: true };
}

/** 从网易云封面地址下载封面到本地。 */
export async function fetchCover(url, outPath) {
  if (!url) return null;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100) return null;
    fs.writeFileSync(outPath, buf);
    return outPath;
  } catch {
    return null;
  }
}
