'use strict';

/**
 * Fetches GitHub PR data given its URL.
 *
 * @param {string} prUrl - e.g. https://github.com/Everfit-io/everfit-api/pull/16391
 * @returns {Promise<{title: string, baseBranch: string}|null>}
 */
async function fetchPrData(prUrl) {
  const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) return null;

  const [, owner, repo, number] = match;
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`;

  try {
    const res = await fetch(apiUrl, {
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
      },
    });

    if (!res.ok) {
      console.log(`[GitHub] fetchPrData failed: ${res.status} ${res.statusText}`);
      return null;
    }

    const data = await res.json();
    return {
      title: data.title ?? null,
      baseBranch: data.base?.ref ?? null,
    };
  } catch (err) {
    console.log('[GitHub] fetchPrData error:', err.message);
    return null;
  }
}

// Keep backward-compatible export used in handleReviewMessage
async function fetchPrTitle(prUrl) {
  const pr = await fetchPrData(prUrl);
  return pr?.title ?? null;
}

/**
 * Fetches all commits on a PR.
 *
 * @param {string} prUrl
 * @returns {Promise<Array<{message: string, authorLogin: string|null, committerLogin: string|null}>>}
 */
async function fetchPrCommits(prUrl) {
  const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) return [];

  const [, owner, repo, number] = match;
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${number}/commits?per_page=100`;

  try {
    const res = await fetch(apiUrl, {
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
      },
    });

    if (!res.ok) {
      console.log(`[GitHub] fetchPrCommits failed: ${res.status} ${res.statusText}`);
      return [];
    }

    const data = await res.json();
    return data.map(c => ({
      message: c.commit?.message ?? '',
      authorLogin: c.author?.login ?? null,
      committerLogin: c.committer?.login ?? null,
    }));
  } catch (err) {
    console.log('[GitHub] fetchPrCommits error:', err.message);
    return [];
  }
}

module.exports = { fetchPrData, fetchPrTitle, fetchPrCommits };
