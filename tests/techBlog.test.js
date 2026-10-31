'use strict';

const path = require('path');
const { EventEmitter } = require('events');

jest.mock('child_process', () => ({ spawn: jest.fn() }));
jest.mock('fs', () => ({ existsSync: jest.fn() }));

const { spawn } = require('child_process');
const fs = require('fs');
const {
  runTechBlogScan,
  runReadTechBlog,
  readTechBlogSkipReason,
  extractScanResult,
  buildScanPrompt,
  previousUtcDay,
  msUntilNextRun,
  startTechBlogScheduler,
  parseFeed,
  fetchFeedCandidates,
  collectFeedCandidates,
  dayWindow,
  FEEDS,
  PAGE_SOURCES,
} = require('../src/techBlog');

const REPO_ROOT = '/Users/me/Everfit';
const REPO = path.join(REPO_ROOT, 'everfit-api');
const SKILL = path.join(REPO, '.claude', 'skills', 'read-tech-blog', 'SKILL.md');

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  return child;
}

function finishWith({ stdout = '', stderr = '', code = 0 }) {
  const child = fakeChild();
  spawn.mockReturnValueOnce(child);
  setImmediate(() => {
    child.stdout.emit('data', stdout);
    child.stderr.emit('data', stderr);
    child.emit('close', code);
  });
}

const block = json => `chatter\nTECH_BLOG_JSON_START\n${JSON.stringify(json)}\nTECH_BLOG_JSON_END`;
const pick = (n, extra = {}) => ({ title: `T${n}`, url: `https://x.com/${n}`, source: 'S', summary: `sum ${n}`, ...extra });

beforeEach(() => {
  jest.resetAllMocks();
  process.env.REVIEW_REPO_ROOT = REPO_ROOT;
  delete process.env.TECH_BLOG_MODEL;
  fs.existsSync.mockImplementation(p => p === path.join(REPO, '.git') || p === SKILL);
  // Every feed fails unless a test says otherwise.
  global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 });
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  delete global.fetch;
  console.log.mockRestore?.();
});

const rssItem = (title, link, date, extra = '') => `<item><title>${title}</title><link>${link}</link><pubDate>${date}</pubDate>${extra}</item>`;
const rss = (...items) => `<?xml version="1.0"?><rss><channel>${items.join('')}</channel></rss>`;
const okXml = body => ({ ok: true, status: 200, text: async () => body });
const WINDOW = dayWindow('2026-10-30');

describe('previousUtcDay / msUntilNextRun', () => {
  test('the UTC day before now', () => {
    expect(previousUtcDay(new Date('2026-11-01T00:00:00Z'))).toBe('2026-10-31');
    expect(previousUtcDay(new Date('2026-01-01T00:30:00Z'))).toBe('2025-12-31');
  });

  test('time until the next 00:00 UTC (07:00 UTC+7)', () => {
    expect(msUntilNextRun(new Date('2026-10-31T17:00:00Z'))).toBe(7 * 3600 * 1000);
    expect(msUntilNextRun(new Date('2026-10-31T00:00:00Z'))).toBe(24 * 3600 * 1000);
  });
});

describe('buildScanPrompt', () => {
  test('carries the UTC window, the candidates, the feedless sources and the output markers', () => {
    const date = new Date('2026-10-30T09:30:00Z');
    const prompt = buildScanPrompt('2026-10-30', [
      { source: 'OpenAI News', title: 'Hello', url: 'https://o.ai/hello', date, excerpt: 'About hello' },
      { source: 'Netflix TechBlog', title: 'No excerpt', url: 'https://n.com/x', date, excerpt: '' },
    ]);
    expect(prompt).toContain('2026-10-30T00:00:00Z and 2026-10-30T23:59:59Z');
    expect(prompt).toContain('2 post(s)');
    expect(prompt).toContain('- [OpenAI News] Hello — https://o.ai/hello (2026-10-30T09:30:00.000Z) — About hello');
    expect(prompt).toContain('- [Netflix TechBlog] No excerpt — https://n.com/x (2026-10-30T09:30:00.000Z)\n');
    for (const s of PAGE_SOURCES) expect(prompt).toContain(`- ${s.name}: ${s.url}`);
    for (const f of FEEDS) expect(prompt).not.toContain(f.url);
    expect(prompt).toContain('TECH_BLOG_JSON_START');
    expect(prompt).toContain('TECH_BLOG_JSON_END');
  });

  test('no candidates is stated, not omitted', () => {
    expect(buildScanPrompt('2026-10-30', [])).toContain('0 post(s):\n- (none)');
  });
});

