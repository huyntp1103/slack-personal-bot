'use strict';

const { extractJiraKey, extractSlackThread } = require('../src/utils');

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
