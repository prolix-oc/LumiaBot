/**
 * LRCLib lyrics service (https://lrclib.net)
 *
 * Fetches lyrics for a track using a two-tier strategy that mirrors the
 * Lumiverse-SpotifyControls implementation:
 *   1. Exact match via /api/get (track + artist + album + duration in seconds)
 *   2. Fallback to /api/search with a looser "{artist} {track}" query
 *
 * We currently surface plain lyrics to the bot, but the full LRCLib contract
 * (plain + synced + instrumental) is returned so callers can opt into synced
 * lyrics later without changing this service.
 */

const LRCLIB_API = 'https://lrclib.net/api';

// LRCLib asks for a descriptive User-Agent that links back to the project.
const USER_AGENT = 'BadKittyBot (https://github.com/prolix-oc/LumiaBot)';

export interface LyricsData {
  plainLyrics: string | null;
  syncedLyrics: string | null;
  instrumental: boolean;
}

interface LrclibResponse {
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
  instrumental?: boolean;
}

/**
 * Detect tracks whose only "lyric" is the literal word "instrumental" and
 * normalize them to a clean instrumental result with no lyric text.
 */
function normalizeInstrumental(result: LyricsData): LyricsData {
  if (result.instrumental) {
    return { plainLyrics: null, syncedLyrics: null, instrumental: true };
  }

  const plain = result.plainLyrics?.trim().toLowerCase();
  if (plain === 'instrumental') {
    return { plainLyrics: null, syncedLyrics: null, instrumental: true };
  }

  if (result.syncedLyrics) {
    const lines = result.syncedLyrics.split('\n').filter((l) => l.trim());
    if (lines.length === 1 && lines[0]) {
      const text = lines[0]
        .replace(/\[\d+:\d+[.:]\d+\]\s*/g, '')
        .trim()
        .toLowerCase();
      if (text === 'instrumental') {
        return { plainLyrics: null, syncedLyrics: null, instrumental: true };
      }
    }
  }

  return result;
}

/**
 * Strip leftover LRC timestamp tags (e.g. "[00:28.57] ") from plain lyrics.
 * Some community-contributed LRCLib records put timestamps in the plainLyrics
 * field; since we surface plain text to the model, clean them out.
 */
function stripTimestamps(text: string | null): string | null {
  if (!text) return null;
  const cleaned = text.replace(/\[\d+:\d{2}(?:[.:]\d{1,3})?\]\s*/g, '').trim();
  return cleaned || null;
}

function toLyricsData(data: LrclibResponse): LyricsData {
  return normalizeInstrumental({
    plainLyrics: stripTimestamps(data.plainLyrics || null),
    syncedLyrics: data.syncedLyrics || null,
    instrumental: data.instrumental || false,
  });
}

export class LrclibService {
  /**
   * Fetch lyrics for a track. Returns null when nothing is found or on error.
   *
   * @param trackName   Track title (Spotify `details`)
   * @param artistName  Artist name(s) (Spotify `state`)
   * @param albumName   Album name, if known
   * @param durationSec Track length in seconds (rounded); improves exact-match accuracy
   */
  async getLyrics(
    trackName: string,
    artistName: string,
    albumName?: string,
    durationSec?: number,
  ): Promise<LyricsData | null> {
    if (!trackName || !artistName) {
      return null;
    }

    // Tier 1: exact match
    try {
      const params = new URLSearchParams({
        track_name: trackName,
        artist_name: artistName,
      });
      if (albumName) params.set('album_name', albumName);
      if (durationSec && durationSec > 0) {
        params.set('duration', String(Math.round(durationSec)));
      }

      const res = await fetch(`${LRCLIB_API}/get?${params.toString()}`, {
        method: 'GET',
        headers: { 'User-Agent': USER_AGENT },
      });

      if (res.ok) {
        const data = (await res.json()) as LrclibResponse;
        return toLyricsData(data);
      }
    } catch (error) {
      console.error('🎤 [LRCLib] Exact lookup failed:', error);
    }

    // Tier 2: search fallback
    try {
      const searchParams = new URLSearchParams({
        q: `${artistName} ${trackName}`,
      });

      const res = await fetch(`${LRCLIB_API}/search?${searchParams.toString()}`, {
        method: 'GET',
        headers: { 'User-Agent': USER_AGENT },
      });

      if (res.ok) {
        const results = (await res.json()) as LrclibResponse[];
        if (Array.isArray(results) && results[0]) {
          return toLyricsData(results[0]);
        }
      }
    } catch (error) {
      console.error('🎤 [LRCLib] Search fallback failed:', error);
    }

    return null;
  }
}

// Export singleton instance
export const lrclibService = new LrclibService();
