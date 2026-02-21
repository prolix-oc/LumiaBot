import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import { config } from '../utils/config';

export interface PageContent {
  url: string;
  title: string;
  content: string;
  excerpt?: string;
  siteName?: string;
  byline?: string;
}

// URL pattern — matches http(s) URLs in message text
const URL_REGEX = /https?:\/\/[^\s<>\"'\)\]]+/gi;

// Extensions and domains to skip (already handled as attachments or not useful as pages)
const SKIP_EXTENSIONS = /\.(png|jpe?g|gif|webp|svg|ico|bmp|mp4|webm|mov|avi|mkv|mp3|wav|ogg|flac|pdf|zip|tar|gz|rar|7z|exe|dmg|apk)$/i;
const SKIP_DOMAINS = /^https?:\/\/(cdn\.discordapp\.com|media\.discordapp\.net|tenor\.com\/view|i\.imgur\.com)/i;

// Binary content types to reject
const BINARY_CONTENT_TYPES = ['image/', 'video/', 'audio/', 'application/pdf', 'application/zip', 'application/octet-stream'];

const USER_AGENT = 'Mozilla/5.0 (compatible; BadKittyBot/1.0; +https://discord.gg)';

class PageExtractorService {
  /**
   * Extract HTTP(S) URLs from message text, filtering out non-page links
   */
  extractUrls(text: string): string[] {
    const matches = text.match(URL_REGEX);
    if (!matches) return [];

    const seen = new Set<string>();
    const urls: string[] = [];

    for (const raw of matches) {
      // Clean trailing punctuation that's likely not part of the URL
      const url = raw.replace(/[.,;:!?)]+$/, '');

      if (seen.has(url)) continue;
      seen.add(url);

      if (SKIP_EXTENSIONS.test(url)) continue;
      if (SKIP_DOMAINS.test(url)) continue;

      urls.push(url);

      if (urls.length >= config.pageExtraction.maxUrls) break;
    }

    return urls;
  }

  /**
   * Fetch a URL and extract its readable content
   */
  async extractPageContent(url: string): Promise<PageContent | null> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.pageExtraction.timeoutMs);

      let response: Response;
      try {
        response = await fetch(url, {
          headers: {
            'User-Agent': USER_AGENT,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
          },
          signal: controller.signal,
          redirect: 'follow',
        });
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        console.log(`🌐 [PAGE] Failed to fetch ${url}: HTTP ${response.status}`);
        return null;
      }

      // Check content type — skip binary responses
      const contentType = response.headers.get('content-type') || '';
      if (BINARY_CONTENT_TYPES.some(t => contentType.includes(t))) {
        console.log(`🌐 [PAGE] Skipping binary content at ${url}: ${contentType}`);
        return null;
      }

      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
        console.log(`🌐 [PAGE] Skipping non-HTML content at ${url}: ${contentType}`);
        return null;
      }

      // Check content length if available — skip very large pages
      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength) > 5 * 1024 * 1024) {
        console.log(`🌐 [PAGE] Skipping oversized page at ${url}: ${contentLength} bytes`);
        return null;
      }

      const html = await response.text();

      // Bail if HTML itself is too large (in case no Content-Length header)
      if (html.length > 5 * 1024 * 1024) {
        console.log(`🌐 [PAGE] HTML too large after download for ${url}: ${html.length} bytes`);
        return null;
      }

      // Parse with linkedom
      const { document } = parseHTML(html);

      // Set document URL for Readability to resolve relative links
      try {
        Object.defineProperty(document, 'baseURI', { value: url, writable: false });
      } catch {
        // Some linkedom versions may not allow this — non-critical
      }

      // Try Readability first (best for article-style content)
      const reader = new Readability(document as any, { charThreshold: 100 });
      const article = reader.parse();

      if (article && article.textContent && article.textContent.trim().length > 100) {
        const content = this.truncateContent(article.textContent.trim());
        console.log(`🌐 [PAGE] Extracted article from ${url}: "${article.title}" (${content.length} chars)`);
        return {
          url,
          title: article.title || this.extractTitleFallback(document) || url,
          content,
          excerpt: article.excerpt || undefined,
          siteName: article.siteName || undefined,
          byline: article.byline || undefined,
        };
      }

      // Fallback: strip scripts/styles and get raw text
      const fallbackContent = this.extractFallbackContent(html);
      if (fallbackContent && fallbackContent.length > 100) {
        const title = this.extractTitleFallback(document) || url;
        const content = this.truncateContent(fallbackContent);
        console.log(`🌐 [PAGE] Fallback extraction from ${url}: "${title}" (${content.length} chars)`);
        return {
          url,
          title,
          content,
        };
      }

      console.log(`🌐 [PAGE] No meaningful content extracted from ${url}`);
      return null;
    } catch (error: any) {
      if (error.name === 'AbortError') {
        console.log(`🌐 [PAGE] Fetch timed out for ${url}`);
      } else {
        console.error(`🌐 [PAGE] Error extracting ${url}:`, error.message || error);
      }
      return null;
    }
  }

  /**
   * Extract page content from all URLs found in a message
   */
  async extractPagesFromMessage(text: string): Promise<PageContent[]> {
    const urls = this.extractUrls(text);
    if (urls.length === 0) return [];

    console.log(`🌐 [PAGE] Found ${urls.length} URL(s) to extract: ${urls.join(', ')}`);

    const results = await Promise.allSettled(
      urls.map(url => this.extractPageContent(url))
    );

    const pages: PageContent[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        pages.push(result.value);
      }
    }

    if (pages.length > 0) {
      console.log(`🌐 [PAGE] Successfully extracted ${pages.length}/${urls.length} page(s)`);
    }

    return pages;
  }

  /**
   * Fallback content extraction: strip tags and get text
   */
  private extractFallbackContent(html: string): string {
    // Re-parse to get a clean document (Readability mutates the DOM)
    const { document } = parseHTML(html);

    // Remove script, style, nav, footer, header elements
    for (const tag of ['script', 'style', 'nav', 'footer', 'header', 'aside', 'noscript']) {
      for (const el of document.querySelectorAll(tag)) {
        el.remove();
      }
    }

    // Get text from body or the whole document
    const body = document.querySelector('body');
    const text = (body || document.documentElement)?.textContent || '';

    // Collapse whitespace
    return text.replace(/[\t ]+/g, ' ').replace(/\n\s*\n/g, '\n').trim();
  }

  /**
   * Try to extract a page title from the document
   */
  private extractTitleFallback(document: any): string | null {
    const titleEl = document.querySelector('title');
    if (titleEl?.textContent) return titleEl.textContent.trim();

    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle?.getAttribute('content')) return ogTitle.getAttribute('content').trim();

    const h1 = document.querySelector('h1');
    if (h1?.textContent) return h1.textContent.trim();

    return null;
  }

  /**
   * Truncate content to the configured max length
   */
  private truncateContent(text: string): string {
    if (text.length <= config.pageExtraction.maxContentLength) return text;
    return text.substring(0, config.pageExtraction.maxContentLength) + '\n... [content truncated]';
  }
}

export const pageExtractorService = new PageExtractorService();