describe('parseFeed', () => {
  test('RSS: CDATA, entities, utm params and markup in the excerpt', () => {
    const items = parseFeed(rss(
      rssItem('<![CDATA[Fish &amp; Chips]]>', 'https://x.com/a?utm_source=rss&amp;id=1&ref=feed', 'Fri, 30 Oct 2026 09:30:00 GMT',
        '<description>&lt;p&gt;Hello &lt;b&gt;world&lt;/b&gt; &amp;amp; more&lt;/p&gt;</description>'),
      rssItem('Cdata body', '<![CDATA[https://x.com/b]]>', 'Fri, 30 Oct 2026 10:00:00 GMT',
        '<content:encoded><![CDATA[<p>Rich <i>text</i></p>]]></content:encoded>'),
    ));
    expect(items).toEqual([
      { title: 'Fish & Chips', url: 'https://x.com/a?id=1', date: new Date('2026-10-30T09:30:00Z'), excerpt: 'Hello world & more' },
      { title: 'Cdata body', url: 'https://x.com/b', date: new Date('2026-10-30T10:00:00Z'), excerpt: 'Rich text' },
    ]);
  });

  test('Atom: href links (alternate preferred), published/updated dates, summary', () => {
    const items = parseFeed(`<feed>
      <entry><title>One</title><link rel="self" href="https://x.com/self"/><link rel="alternate" href="https://x.com/one"/>
        <published>2026-10-30T01:02:03Z</published><summary>Sum</summary></entry>
      <entry><title>Two</title><link href="https://x.com/two"/><updated>2026-10-30T05:00:00+07:00</updated></entry>
    </feed>`);
    expect(items.map(i => [i.title, i.url, i.date.toISOString(), i.excerpt])).toEqual([
      ['One', 'https://x.com/one', '2026-10-30T01:02:03.000Z', 'Sum'],
      ['Two', 'https://x.com/two', '2026-10-29T22:00:00.000Z', ''],
    ]);
  });

  test('dc:date works; items missing title, link or a valid date are dropped; excerpt is capped', () => {
    const items = parseFeed(`<rss><channel>
      <item><title>Dc</title><link>https://x.com/dc</link><dc:date>2026-10-30T00:00:00Z</dc:date><description>${'a'.repeat(500)}</description></item>
      <item><title>No date</title><link>https://x.com/nd</link></item>
      <item><title>Bad date</title><link>https://x.com/bd</link><pubDate>soon</pubDate></item>
      <item><link>https://x.com/nt</link><pubDate>Fri, 30 Oct 2026 09:30:00 GMT</pubDate></item>
      <item><title>Bad link</title><link>not a url</link><pubDate>Fri, 30 Oct 2026 09:30:00 GMT</pubDate></item>
    </channel></rss>`);
    expect(items.map(i => i.title)).toEqual(['Dc']);
    expect(items[0].excerpt).toHaveLength(300);
  });

  test('empty or non-feed input gives no items', () => {
    expect(parseFeed('')).toEqual([]);
    expect(parseFeed(undefined)).toEqual([]);
    expect(parseFeed('<html>nope</html>')).toEqual([]);
  });
});

describe('dayWindow', () => {
  test('[00:00:00Z, next 00:00:00Z)', () => {
    expect(dayWindow('2026-10-30')).toEqual({ start: Date.UTC(2026, 9, 30), end: Date.UTC(2026, 9, 31) });
  });
});

describe('fetchFeedCandidates', () => {
  const feed = { name: 'F', url: 'https://f.com/feed' };

  test('keeps only posts inside the window (start inclusive, end exclusive)', async () => {
    global.fetch.mockResolvedValue(okXml(rss(
      rssItem('before', 'https://f.com/1', 'Thu, 29 Oct 2026 23:59:59 GMT'),
      rssItem('start', 'https://f.com/2', 'Fri, 30 Oct 2026 00:00:00 GMT'),
      rssItem('last', 'https://f.com/3', 'Fri, 30 Oct 2026 23:59:59 GMT'),
      rssItem('after', 'https://f.com/4', 'Sat, 31 Oct 2026 00:00:00 GMT'),
    )));
    const res = await fetchFeedCandidates(feed, WINDOW);
    expect(res.status).toBe('ok');
    expect(res.items.map(i => [i.title, i.source])).toEqual([['start', 'F'], ['last', 'F']]);
    expect(global.fetch).toHaveBeenCalledWith('https://f.com/feed', expect.objectContaining({ signal: expect.anything() }));
  });

  test('a feed with nothing in the window is "none"', async () => {
    global.fetch.mockResolvedValue(okXml(rss(rssItem('old', 'https://f.com/1', 'Mon, 05 Oct 2026 09:30:00 GMT'))));
    expect(await fetchFeedCandidates(feed, WINDOW)).toEqual({ source: 'F', status: 'none', items: [] });
  });

  test('HTTP errors, unparseable bodies and network errors are "failed", never thrown', async () => {
    global.fetch.mockResolvedValueOnce({ ok: false, status: 406 });
    expect(await fetchFeedCandidates(feed, WINDOW)).toMatchObject({ status: 'failed', error: 'HTTP 406', items: [] });

    global.fetch.mockResolvedValueOnce(okXml('<html>captcha</html>'));
    expect(await fetchFeedCandidates(feed, WINDOW)).toMatchObject({ status: 'failed', error: 'no dated items in the feed' });

    global.fetch.mockRejectedValueOnce(new Error('ETIMEDOUT'));
    expect(await fetchFeedCandidates(feed, WINDOW)).toMatchObject({ status: 'failed', error: 'ETIMEDOUT' });
  });
});

