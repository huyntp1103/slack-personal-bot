'use strict';

const { fetchPrData, fetchPrTitle, fetchPrCommits } = require('../src/github');

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
  test('returns array of {message, authorLogin}', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ([
        { commit: { message: 'feat: UP-1 thing' }, author: { login: 'me' } },
        { commit: { message: 'fix: UP-2 other' }, author: { login: 'teammate' } },
      ]),
    });

    const commits = await fetchPrCommits(PR_URL);
    expect(commits).toEqual([
      { message: 'feat: UP-1 thing', authorLogin: 'me' },
      { message: 'fix: UP-2 other', authorLogin: 'teammate' },
    ]);
  });

  test('handles missing author (returns null login)', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ([{ commit: { message: 'orphan commit' }, author: null }]),
    });

    const commits = await fetchPrCommits(PR_URL);
    expect(commits).toEqual([{ message: 'orphan commit', authorLogin: null }]);
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
