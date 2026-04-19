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
      console.error(`[GitHub] fetchPrData failed: ${res.status} ${res.statusText}`);
      return null;
    }

    const data = await res.json();
    return {
      title: data.title ?? null,
      baseBranch: data.base?.ref ?? null,
    };
  } catch (err) {
    console.error('[GitHub] fetchPrData error:', err.message);
    return null;
  }
}

// Keep backward-compatible export used in handleReviewMessage
async function fetchPrTitle(prUrl) {
  const pr = await fetchPrData(prUrl);
  return pr?.title ?? null;
}

module.exports = { fetchPrData, fetchPrTitle };
