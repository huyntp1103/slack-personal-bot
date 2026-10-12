'use strict';

const { extractJiraKey, extractAllJiraKeys, extractSlackThread, extractPrUrls } = require('../src/utils');

describe('extractJiraKey', () => {
  test('extracts key from plain commit message', () => {
    expect(extractJiraKey('feat(similar-weight-rep): UP-68162 get max weight')).toBe('UP-68162');
  });

  test('extracts key from PR title with prefix', () => {
    expect(extractJiraKey('feat(video-workout): UP-69726 update API')).toBe('UP-69726');
  });

  test('extracts key from branch name', () => {
    expect(extractJiraKey('dev_s8-26.feat/UP-69726')).toBe('UP-69726');
  });

  test('extracts key when it appears anywhere in the text', () => {
    expect(extractJiraKey('anh review giup em voi https://github.com/org/repo/pull/123 UP-12345')).toBe('UP-12345');
  });

  test('returns null when no key present', () => {
    expect(extractJiraKey('fix some random bug')).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(extractJiraKey('')).toBeNull();
  });

  test('does not match lowercase keys', () => {
    expect(extractJiraKey('up-123 fix')).toBeNull();
  });
});

describe('extractAllJiraKeys', () => {
  test('returns empty array for empty/null input', () => {
    expect(extractAllJiraKeys('')).toEqual([]);
    expect(extractAllJiraKeys(null)).toEqual([]);
    expect(extractAllJiraKeys(undefined)).toEqual([]);
  });

  test('extracts a single key', () => {
    expect(extractAllJiraKeys('check UP-1')).toEqual(['UP-1']);
  });

  test('extracts multiple distinct keys preserving first-occurrence order', () => {
    expect(extractAllJiraKeys('UP-3 then UP-1 then UP-2')).toEqual(['UP-3', 'UP-1', 'UP-2']);
  });

  test('dedupes repeated keys', () => {
    expect(extractAllJiraKeys('UP-1 UP-2 UP-1 UP-2 UP-3')).toEqual(['UP-1', 'UP-2', 'UP-3']);
  });

  test('matches keys from different projects', () => {
    expect(extractAllJiraKeys('UP-1 and ABC-99 same line')).toEqual(['UP-1', 'ABC-99']);
  });

  test('ignores lowercase', () => {
    expect(extractAllJiraKeys('up-1 lowercase')).toEqual([]);
  });
});

describe('extractSlackThread', () => {
  test('parses plain text Slack archive URL', () => {
    const result = extractSlackThread(
      'https://workspace.slack.com/archives/C0ABC1234/p1712345678901234'
    );
    expect(result).toEqual({ channel: 'C0ABC1234', ts: '1712345678.901234' });
  });

  test('inserts dot at correct position in timestamp', () => {
    const result = extractSlackThread('/archives/C05F65TBB9P/p1700000000123456');
    expect(result.ts).toBe('1700000000.123456');
  });

  test('parses URL embedded in ADF object', () => {
    const adf = {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{
          type: 'text',
          text: 'See https://team.slack.com/archives/C0ABC1234/p1712345678901234 for context',
        }],
      }],
    };
    const result = extractSlackThread(adf);
    expect(result).toEqual({ channel: 'C0ABC1234', ts: '1712345678.901234' });
  });

  test('returns null when no Slack URL in description', () => {
    expect(extractSlackThread('no link here')).toBeNull();
  });

  test('returns null for null input', () => {
    expect(extractSlackThread(null)).toBeNull();
  });

  test('returns null for undefined input', () => {
    expect(extractSlackThread(undefined)).toBeNull();
  });
});

