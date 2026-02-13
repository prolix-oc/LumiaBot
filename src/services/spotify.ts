import SpotifyWebApi from 'spotify-web-api-node';
import { config } from '../utils/config';

export interface SpotifyTrack {
  id: string;
  name: string;
  artists: SpotifyArtist[];
  album: SpotifyAlbum;
  durationMs: number;
  explicit: boolean;
  popularity: number;
  previewUrl: string | null;
  trackNumber: number;
}

export interface SpotifyArtist {
  id: string;
  name: string;
  genres: string[];
  popularity: number;
}

export interface SpotifyAlbum {
  id: string;
  name: string;
  artists: SpotifyArtist[];
  releaseDate: string;
  totalTracks: number;
  images: SpotifyImage[];
}

export interface SpotifyImage {
  url: string;
  height: number;
  width: number;
}

export interface SpotifyPlaylist {
  id: string;
  name: string;
  description: string;
  owner: {
    id: string;
    displayName: string;
  };
  tracks: {
    total: number;
    items: SpotifyPlaylistTrack[];
  };
  images: SpotifyImage[];
  public: boolean;
  collaborative: boolean;
}

export interface SpotifyPlaylistTrack {
  addedAt: string;
  addedBy: {
    id: string;
  };
  track: SpotifyTrack;
}

export class SpotifyService {
  private api: SpotifyWebApi;
  private accessToken: string | null = null;
  private tokenExpiresAt: number = 0;

  constructor() {
    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      console.warn('⚠️ [SPOTIFY] Missing SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET. Spotify features disabled.');
      this.api = new SpotifyWebApi({
        clientId: '',
        clientSecret: '',
      });
      return;
    }

    this.api = new SpotifyWebApi({
      clientId,
      clientSecret,
    });