describe('collectFeedCandidates', () => {
  test('fetches every feed and reports each one\'s status', async () => {
    global.fetch.mockImplementation(async url => {
      if (url === FEEDS[0].url) return okXml(rss(rssItem('hit', 'https://a.com/1', 'Fri, 30 Oct 2026 09:30:00 GMT')));
      if (url === FEEDS[1].url) return okXml(rss(rssItem('old', 'https://a.com/2', 'Mon, 05 Oct 2026 09:30:00 GMT')));
      return { ok: false, status: 500 };
    });
    const { candidates, checked } = await collectFeedCandidates('2026-10-30');

    expect(global.fetch).toHaveBeenCalledTimes(FEEDS.length);
    expect(candidates.map(c => [c.source, c.title])).toEqual([[FEEDS[0].name, 'hit']]);
    expect(checked).toHaveLength(FEEDS.length);
    expect(checked.slice(0, 3)).toEqual([
      { source: FEEDS[0].name, status: 'ok' },
      { source: FEEDS[1].name, status: 'none' },
      { source: FEEDS[2].name, status: 'failed' },
    ]);
  });
});

describe('extractScanResult', () => {
  test('parses both lists', () => {
    expect(extractScanResult(block({ ai: [pick(1)], other: [pick(2)] }))).toEqual({ ai: [pick(1)], other: [pick(2)], checked: [] });
  });

  test('caps each list at 3, drops invalid picks and dedupes urls across lists', () => {
    const out = extractScanResult(block({
      ai: [pick(1), pick(2), { title: 'no url' }, pick(3, { url: 'ftp://x' }), pick(4), pick(5)],
      other: [pick(1), pick(6)],
    }));
    expect(out.ai.map(p => p.url)).toEqual(['https://x.com/1', 'https://x.com/2', 'https://x.com/4']);
    expect(out.other.map(p => p.url)).toEqual(['https://x.com/6']);
  });

  test('keeps well-formed per-source coverage and drops the rest', () => {
    const out = extractScanResult(block({
      ai: [],
      checked: [{ source: 'A', status: 'ok' }, { source: 'B', status: 'weird' }, { status: 'ok' }, { source: 'C', status: 'failed' }],
    }));
    expect(out.checked).toEqual([{ source: 'A', status: 'ok' }, { source: 'C', status: 'failed' }]);
  });

  test('truncates a runaway summary', () => {
    const out = extractScanResult(block({ ai: [pick(1, { summary: 'a'.repeat(700) })], other: [] }));
    expect(out.ai[0].summary).toBe(`${'a'.repeat(600)}…`);
  });

  test('tolerates fenced json and decorated markers', () => {
    const out = extractScanResult(`*TECH_BLOG_JSON_START*\n\`\`\`json\n${JSON.stringify({ ai: [pick(1)] })}\n\`\`\`\n*TECH_BLOG_JSON_END*`);
    expect(out).toEqual({ ai: [pick(1)], other: [], checked: [] });
  });

  test('null without a block or with invalid json', () => {
    expect(extractScanResult('nothing')).toBeNull();
    expect(extractScanResult(undefined)).toBeNull();
    expect(extractScanResult('TECH_BLOG_JSON_START\n{oops\nTECH_BLOG_JSON_END')).toBeNull();
  });
});

