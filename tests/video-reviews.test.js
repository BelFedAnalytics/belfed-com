const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseVideoUrl, safeHttpUrl } = require('../belfed-video-reviews.js');

test('parses YouTube watch and short links into privacy-enhanced embeds', () => {
  assert.deepEqual(parseVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), {
    provider: 'youtube',
    embedUrl: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0',
  });
  assert.equal(
    parseVideoUrl('https://youtu.be/dQw4w9WgXcQ?t=10').embedUrl,
    'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0',
  );
});

test('parses Rutube and VK Video links', () => {
  assert.deepEqual(parseVideoUrl('https://rutube.ru/video/abc123/'), {
    provider: 'rutube',
    embedUrl: 'https://rutube.ru/play/embed/abc123/',
  });
  assert.deepEqual(parseVideoUrl('https://vkvideo.ru/video-12345_67890'), {
    provider: 'vk',
    embedUrl: 'https://vk.com/video_ext.php?oid=-12345&id=67890&hd=2',
  });
});

test('accepts only allowlisted explicit embeds and rejects unsafe schemes', () => {
  assert.equal(parseVideoUrl('https://video.example.com/watch/1', 'https://player.example.com/embed/1'), null);
  assert.equal(
    parseVideoUrl('https://youtube.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ').embedUrl,
    'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
  );
  assert.equal(safeHttpUrl('javascript:alert(1)'), '');
  assert.equal(safeHttpUrl('http://youtube.com/watch?v=dQw4w9WgXcQ'), '');
  assert.equal(parseVideoUrl('javascript:alert(1)'), null);
  assert.equal(parseVideoUrl('https://notyoutube.com/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(parseVideoUrl('https://evilrutube.ru/video/abc123/'), null);
  assert.equal(parseVideoUrl('https://evilvk.com/video-12345_67890'), null);
  assert.equal(parseVideoUrl('', 'https://youtube.com/watch?v=dQw4w9WgXcQ'), null);
});

test('admin page uses a valid Supabase anon JWT payload', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'admin-video-reviews.html'), 'utf8');
  const match = html.match(/const SUPABASE_ANON='([^']+)'/);
  assert.ok(match, 'SUPABASE_ANON must be present');
  const payload = JSON.parse(Buffer.from(match[1].split('.')[1], 'base64url').toString('utf8'));
  assert.equal(payload.iss, 'supabase');
  assert.equal(payload.ref, 'obujqvqqmyfcfflhqvud');
  assert.equal(payload.role, 'anon');
});

test('EN catalog and admin use independent publish targets and covers', () => {
  const analytics = fs.readFileSync(path.join(__dirname, '..', 'analytics.html'), 'utf8');
  const admin = fs.readFileSync(path.join(__dirname, '..', 'admin-video-reviews.html'), 'utf8');
  assert.match(analytics, /function videoLocale\(item\) \{\s*return 'en';/);
  assert.match(analytics, /\.rpc\('video_reviews_list', \{ p_lang: 'en' \}\)/);
  for (const field of [
    'publish_to_site_ru',
    'publish_to_telegram_ru',
    'publish_to_site_en',
    'publish_to_telegram_en',
    'thumbnail_file_ru',
    'thumbnail_file_en',
  ]) assert.match(admin, new RegExp(`id="${field}"`));
  assert.match(admin, /p\.status='published'/);
  assert.match(admin, /newReview\(true\)/);
  assert.doesNotMatch(admin, /publish_to_site_en\.checked=true/);
  assert.match(admin, /Сессия администратора истекла; Telegram не обновлён/);
  assert.match(admin, /Telegram недоступен:/);
  assert.match(
    admin,
    /Telegram \$\{lang\.toUpperCase\(\)\} уже имеет историю доставки\. Снять этот флаг нельзя; используйте архив/,
  );
  assert.match(admin, /function makeOperation\(\)/);
  assert.match(admin, /operationId:crypto\.randomUUID\(\)/);
  assert.match(admin, /expected_updated_at:row\.updated_at,operation_id:operationId/);
  assert.match(admin, /\.eq\('updated_at',op\.updatedAt\)/);
  assert.match(admin, /function fillEditor\(row\)/);
  assert.match(admin, /if\(fresh&&!dirtyState\)fillEditor\(fresh\)/);
  const editReviewBody = admin.match(/function editReview\(id\)\{([^}]*)\}/)?.[1] || '';
  assert.doesNotMatch(editReviewBody, /loadList\(/);
  assert.match(admin, /dirtyState=false/);
  assert.match(admin, /fresh&&!dirtyState/);
  assert.match(admin, /На сервере появилась новая версия/);
  assert.match(admin, /onclick="requestNewReview\(\)"/);
  assert.match(admin, /function requestNewReview\(\)\{if\(dirtyState&&!confirm\(/);
  assert.match(admin, /event==='SIGNED_IN'\|\|event==='SIGNED_OUT'/);
  assert.doesNotMatch(admin, /onAuthStateChange\(\(\)=>setTimeout\(checkAdmin/);
  assert.match(admin, /function lockDeliveredTargets\(\)/);
  assert.match(admin, /reconcile_video_review_telegram/);
  assert.match(admin, /telegram_send_started_at_\$\{lang\}/);
  assert.match(admin, /function canReconcile\(lang\)/);
  assert.match(admin, /15\*60\*1000/);
});