    console.log('🎵 [SPOTIFY] Service initialized');
  }

  /**
   * Check if Spotify is configured and available
   */
  isAvailable(): boolean {
    return !!process.env.SPOTIFY_CLIENT_ID && !!process.env.SPOTIFY_CLIENT_SECRET;
  }

  /**
   * Ensure we have a valid access token
   */
  private async ensureAuthenticated(): Promise<void> {
    if (!this.isAvailable()) {
      throw new Error('Spotify is not configured. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET.');
    }

    // Check if token is still valid (with 5 minute buffer)
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 300000) {
      return;
    }

    try {
      const data = await this.api.clientCredentialsGrant();
      this.accessToken = data.body.access_token;
      this.tokenExpiresAt = Date.now() + (data.body.expires_in * 1000);
      
      this.api.setAccessToken(this.accessToken);
      console.log('🎵 [SPOTIFY] Access token refreshed');
    } catch (error) {
      console.error('❌ [SPOTIFY] Failed to get access token:', error);
      throw new Error('Failed to authenticate with Spotify');
    }
  }

  /**
   * Extract playlist ID from various Spotify URL formats
   */
  extractPlaylistId(url: string): string | null {
    // Match various Spotify playlist URL formats
    const patterns = [
      /open\.spotify\.com\/playlist\/([a-zA-Z0-9]+)/,
      /spotify:playlist:([a-zA-Z0-9]+)/,
      /^([a-zA-Z0-9]{22})$/, // Direct ID (22 chars)
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match && match[1]) {
        return match[1];
      }
    }

    return null;
  }

  /**
   * Fetch a playlist with all its tracks
   */
  async getPlaylist(playlistId: string): Promise<SpotifyPlaylist> {
    await this.ensureAuthenticated();

    try {
      // Get playlist info
      const playlistResponse = await this.api.getPlaylist(playlistId);
      const playlist = playlistResponse.body;

      // Fetch all tracks (pagination)
      const tracks: SpotifyPlaylistTrack[] = [];
      let offset = 0;
      const limit = 100;
      let hasMore = true;

      while (hasMore) {
        const tracksResponse = await this.api.getPlaylistTracks(playlistId, {
          offset,
          limit,
          fields: 'items(added_at,added_by.id,track(id,name,duration_ms,explicit,popularity,preview_url,track_number,artists(id,name),album(id,name,release_date,total_tracks,images))),next',
        });

        const items = tracksResponse.body.items
          .filter((item: any) => {
            // Skip null tracks or tracks without valid IDs (deleted, unavailable, local files)
            if (!item.track || !item.track.id) {
              console.log(`🎵 [SPOTIFY] Skipping track without ID: ${item.track?.name || 'unknown'}`);
              return false;
            }
            return true;
          })
          .map((item: any) => this.mapPlaylistTrack(item));

        tracks.push(...items);
        
        hasMore = tracksResponse.body.next !== null;
        offset += limit;

        // Safety limit - don't fetch more than 1000 tracks
        if (tracks.length >= 1000) {
          console.warn(`🎵 [SPOTIFY] Playlist ${playlistId} has more than 1000 tracks, truncating`);
          break;
        }
      }

      // Fetch artist genres for each unique artist (skip 'unknown' IDs)
      const artistIds = [...new Set(
        tracks.flatMap(t => t.track.artists.map(a => a.id).filter(id => id && id !== 'unknown'))
      )];
      
      console.log(`🎵 [SPOTIFY] Found ${artistIds.length} unique artists to fetch genres for`);
      
      const artistGenres = await this.getArtistGenres(artistIds);

      // Enrich tracks with genres
      tracks.forEach(t => {
        t.track.artists.forEach(artist => {
          artist.genres = artistGenres.get(artist.id) || [];
        });
      });

      return {
        id: playlist.id,
        name: playlist.name,
        description: playlist.description || '',
        owner: {
          id: playlist.owner.id,
          displayName: playlist.owner.display_name || playlist.owner.id,
        },
        tracks: {
          total: playlist.tracks.total,
          items: tracks,
        },
        images: playlist.images.map((img: any) => ({
          url: img.url,
          height: img.height,
          width: img.width,
        })),
        public: playlist.public || false,
        collaborative: playlist.collaborative,
      };
    } catch (error: any) {
      if (error.statusCode === 404) {
        throw new Error('Playlist not found. Make sure it exists and is public.');
      }
      if (error.statusCode === 401) {
        throw new Error('Spotify authentication failed. Check your credentials.');
      }
      console.error('❌ [SPOTIFY] Error fetching playlist:', error);
      throw new Error(`Failed to fetch playlist: ${error.message}`);
    }
  }

  /**
   * Fetch genres for multiple artists
   */
  private async getArtistGenres(artistIds: string[]): Promise<Map<string, string[]>> {
    const genres = new Map<string, string[]>();
    
    if (artistIds.length === 0) return genres;

    // Spotify allows up to 50 artists per request
    const batchSize = 50;
    
    for (let i = 0; i < artistIds.length; i += batchSize) {
      const batch = artistIds.slice(i, i + batchSize);
      
      try {
        const response = await this.api.getArtists(batch);
        response.body.artists.forEach((artist: any) => {
          genres.set(artist.id, artist.genres || []);
        });
      } catch (error) {
        console.warn(`🎵 [SPOTIFY] Failed to fetch genres for artist batch ${i}:`, error);
      }
    }

    return genres;
  }

  /**
   * Get track details by ID
   */
  async getTrack(trackId: string): Promise<SpotifyTrack> {
    await this.ensureAuthenticated();

    try {
      const response = await this.api.getTrack(trackId);
      return this.mapTrack(response.body);
    } catch (error) {
      console.error('❌ [SPOTIFY] Error fetching track:', error);
      throw new Error('Failed to fetch track details');
    }
  }

  /**
   * Map Spotify API track to our interface
   * Handles null/undefined fields gracefully (local files, unavailable tracks, etc.)
   */
  private mapTrack(track: any): SpotifyTrack {
    // Handle missing album (local files, unavailable tracks)
    const album = track.album || {};
    
    return {
      id: track.id || 'unknown',
      name: track.name || 'Unknown Track',
      artists: (track.artists || []).map((a: any) => ({
        id: a?.id || 'unknown',
        name: a?.name || 'Unknown Artist',
        genres: [], // Will be populated separately
        popularity: 0,
      })),
      album: {
        id: album.id || 'unknown',
        name: album.name || 'Unknown Album',
        artists: (album.artists || []).map((a: any) => ({
          id: a?.id || 'unknown',
          name: a?.name || 'Unknown Artist',
          genres: [],
          popularity: 0,
        })),
        releaseDate: album.release_date || '',
        totalTracks: album.total_tracks || 0,
        images: (album.images || []).map((img: any) => ({
          url: img?.url || '',
          height: img?.height || 0,
          width: img?.width || 0,
        })),
      },
      durationMs: track.duration_ms || 0,
      explicit: track.explicit || false,
      popularity: track.popularity || 0,
      previewUrl: track.preview_url || null,
      trackNumber: track.track_number || 0,
    };
  }

  /**
   * Map Spotify API playlist track to our interface
   */
  private mapPlaylistTrack(item: any): SpotifyPlaylistTrack {
    return {
      addedAt: item.added_at,
      addedBy: {
        id: item.added_by?.id || 'unknown',
      },
      track: this.mapTrack(item.track),
    };
  }
}

// Singleton instance
export const spotifyService = new SpotifyService();