describe('runTechBlogScan', () => {
  test('spawns claude with the prompt and the default model', async () => {
    finishWith({ stdout: block({ ai: [pick(1)], other: [] }) });
    const res = await runTechBlogScan('2026-10-30');

    expect(res.ok).toBe(true);
    expect(res.result.ai).toEqual([pick(1)]);
    const [, args, opts] = spawn.mock.calls[0];
    expect(args.slice(0, 2)).toEqual(['-p', buildScanPrompt('2026-10-30', [])]);
    expect(args.slice(-2)).toEqual(['--model', 'claude-sonnet-5-5']);
    expect(opts.stdio).toEqual(['ignore', 'pipe', 'pipe']);
  });

  test('feed candidates go into the prompt and feed statuses come from code, not the model', async () => {
    global.fetch.mockImplementation(async url => (url === FEEDS[0].url
      ? okXml(rss(rssItem('Fed post', 'https://a.com/1', 'Fri, 30 Oct 2026 09:30:00 GMT')))
      : { ok: false, status: 500 }));
    finishWith({ stdout: block({
      ai: [pick(1)],
      checked: [
        { source: FEEDS[0].name, status: 'failed' }, // the model must not override a code-verified source
        { source: PAGE_SOURCES[0].name, status: 'none' },
      ],
    }) });
    const res = await runTechBlogScan('2026-10-30');

    expect(spawn.mock.calls[0][1][1]).toContain(`- [${FEEDS[0].name}] Fed post — https://a.com/1 (2026-10-30T09:30:00.000Z)`);
    expect(res.result.checked.filter(c => c.source === FEEDS[0].name)).toEqual([{ source: FEEDS[0].name, status: 'ok' }]);
    expect(res.result.checked.at(-1)).toEqual({ source: PAGE_SOURCES[0].name, status: 'none' });
    expect(res.result.checked).toHaveLength(FEEDS.length + 1);
  });

  test('TECH_BLOG_MODEL and an explicit model override the default', async () => {
    process.env.TECH_BLOG_MODEL = 'claude-haiku-5-5';
    finishWith({ stdout: block({ ai: [] }) });
    await runTechBlogScan('2026-10-30');
    expect(spawn.mock.calls[0][1].slice(-2)).toEqual(['--model', 'claude-haiku-5-5']);

    finishWith({ stdout: block({ ai: [] }) });
    await runTechBlogScan('2026-10-30', { model: 'm' });
    expect(spawn.mock.calls[1][1].slice(-2)).toEqual(['--model', 'm']);
  });

  test('a non-zero exit after the result block is still a success', async () => {
    finishWith({ stdout: block({ ai: [pick(1)] }), code: 1 });
    expect((await runTechBlogScan('2026-10-30')).ok).toBe(true);
  });

  test('a non-zero exit without a result is a failure with the stderr tail', async () => {
    finishWith({ stderr: 'Not logged in', code: 1 });
    expect(await runTechBlogScan('2026-10-30')).toEqual({ ok: false, error: 'claude exited 1: Not logged in' });
  });

  test('a clean exit without a result block is a failure', async () => {
    finishWith({ stdout: 'no markers' });
    expect(await runTechBlogScan('2026-10-30')).toEqual({ ok: false, error: 'the scan finished without a parseable result block' });
  });

  test('spawn errors are reported, not thrown', async () => {
    spawn.mockImplementationOnce(() => { throw new Error('ENOENT'); });
    expect(await runTechBlogScan('2026-10-30')).toEqual({ ok: false, error: 'ENOENT' });

    const child = fakeChild();
    spawn.mockReturnValueOnce(child);
    setImmediate(() => child.emit('error', new Error('spawn claude ENOENT')));
    expect(await runTechBlogScan('2026-10-30')).toEqual({ ok: false, error: 'spawn claude ENOENT' });
  });

  test('a timeout kills the run', async () => {
    jest.useFakeTimers();
    try {
      process.env.REVIEW_TIMEOUT_MINUTES = '1';
      const child = fakeChild();
      spawn.mockReturnValueOnce(child);
      const p = runTechBlogScan('2026-10-30');
      await jest.advanceTimersByTimeAsync(0); // let the feed fetches settle so claude is spawned
      await jest.advanceTimersByTimeAsync(60 * 1000);
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      child.emit('close', null);
      expect(await p).toEqual({ ok: false, error: 'timed out after 1 min' });
    } finally {
      jest.useRealTimers();
      delete process.env.REVIEW_TIMEOUT_MINUTES;
    }
  });
});

