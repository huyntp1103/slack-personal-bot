'use strict';

/**
 * Fetches a GitHub PR title given its URL.
 * Parses owner/repo/number from the URL and calls the GitHub REST API.
 *
 * @param {string} prUrl - e.g. https://github.com/Everfit-io/everfit-api/pull/16391
 * @returns {Promise<string|null>} PR title or null on failure
 */
async function fetchPrTitle(prUrl) {
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
      console.error(`[GitHub] fetchPrTitle failed: ${res.status} ${res.statusText}`);
      return null;
    }

    const data = await res.json();
    return data.title ?? null;
  } catch (err) {
    console.error('[GitHub] fetchPrTitle error:', err.message);
    return null;
  }
}

module.exports = { fetchPrTitle };
