const MARKDOWN_CHARS = new Set(['*', '_', '~', '`', '|', '>', '[', ']', '(', ')', '#']);
const URL_PATTERN = /https?:\/\/[^\s<>()]+/gi;
const FENCE_PATTERN = /^\s*```/;

function hasOddBackslashPrefix(text: string, index: number): boolean {
  let count = 0;

  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) {
    count++;
  }

  return count % 2 === 1;
}

function escapeMarkdownSegment(segment: string): string {
  let escaped = '';

  for (let i = 0; i < segment.length; i++) {
    const char = segment[i];

    if (char && MARKDOWN_CHARS.has(char) && !hasOddBackslashPrefix(segment, i)) {
      escaped += '\\';
    }

    escaped += char;
  }

  return escaped;
}

/**
 * Escape Discord Markdown formatting in unsafe dynamic text, such as usernames.
 * Bare URLs are left intact so Discord can still auto-link them.
 */
export function escapeDiscordMarkdown(text: string): string {
  let escaped = '';
  let lastIndex = 0;

  for (const match of text.matchAll(URL_PATTERN)) {
    const url = match[0];
    const index = match.index ?? 0;

    escaped += escapeMarkdownSegment(text.slice(lastIndex, index));
    escaped += url;
    lastIndex = index + url.length;
  }

  escaped += escapeMarkdownSegment(text.slice(lastIndex));
  return escaped;
}

function escapeDiscordHeaders(text: string): string {
  const lines = text.split('\n');
  let inFence = false;

  return lines.map((line) => {
    if (FENCE_PATTERN.test(line)) {
      inFence = !inFence;
      return line;
    }

    if (inFence) {
      return line;
    }

    // Discord renders leading # markers as headers. Keep regular markdown,
    // but neutralize headers because they are too visually loud for bot replies.
    return line.replace(/^(\s{0,3})(#{1,6})(?=\s)/, '$1\\$2');
  }).join('\n');
}

export function formatDiscordResponseText(text: string, maxLength = 1950): string {
  const formatted = escapeDiscordHeaders(text);

  return formatted.length > maxLength
    ? `${formatted.slice(0, maxLength)}... (message truncated)`
    : formatted;
}