describe('runReadTechBlog', () => {
  test('runs /read-tech-blog in the everfit-api clone', async () => {
    finishWith({ stdout: 'Saved to ai-agents-output/tech-blogs/x\n' });
    const res = await runReadTechBlog('https://x.com/1');

    expect(res).toEqual({ ok: true, output: 'Saved to ai-agents-output/tech-blogs/x' });
    const [, args, opts] = spawn.mock.calls[0];
    expect(args.slice(0, 2)).toEqual(['-p', '/read-tech-blog https://x.com/1']);
    expect(opts.cwd).toBe(REPO);
  });

  test('a NOT_SAVED marker is a failure even on a clean exit, with its reason', async () => {
    finishWith({ stdout: 'InfoQ blocks bots.\nREAD_TECH_BLOG_RESULT=NOT_SAVED: blocked by a CAPTCHA\n' });
    expect(await runReadTechBlog('https://x.com/1')).toEqual({ ok: false, notSaved: true, error: 'blocked by a CAPTCHA' });
  });

  test('a SAVED marker is a success and is stripped from the output', async () => {
    finishWith({ stdout: 'Saved to ai-agents-output/tech-blogs/x\n**READ_TECH_BLOG_RESULT=SAVED**\n' });
    expect(await runReadTechBlog('https://x.com/1')).toEqual({ ok: true, output: 'Saved to ai-agents-output/tech-blogs/x' });
  });

  test('NOT_SAVED without a reason falls back to the status text', async () => {
    finishWith({ stdout: 'Already in the catalog (Read).\nREAD_TECH_BLOG_RESULT=NOT_SAVED' });
    expect(await runReadTechBlog('https://x.com/1')).toEqual({ ok: false, notSaved: true, error: 'Already in the catalog (Read).' });
  });

  test('without a marker, a status saying nothing was saved is still not a save', async () => {
    finishWith({ stdout: 'Nothing was saved. The site is paywalled.' });
    expect(await runReadTechBlog('https://x.com/1')).toEqual({ ok: false, notSaved: true, error: 'Nothing was saved. The site is paywalled.' });
  });

  test('an explicit SAVED marker wins over words like "blocked" in the status text', async () => {
    finishWith({ stdout: 'Saved. One image was blocked and skipped.\nREAD_TECH_BLOG_RESULT=SAVED' });
    expect((await runReadTechBlog('https://x.com/1')).ok).toBe(true);
  });

  test('the headless policy asks for the marker', async () => {
    finishWith({ stdout: 'ok' });
    await runReadTechBlog('https://x.com/1');
    const args = spawn.mock.calls[0][1];
    expect(args[args.indexOf('--append-system-prompt') + 1]).toContain('READ_TECH_BLOG_RESULT=NOT_SAVED');
  });

  test('skips when the clone or the skill is missing', async () => {
    fs.existsSync.mockReturnValue(false);
    const res = await runReadTechBlog('https://x.com/1');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('no local clone for "everfit-api"');
    expect(spawn).not.toHaveBeenCalled();

    fs.existsSync.mockImplementation(p => p === path.join(REPO, '.git'));
    expect(readTechBlogSkipReason()).toBe(`read-tech-blog skill not found at ${SKILL}`);
  });

  test('a failing run with no output reports the error; spawn errors too', async () => {
    finishWith({ stderr: 'bad', code: 2 });
    expect(await runReadTechBlog('https://x.com/1')).toEqual({ ok: false, error: 'claude exited 2: bad' });

    spawn.mockImplementationOnce(() => { throw new Error('ENOENT'); });
    expect(await runReadTechBlog('https://x.com/1')).toEqual({ ok: false, error: 'ENOENT' });
  });

  test('a non-zero exit that still printed a status is a success', async () => {
    finishWith({ stdout: 'Saved to ai-agents-output/tech-blogs/x', code: 1 });
    expect(await runReadTechBlog('https://x.com/1')).toEqual({ ok: true, output: 'Saved to ai-agents-output/tech-blogs/x' });
  });
});

describe('startTechBlogScheduler', () => {
  afterEach(() => jest.useRealTimers());

  test('fires at the next 00:00 UTC, then again a day later; a throw does not stop it', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-31T17:00:00Z') });
    const tick = jest.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue();
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const sched = startTechBlogScheduler(tick);

    await jest.advanceTimersByTimeAsync(7 * 3600 * 1000 - 1);
    expect(tick).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalledWith('[TechBlog] scheduled scan failed:', 'x');
    await jest.advanceTimersByTimeAsync(24 * 3600 * 1000);
    expect(tick).toHaveBeenCalledTimes(2);

    sched.stop();
    await jest.advanceTimersByTimeAsync(48 * 3600 * 1000);
    expect(tick).toHaveBeenCalledTimes(2);
    err.mockRestore();
  });
});
