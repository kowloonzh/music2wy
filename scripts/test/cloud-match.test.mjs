import assert from 'node:assert/strict';
import test from 'node:test';
import { cloudMatchSong } from '../lib/upload.mjs';

test('cloud match posts the private and official song IDs and reports the official ID', async () => {
  const calls = [];
  const result = await cloudMatchSong({
    songId: 3439765010,
    adjustSongId: 2032784247,
  }, {
    request: async (url, data) => {
      calls.push({ url, data });
      return {
        status: 200,
        body: {
          code: 200,
          data: true,
          matchData: { matchType: 'matched', simpleSong: { id: 2032784247 } },
        },
      };
    },
  });

  assert.deepEqual(calls, [{
    url: 'https://music.163.com/weapi/cloud/user/song/match',
    data: { songId: 3439765010, adjustSongId: 2032784247 },
  }]);
  assert.equal(result.ok, true);
  assert.equal(result.matched, true);
  assert.equal(result.songId, 2032784247);
  assert.equal(result.privateCloudSongId, 3439765010);
});

test('cloud match skips when the cloud item already uses the official song ID', async () => {
  let called = false;
  const result = await cloudMatchSong({
    songId: 2032784247,
    adjustSongId: 2032784247,
  }, {
    request: async () => {
      called = true;
      return { status: 200, body: {} };
    },
  });

  assert.equal(called, false);
  assert.equal(result.ok, true);
  assert.equal(result.matched, true);
  assert.equal(result.skipped, 'already-matched');
});
