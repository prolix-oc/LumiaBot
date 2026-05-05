const MARKDOWN_CHARS = new Set(['*', '_', '~', '`', '|', '>', '[', ']', '(', ')']);
const URL_PATTERN = /https?:\/\/[^\s<>()]+/gi;

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
 * Escape Discord Markdown formatting in model text while leaving bare URLs intact.
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

export function formatDiscordResponseText(text: string, maxLength = 1950): string {
  const escaped = escapeDiscordMarkdown(text);

  return escaped.length > maxLength
    ? `${escaped.slice(0, maxLength)}... (message truncated)`
    : escaped;
}
