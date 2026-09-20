import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { findArtistCandidateById } from '../lib/rank.mjs';

const cli = path.resolve(import.meta.dirname, '../music2wy.mjs');

function candidate(songid, name, artist, album = '') {
  return {
    platform: 'kuwo', songid, name, artist, album, duration: 240,
    minfo: [{ format: 'flac', bitrate: '2000', size: '30Mb' }],
  };
}

test('artist search shows matching songs and collaborations without title-search scores', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'music2wy-artist-test-'));
  try {
    const artist = '麻园诗人';
    const key = `artist:kuwo:${artist}:2`;
    const cacheFile = path.join(home, 'cache', 'search', `${crypto.createHash('sha1').update(key).digest('hex')}.json`);
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({
      cachedAt: Date.now(), meta: {},
      value: {
        total: 43,
        list: [
          candidate('collab', '榻榻米', '麻园诗人&万妮达'),
          candidate('other', '麻园诗人的歌', '另一位歌手'),
          candidate('solo-a', '昆明', '麻园诗人', '昆明'),
          candidate('solo-b', '黑白色 (Live)', '麻园诗人', '现场专辑'),
        ],
      },
    }));

    const env = { ...process.env, MUSIC2WY_HOME: home, NE_COOKIE: '' };
    const search = spawnSync(process.execPath, [cli, 'artist', artist, '--page', '2'], {
      env, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(search.status, 0, search.stderr);
    const result = JSON.parse(search.stdout);
    assert.equal(result.ok, true);
    assert.equal(result.mode, 'artist');
    assert.equal(result.artist, artist);
    assert.equal(result.page, 2);
    assert.equal(result.total, 43);
    assert.equal(result.candidateCount, 3);
    assert.equal(result.hasMore, true);
    assert.deepEqual(result.candidates.map((c) => c.songid), ['solo-a', 'solo-b', 'collab']);
    assert.ok(result.candidates.every((c) => c.recommended === false && c.score == null));

    const session = JSON.parse(fs.readFileSync(path.join(home, 'last-search.json'), 'utf8'));
    assert.equal(session.mode, 'artist');
    assert.equal(session.page, 2);
    assert.deepEqual(session.candidates.map((c) => c.songid), ['solo-a', 'solo-b', 'collab']);

    const show = spawnSync(process.execPath, [cli, 'show'], { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(show.status, 0, show.stderr);
    const shown = JSON.parse(show.stdout);
    assert.equal(shown.mode, 'artist');
    assert.equal(shown.page, 2);
    assert.deepEqual(shown.candidates.map((c) => c.name), ['昆明', '黑白色 (Live)', '榻榻米']);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('refreshed artist page keeps the selected song when page order changes', () => {
  const refreshed = [
    candidate('new-first', '另一首', '麻园诗人'),
    candidate('selected', '昆明', '麻园诗人'),
  ];
  assert.equal(findArtistCandidateById(refreshed, 'selected')?.name, '昆明');
  assert.equal(findArtistCandidateById(refreshed, 'missing'), null);
});

test('artist search reuses a recent same-keyword search instead of contacting the site again', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'music2wy-artist-cache-test-'));
  try {
    const artist = '麻园诗人';
    const key = `kuwo:${artist}`;
    const cacheFile = path.join(home, 'cache', 'search', `${crypto.createHash('sha1').update(key).digest('hex')}.json`);
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({
      cachedAt: Date.now(), meta: {},
      value: { total: 1, list: [candidate('known', '昆明', artist)] },
    }));
    const preload = path.join(home, 'deny-network.mjs');
    fs.writeFileSync(preload, 'globalThis.fetch = () => { throw new Error("unexpected network request"); };');
    const env = { ...process.env, MUSIC2WY_HOME: home,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import ${preload}`.trim() };
    const run = spawnSync(process.execPath, [cli, 'artist', artist], {
      env, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout);
    assert.equal(result.fromCache, true);
    assert.deepEqual(result.candidates.map((c) => c.songid), ['known']);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
