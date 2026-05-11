'use strict';

const { fetchPrData, fetchPrTitle, fetchPrCommits, approvePr } = require('../src/github');

const PR_URL = 'https://github.com/Everfit-io/everfit-api/pull/16391';

beforeEach(() => {
  global.fetch = jest.fn();
});

afterEach(() => {
  jest.resetAllMocks();
});

describe('fetchPrData', () => {
  test('returns title and baseBranch on success', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        title: 'feat(video-workout): UP-69726 update API',
        base: { ref: 'develop' },
      }),
    });

    const result = await fetchPrData(PR_URL);
    expect(result).toEqual({
      title: 'feat(video-workout): UP-69726 update API',
      baseBranch: 'develop',
    });
  });

  test('calls correct GitHub API URL', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ title: 'test', base: { ref: 'main' } }),
    });

    await fetchPrData(PR_URL);

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/Everfit-io/everfit-api/pulls/16391',
      expect.objectContaining({ headers: expect.any(Object) })
    );
  });

  test('returns null for invalid URL', async () => {
    const result = await fetchPrData('https://github.com/not-a-pr');
    expect(result).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('returns null on non-ok HTTP response', async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });
    const result = await fetchPrData(PR_URL);
    expect(result).toBeNull();
  });

  test('returns null on network error', async () => {
    global.fetch.mockRejectedValue(new Error('Network error'));
    const result = await fetchPrData(PR_URL);
    expect(result).toBeNull();
  });
});

describe('fetchPrTitle', () => {
  test('returns just the title', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ title: 'UP-69726 some feature', base: { ref: 'develop' } }),
    });

    const title = await fetchPrTitle(PR_URL);
    expect(title).toBe('UP-69726 some feature');
  });

  test('returns null when fetchPrData fails', async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 403, statusText: 'Forbidden' });
    const title = await fetchPrTitle(PR_URL);
    expect(title).toBeNull();
  });
});

describe('fetchPrCommits', () => {
  test('returns array of {message, authorLogin, committerLogin}', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ([
        { commit: { message: 'feat: UP-1 thing' }, author: { login: 'me' }, committer: { login: 'me' } },
        { commit: { message: 'fix: UP-2 cherry-picked' }, author: { login: 'teammate' }, committer: { login: 'me' } },
      ]),
    });

    const commits = await fetchPrCommits(PR_URL);
    expect(commits).toEqual([
      { message: 'feat: UP-1 thing', authorLogin: 'me', committerLogin: 'me' },
      { message: 'fix: UP-2 cherry-picked', authorLogin: 'teammate', committerLogin: 'me' },
    ]);
  });

  test('handles missing author/committer (returns null logins)', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ([{ commit: { message: 'orphan commit' }, author: null, committer: null }]),
    });

    const commits = await fetchPrCommits(PR_URL);
    expect(commits).toEqual([{ message: 'orphan commit', authorLogin: null, committerLogin: null }]);
  });

  test('returns [] for invalid URL', async () => {
    const commits = await fetchPrCommits('not-a-pr-url');
    expect(commits).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('returns [] on non-ok response', async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });
    const commits = await fetchPrCommits(PR_URL);
    expect(commits).toEqual([]);
  });

  test('returns [] on network error', async () => {
    global.fetch.mockRejectedValue(new Error('boom'));
    const commits = await fetchPrCommits(PR_URL);
    expect(commits).toEqual([]);
  });
});

describe('approvePr', () => {
  test('POSTs an APPROVE review and returns true on 2xx', async () => {
    global.fetch.mockResolvedValue({ ok: true });
    const ok = await approvePr(PR_URL);
    expect(ok).toBe(true);

    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/Everfit-io/everfit-api/pulls/16391/reviews');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ event: 'APPROVE', body: '' });
  });

  test('passes through an optional review body', async () => {
    global.fetch.mockResolvedValue({ ok: true });
    await approvePr(PR_URL, 'LGTM');
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).body).toBe('LGTM');
  });

  test('returns false on non-ok response', async () => {
    global.fetch.mockResolvedValue({
      ok: false,
      status: 422,
      statusText: 'Unprocessable',
      text: async () => '{"message":"Can not approve your own pull request"}',
    });
    expect(await approvePr(PR_URL)).toBe(false);
  });

  test('returns false on network error', async () => {
    global.fetch.mockRejectedValue(new Error('boom'));
    expect(await approvePr(PR_URL)).toBe(false);
  });

  test('returns false (no fetch) for malformed URL', async () => {
    expect(await approvePr('not-a-pr-url')).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