describe('extractPrUrls', () => {
  const PR = 'https://github.com/Everfit-io/everfit-api/pull/19942';

  test('plain https URL', () => {
    expect(extractPrUrls(`review ${PR} pls`)).toEqual([PR]);
  });

  test('Slack <url> and <url|label> wrapping, deduped with the label', () => {
    expect(extractPrUrls(`<${PR}>`)).toEqual([PR]);
    expect(extractPrUrls(`PR: <${PR}|github.com/Everfit-io/everfit-api/pull/19942>`)).toEqual([PR]);
  });

  test('bare github.com text with no scheme (the link label)', () => {
    expect(extractPrUrls('PR: github.com/Everfit-io/everfit-api/pull/19942')).toEqual([PR]);
  });

  test('http:// and www. variants are normalised to https://github.com', () => {
    expect(extractPrUrls('<http://github.com/Everfit-io/everfit-api/pull/19942|x>')).toEqual([PR]);
    expect(extractPrUrls('www.github.com/Everfit-io/everfit-api/pull/19942')).toEqual([PR]);
  });

  test('reads the real link target in rich_text blocks, not the link\'s display text', () => {
    const message = {
      text: 'PR: github.com/Everfit-io/everfit-api/pull/19999',
      blocks: [{
        type: 'rich_text',
        elements: [{
          type: 'rich_text_section',
          elements: [
            { type: 'text', text: 'PR: ' },
            // The label names PR 19999 but the hyperlink points at PR 19942.
            { type: 'link', url: PR, text: 'github.com/Everfit-io/everfit-api/pull/19999' },
          ],
        }],
      }],
    };
    // message.text here is the flattened label with no markup, so it is all plain
    // text and still counts; the point is the block's label adds nothing of its own.
    expect(extractPrUrls({ ...message, text: '' })).toEqual([PR]);
  });

  test('discards the label of a Slack <url|label> link: only the target counts', () => {
    const text = '<https://github.com/Everfit-io/everfit-api/pull/19942|github.com/Everfit-io/everfit-api/pull/19999>';
    expect(extractPrUrls(text)).toEqual([PR]);
    expect(extractPrUrls({ text })).toEqual([PR]);
  });

  test('a label that names a PR is ignored when the target is not a PR at all', () => {
    expect(extractPrUrls('<https://example.com/docs|github.com/Everfit-io/everfit-api/pull/19999>')).toEqual([]);
    expect(extractPrUrls('<https://github.com/Everfit-io/everfit-api|github.com/Everfit-io/everfit-api/pull/19999>')).toEqual([]);
  });

  test('plain text typed outside any hyperlink is still matched next to a labelled link', () => {
    const other = 'https://github.com/Everfit-io/file-service/pull/7';
    const text = `see github.com/Everfit-io/file-service/pull/7 and <${PR}|the main one>`;
    expect(extractPrUrls(text)).toEqual([other, PR]);
  });

  test('mention and channel tokens are harmless', () => {
    expect(extractPrUrls(`<!subteam^S1> <@U1> <#C1|dev> <${PR}|x>`)).toEqual([PR]);
  });

  test('uses blocks alone when the text field carries no link', () => {
    const message = {
      text: 'PR: see here',
      blocks: [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'link', url: PR }] }] }],
    };
    expect(extractPrUrls(message)).toEqual([PR]);
  });

  test('reads attachment unfurl links', () => {
    expect(extractPrUrls({ text: 'look', attachments: [{ from_url: PR, title_link: PR }] })).toEqual([PR]);
  });

  test('does not read PRs mentioned in an unfurl attachment\'s body text', () => {
    const message = {
      text: 'PR: <https://github.com/Everfit-io/everfit-infra/pull/1907|github.com/Everfit-io/everfit-infra/pull/1907>',
      attachments: [{
        from_url: 'https://github.com/Everfit-io/everfit-infra/pull/1907',
        title: '#1907 feat(payment): MP-11451 add the package-label queue',
        title_link: 'https://github.com/Everfit-io/everfit-infra/pull/1907',
        text: 'Must deploy before <https://github.com/Everfit-io/everfit-microservices/pull/4935|everfit-microservices#4935>.',
        fallback: 'Must deploy before https://github.com/Everfit-io/everfit-microservices/pull/4935',
      }],
    };
    expect(extractPrUrls(message)).toEqual(['https://github.com/Everfit-io/everfit-infra/pull/1907']);
  });

  test('reads an attachment\'s original_url', () => {
    expect(extractPrUrls({ text: 'look', attachments: [{ original_url: PR, text: 'unrelated' }] })).toEqual([PR]);
  });

  test('dedupes across text, blocks and attachments, keeping first-occurrence order', () => {
    const other = 'https://github.com/Everfit-io/file-service/pull/7';
    const message = {
      text: `${PR} and ${other}`,
      blocks: [{ type: 'rich_text', elements: [{ type: 'link', url: PR }] }],
      attachments: [{ from_url: other }],
    };
    expect(extractPrUrls(message)).toEqual([PR, other]);
  });

  test('ignores non-PR GitHub links and look-alike hosts', () => {
    expect(extractPrUrls('https://github.com/Everfit-io/everfit-api/issues/12')).toEqual([]);
    expect(extractPrUrls('https://github.com/Everfit-io/everfit-api')).toEqual([]);
    expect(extractPrUrls('notgithub.com/Everfit-io/everfit-api/pull/1')).toEqual([]);
  });

  test('strips trailing path segments like /files', () => {
    expect(extractPrUrls(`${PR}/files`)).toEqual([PR]);
  });

  test('returns [] for empty, null and object-without-links input', () => {
    expect(extractPrUrls('')).toEqual([]);
    expect(extractPrUrls(null)).toEqual([]);
    expect(extractPrUrls(undefined)).toEqual([]);
    expect(extractPrUrls({})).toEqual([]);
    expect(extractPrUrls({ text: 'hi', blocks: [], attachments: [] })).toEqual([]);
  });
});
