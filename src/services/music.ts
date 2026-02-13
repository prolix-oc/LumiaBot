import { Database } from 'bun:sqlite';

export interface MusicPlaylist {
  id?: number;
  spotifyId: string;
  name: string;
  description: string;
  ownerId: string;
  ownerName: string;
  trackCount: number;
  imageUrl?: string;
  spotifyUrl: string;
  isPublic: boolean;
  importedAt: string;
  lastUpdated: string;
}

export interface MusicTrack {
  id?: number;
  spotifyId: string;
  name: string;
  albumId: number;
  durationMs: number;
  explicit: boolean;
  popularity: number;
  previewUrl?: string;
  trackNumber: number;
  spotifyUrl: string;
}

export interface MusicArtist {
  id?: number;
  spotifyId: string;
  name: string;
  genres: string[];
  popularity: number;
  spotifyUrl: string;
}

export interface MusicAlbum {
  id?: number;
  spotifyId: string;
  name: string;
  releaseDate: string;
  totalTracks: number;
  imageUrl?: string;
  spotifyUrl: string;
}

export interface MusicTrackWithDetails extends MusicTrack {
  artists: MusicArtist[];
  album: MusicAlbum;
  genres: string[];
}

export interface PlaylistWithTracks extends MusicPlaylist {
  tracks: MusicTrackWithDetails[];
}

export interface MusicStats {
  totalPlaylists: number;
  totalTracks: number;
  totalArtists: number;
  totalAlbums: number;
  topGenres: Array<{ genre: string; count: number }>;
  topArtists: Array<{ artist: MusicArtist; trackCount: number }>;
}

export class MusicService {
  private db: Database;

  constructor() {
    this.db = new Database('music.db');
    this.initDatabase();
    console.log('🎵 [MUSIC] Service initialized with persistent storage');
  }

  private initDatabase(): void {
    // Create playlists table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS music_playlists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        spotify_id TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        owner_id TEXT NOT NULL,
        owner_name TEXT NOT NULL,
        track_count INTEGER DEFAULT 0,
        image_url TEXT,
        spotify_url TEXT NOT NULL,
        is_public BOOLEAN DEFAULT 1,
        imported_at TEXT NOT NULL,
        last_updated TEXT NOT NULL
      )
    `);

    // Create artists table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS music_artists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        spotify_id TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        genres TEXT NOT NULL, -- JSON array
        popularity INTEGER DEFAULT 0,
        spotify_url TEXT NOT NULL
      )
    `);

    // Create albums table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS music_albums (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        spotify_id TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        release_date TEXT,
        total_tracks INTEGER,
        image_url TEXT,
        spotify_url TEXT NOT NULL
      )
    `);

    // Create tracks table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS music_tracks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        spotify_id TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        album_id INTEGER NOT NULL,
        duration_ms INTEGER,
        explicit BOOLEAN DEFAULT 0,
        popularity INTEGER DEFAULT 0,
        preview_url TEXT,
        track_number INTEGER,
        spotify_url TEXT NOT NULL,
        FOREIGN KEY (album_id) REFERENCES music_albums(id)
      )
    `);

    // Create track-artists junction table (many-to-many)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS music_track_artists (
        track_id INTEGER NOT NULL,
        artist_id INTEGER NOT NULL,
        PRIMARY KEY (track_id, artist_id),
        FOREIGN KEY (track_id) REFERENCES music_tracks(id) ON DELETE CASCADE,
        FOREIGN KEY (artist_id) REFERENCES music_artists(id) ON DELETE CASCADE
      )
    `);

    // Create playlist-tracks junction table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS music_playlist_tracks (
        playlist_id INTEGER NOT NULL,
        track_id INTEGER NOT NULL,
        added_at TEXT,
        position INTEGER,
        PRIMARY KEY (playlist_id, track_id),
        FOREIGN KEY (playlist_id) REFERENCES music_playlists(id) ON DELETE CASCADE,
        FOREIGN KEY (track_id) REFERENCES music_tracks(id) ON DELETE CASCADE
      )
    `);

    // Create indexes for efficient querying
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_music_playlist_spotify_id ON music_playlists(spotify_id)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_music_artist_spotify_id ON music_artists(spotify_id)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_music_album_spotify_id ON music_albums(spotify_id)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_music_track_spotify_id ON music_tracks(spotify_id)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_music_track_album ON music_tracks(album_id)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_music_track_name ON music_tracks(name)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_music_artist_name ON music_artists(name)`);

    console.log('🎵 [MUSIC] Database initialized');
  }

  /**
   * Import a playlist with all its tracks
   * Handles duplicates: skips existing artists/albums/tracks, only links to playlist
   */
  async importPlaylist(
    spotifyPlaylist: any,
    spotifyTracks: any[]
  ): Promise<{ 
    playlistId: number; 
    importedTracks: number; 
    newArtists: number; 
    newAlbums: number;
    newTracks: number;
    duplicateArtists: number;
    duplicateAlbums: number;
    duplicateTracks: number;
  }> {
    const now = new Date().toISOString();

    // Check if playlist already exists
    const existingPlaylist = this.getPlaylistBySpotifyId(spotifyPlaylist.id);
    const isReimport = !!existingPlaylist;

    // Insert or update playlist
    const playlistResult = this.db.query(`
      INSERT INTO music_playlists 
      (spotify_id, name, description, owner_id, owner_name, track_count, image_url, spotify_url, is_public, imported_at, last_updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(spotify_id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        track_count = excluded.track_count,
        image_url = excluded.image_url,
        last_updated = excluded.last_updated
      RETURNING id
    `).get(
      spotifyPlaylist.id,
      spotifyPlaylist.name,
      spotifyPlaylist.description || '',
      spotifyPlaylist.owner.id,
      spotifyPlaylist.owner.displayName,
      spotifyTracks.length,
      spotifyPlaylist.images[0]?.url || null,
      `https://open.spotify.com/playlist/${spotifyPlaylist.id}`,
      spotifyPlaylist.public ? 1 : 0,
      now,
      now
    ) as { id: number };

    const playlistId = playlistResult.id;

    // Clear existing playlist tracks (for re-imports)
    this.db.run('DELETE FROM music_playlist_tracks WHERE playlist_id = ?', [playlistId]);

    let importedTracks = 0;
    let newArtists = 0;
    let newAlbums = 0;
    let newTracks = 0;
    let duplicateArtists = 0;
    let duplicateAlbums = 0;
    let duplicateTracks = 0;

    // Get existing artist/album/track IDs for duplicate detection
    const existingArtists = new Set(
      (this.db.query('SELECT spotify_id FROM music_artists').all() as Array<{ spotify_id: string }>)
        .map(a => a.spotify_id)
    );
    const existingAlbums = new Set(
      (this.db.query('SELECT spotify_id FROM music_albums').all() as Array<{ spotify_id: string }>)
        .map(a => a.spotify_id)
    );
    const existingTracks = new Set(
      (this.db.query('SELECT spotify_id FROM music_tracks').all() as Array<{ spotify_id: string }>)
        .map(t => t.spotify_id)
    );

    // Process each track
    for (let i = 0; i < spotifyTracks.length; i++) {
      const playlistTrack = spotifyTracks[i];
      const track = playlistTrack.track;

      // Insert artists (or get existing)
      const artistIds: number[] = [];
      for (const artist of track.artists) {
        const isNewArtist = !existingArtists.has(artist.id);
        
        const artistResult = this.db.query(`
          INSERT INTO music_artists (spotify_id, name, genres, popularity, spotify_url)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(spotify_id) DO UPDATE SET
            name = excluded.name,
            genres = excluded.genres,
            popularity = excluded.popularity
          RETURNING id
        `).get(
          artist.id,
          artist.name,
          JSON.stringify(artist.genres || []),
          artist.popularity || 0,
          `https://open.spotify.com/artist/${artist.id}`
        ) as { id: number };

        artistIds.push(artistResult.id);

        if (isNewArtist) {
          newArtists++;
          existingArtists.add(artist.id);
        } else {
          duplicateArtists++;
        }
      }

      // Insert album (or get existing)
      const isNewAlbum = !existingAlbums.has(track.album.id);
      
      const albumResult = this.db.query(`
        INSERT INTO music_albums (spotify_id, name, release_date, total_tracks, image_url, spotify_url)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(spotify_id) DO UPDATE SET
          name = excluded.name,
          release_date = excluded.release_date,
          total_tracks = excluded.total_tracks,
          image_url = excluded.image_url
        RETURNING id
      `).get(
        track.album.id,
        track.album.name,
        track.album.releaseDate,
        track.album.totalTracks,
        track.album.images[0]?.url || null,
        `https://open.spotify.com/album/${track.album.id}`
      ) as { id: number };

      if (isNewAlbum) {
        newAlbums++;
        existingAlbums.add(track.album.id);
      } else {
        duplicateAlbums++;
      }

      // Insert track (or get existing)
      const isNewTrack = !existingTracks.has(track.id);
      
      const trackResult = this.db.query(`
        INSERT INTO music_tracks 
        (spotify_id, name, album_id, duration_ms, explicit, popularity, preview_url, track_number, spotify_url)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(spotify_id) DO UPDATE SET
          name = excluded.name,
          album_id = excluded.album_id,
          duration_ms = excluded.duration_ms,
          explicit = excluded.explicit,
          popularity = excluded.popularity,
          preview_url = excluded.preview_url,
          track_number = excluded.track_number
        RETURNING id
      `).get(
        track.id,
        track.name,
        albumResult.id,
        track.durationMs,
        track.explicit ? 1 : 0,
        track.popularity,
        track.previewUrl,
        track.trackNumber,
        `https://open.spotify.com/track/${track.id}`
      ) as { id: number };

      if (isNewTrack) {
        newTracks++;
        existingTracks.add(track.id);
      } else {
        duplicateTracks++;
      }

      // Link track to artists
      for (const artistId of artistIds) {
        this.db.run(`
          INSERT OR IGNORE INTO music_track_artists (track_id, artist_id)
          VALUES (?, ?)
        `, [trackResult.id, artistId]);
      }

      // Link track to playlist
      this.db.run(`
        INSERT INTO music_playlist_tracks (playlist_id, track_id, added_at, position)
        VALUES (?, ?, ?, ?)
      `, [playlistId, trackResult.id, playlistTrack.addedAt, i]);

      importedTracks++;
    }

    // Update actual track count
    this.db.run(
      'UPDATE music_playlists SET track_count = ? WHERE id = ?',
      [importedTracks, playlistId]
    );

    const actionType = isReimport ? 'Updated' : 'Imported';
    console.log(`🎵 [MUSIC] ${actionType} playlist "${spotifyPlaylist.name}"`);
    console.log(`   📊 Tracks: ${importedTracks} (${newTracks} new, ${duplicateTracks} existing)`);
    console.log(`   🎤 Artists: ${newArtists} new, ${duplicateArtists} existing`);
    console.log(`   💿 Albums: ${newAlbums} new, ${duplicateAlbums} existing`);

    return { 
      playlistId, 
      importedTracks, 
      newArtists, 
      newAlbums,
      newTracks,
      duplicateArtists,
      duplicateAlbums,
      duplicateTracks
    };
  }

  /**
   * Get all playlists
   */
  getAllPlaylists(): MusicPlaylist[] {
    const results = this.db.query(`
      SELECT * FROM music_playlists
      ORDER BY imported_at DESC
    `).all() as any[];

    return results.map(r => this.mapRowToPlaylist(r));
  }

  /**
   * Get playlist by ID with all tracks
   */
  getPlaylistWithTracks(playlistId: number): PlaylistWithTracks | null {
    const playlist = this.db.query('SELECT * FROM music_playlists WHERE id = ?').get(playlistId) as any;
    if (!playlist) return null;

    const tracks = this.db.query(`
      SELECT 
        t.*,
        a.id as album_id,
        a.spotify_id as album_spotify_id,
        a.name as album_name,
        a.release_date as album_release_date,
        a.total_tracks as album_total_tracks,
        a.image_url as album_image_url,
        a.spotify_url as album_spotify_url
      FROM music_tracks t
      JOIN music_playlist_tracks pt ON t.id = pt.track_id
      JOIN music_albums a ON t.album_id = a.id
      WHERE pt.playlist_id = ?
      ORDER BY pt.position
    `).all(playlistId) as any[];

    const tracksWithDetails: MusicTrackWithDetails[] = tracks.map(t => {
      const artists = this.db.query(`
        SELECT ar.*
        FROM music_artists ar
        JOIN music_track_artists ta ON ar.id = ta.artist_id
        WHERE ta.track_id = ?
      `).all(t.id) as any[];

      const genres = [...new Set(artists.flatMap(a => JSON.parse(a.genres || '[]')))];

      return {
        ...this.mapRowToTrack(t),
        artists: artists.map(a => this.mapRowToArtist(a)),
        album: this.mapRowToAlbum({
          id: t.album_id,
          spotify_id: t.album_spotify_id,
          name: t.album_name,
          release_date: t.album_release_date,
          total_tracks: t.album_total_tracks,
          image_url: t.album_image_url,
          spotify_url: t.album_spotify_url,
        }),
        genres,
      };
    });

    return {
      ...this.mapRowToPlaylist(playlist),
      tracks: tracksWithDetails,
    };
  }

  /**
   * Get playlist by Spotify ID
   */
  getPlaylistBySpotifyId(spotifyId: string): MusicPlaylist | null {
    const result = this.db.query('SELECT * FROM music_playlists WHERE spotify_id = ?').get(spotifyId) as any;
    return result ? this.mapRowToPlaylist(result) : null;
  }

  /**
   * Delete a playlist and its associations (but keep tracks/artists/albums)
   */
  deletePlaylist(playlistId: number): void {
    this.db.run('DELETE FROM music_playlist_tracks WHERE playlist_id = ?', [playlistId]);
    this.db.run('DELETE FROM music_playlists WHERE id = ?', [playlistId]);
    console.log(`🎵 [MUSIC] Deleted playlist ${playlistId}`);
  }

  /**
   * Get music statistics
   */
  getStats(): MusicStats {
    const totalPlaylists = (this.db.query('SELECT COUNT(*) as count FROM music_playlists').get() as { count: number }).count;
    const totalTracks = (this.db.query('SELECT COUNT(*) as count FROM music_tracks').get() as { count: number }).count;
    const totalArtists = (this.db.query('SELECT COUNT(*) as count FROM music_artists').get() as { count: number }).count;
    const totalAlbums = (this.db.query('SELECT COUNT(*) as count FROM music_albums').get() as { count: number }).count;

    // Get genre counts
    const genreResults = this.db.query('SELECT genres FROM music_artists').all() as Array<{ genres: string }>;
    const genreCounts = new Map<string, number>();
    for (const row of genreResults) {
      const genres = JSON.parse(row.genres || '[]');
      for (const genre of genres) {
        genreCounts.set(genre, (genreCounts.get(genre) || 0) + 1);
      }
    }

    const topGenres = Array.from(genreCounts.entries())
      .map(([genre, count]) => ({ genre, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // Get top artists by track count
    const artistTrackCounts = this.db.query(`
      SELECT ar.id, ar.spotify_id, ar.name, ar.genres, ar.popularity, ar.spotify_url, COUNT(ta.track_id) as track_count
      FROM music_artists ar
      JOIN music_track_artists ta ON ar.id = ta.artist_id
      GROUP BY ar.id
      ORDER BY track_count DESC
      LIMIT 10
    `).all() as any[];

    const topArtists = artistTrackCounts.map(row => ({
      artist: this.mapRowToArtist(row),
      trackCount: row.track_count,
    }));

    return {
      totalPlaylists,
      totalTracks,
      totalArtists,
      totalAlbums,
      topGenres,
      topArtists,
    };
  }

  /**
   * Get random tracks for music taste queries
   */
  getRandomTracks(count: number = 10): MusicTrackWithDetails[] {
    const tracks = this.db.query(`
      SELECT 
        t.*,
        a.id as album_id,
        a.spotify_id as album_spotify_id,
        a.name as album_name,
        a.release_date as album_release_date,
        a.total_tracks as album_total_tracks,
        a.image_url as album_image_url,
        a.spotify_url as album_spotify_url
      FROM music_tracks t
      JOIN music_albums a ON t.album_id = a.id
      ORDER BY RANDOM()
      LIMIT ?
    `).all(count) as any[];

    return tracks.map(t => {
      const artists = this.db.query(`
        SELECT ar.*
        FROM music_artists ar
        JOIN music_track_artists ta ON ar.id = ta.artist_id
        WHERE ta.track_id = ?
      `).all(t.id) as any[];

      const genres = [...new Set(artists.flatMap(a => JSON.parse(a.genres || '[]')))];

      return {
        ...this.mapRowToTrack(t),
        artists: artists.map(a => this.mapRowToArtist(a)),
        album: this.mapRowToAlbum({
          id: t.album_id,
          spotify_id: t.album_spotify_id,
          name: t.album_name,
          release_date: t.album_release_date,
          total_tracks: t.album_total_tracks,
          image_url: t.album_image_url,
          spotify_url: t.album_spotify_url,
        }),
        genres,
      };
    });
  }

  /**
   * Get tracks by genre
   */
  getTracksByGenre(genre: string, limit: number = 10): MusicTrackWithDetails[] {
    const tracks = this.db.query(`
      SELECT DISTINCT
        t.*,
        a.id as album_id,
        a.spotify_id as album_spotify_id,
        a.name as album_name,
        a.release_date as album_release_date,
        a.total_tracks as album_total_tracks,
        a.image_url as album_image_url,
        a.spotify_url as album_spotify_url
      FROM music_tracks t
      JOIN music_albums a ON t.album_id = a.id
      JOIN music_track_artists ta ON t.id = ta.track_id
      JOIN music_artists ar ON ta.artist_id = ar.id
      WHERE LOWER(ar.genres) LIKE LOWER(?)
      ORDER BY RANDOM()
      LIMIT ?
    `).all(`%"${genre}"%`, limit) as any[];

    return tracks.map(t => {
      const artists = this.db.query(`
        SELECT ar.*
        FROM music_artists ar
        JOIN music_track_artists ta ON ar.id = ta.artist_id
        WHERE ta.track_id = ?
      `).all(t.id) as any[];

      const trackGenres = [...new Set(artists.flatMap(a => JSON.parse(a.genres || '[]')))];

      return {
        ...this.mapRowToTrack(t),
        artists: artists.map(a => this.mapRowToArtist(a)),
        album: this.mapRowToAlbum({
          id: t.album_id,
          spotify_id: t.album_spotify_id,
          name: t.album_name,
          release_date: t.album_release_date,
          total_tracks: t.album_total_tracks,
          image_url: t.album_image_url,
          spotify_url: t.album_spotify_url,
        }),
        genres: trackGenres,
      };
    });
  }

  /**
   * Search tracks by name or artist
   */
  searchTracks(query: string, limit: number = 10): MusicTrackWithDetails[] {
    const searchTerm = `%${query.toLowerCase()}%`;
    
    const tracks = this.db.query(`
      SELECT DISTINCT
        t.*,
        a.id as album_id,
        a.spotify_id as album_spotify_id,
        a.name as album_name,
        a.release_date as album_release_date,
        a.total_tracks as album_total_tracks,
        a.image_url as album_image_url,
        a.spotify_url as album_spotify_url
      FROM music_tracks t
      JOIN music_albums a ON t.album_id = a.id
      JOIN music_track_artists ta ON t.id = ta.track_id
      JOIN music_artists ar ON ta.artist_id = ar.id
      WHERE LOWER(t.name) LIKE ? OR LOWER(ar.name) LIKE ?
      ORDER BY t.popularity DESC
      LIMIT ?
    `).all(searchTerm, searchTerm, limit) as any[];

    return tracks.map(t => {
      const artists = this.db.query(`
        SELECT ar.*
        FROM music_artists ar
        JOIN music_track_artists ta ON ar.id = ta.artist_id
        WHERE ta.track_id = ?
      `).all(t.id) as any[];

      const genres = [...new Set(artists.flatMap(a => JSON.parse(a.genres || '[]')))];

      return {
        ...this.mapRowToTrack(t),
        artists: artists.map(a => this.mapRowToArtist(a)),
        album: this.mapRowToAlbum({
          id: t.album_id,
          spotify_id: t.album_spotify_id,
          name: t.album_name,
          release_date: t.album_release_date,
          total_tracks: t.album_total_tracks,
          image_url: t.album_image_url,
          spotify_url: t.album_spotify_url,
        }),
        genres,
      };
    });
  }

  /**
   * Get all unique genres across all artists
   */
  getAllGenres(): string[] {
    const results = this.db.query('SELECT genres FROM music_artists').all() as Array<{ genres: string }>;
    const allGenres = new Set<string>();
    
    for (const row of results) {
      const genres = JSON.parse(row.genres || '[]');
      genres.forEach((g: string) => allGenres.add(g));
    }

    return Array.from(allGenres).sort();
  }

  // Mapping helpers
  private mapRowToPlaylist(row: any): MusicPlaylist {
    return {
      id: row.id,
      spotifyId: row.spotify_id,
      name: row.name,
      description: row.description,
      ownerId: row.owner_id,
      ownerName: row.owner_name,
      trackCount: row.track_count,
      imageUrl: row.image_url,
      spotifyUrl: row.spotify_url,
      isPublic: row.is_public === 1,
      importedAt: row.imported_at,
      lastUpdated: row.last_updated,
    };
  }

  private mapRowToTrack(row: any): MusicTrack {
    return {
      id: row.id,
      spotifyId: row.spotify_id,
      name: row.name,
      albumId: row.album_id,
      durationMs: row.duration_ms,
      explicit: row.explicit === 1,
      popularity: row.popularity,
      previewUrl: row.preview_url,
      trackNumber: row.track_number,
      spotifyUrl: row.spotify_url,
    };
  }

  private mapRowToArtist(row: any): MusicArtist {
    return {
      id: row.id,
      spotifyId: row.spotify_id,
      name: row.name,
      genres: JSON.parse(row.genres || '[]'),
      popularity: row.popularity,
      spotifyUrl: row.spotify_url,
    };
  }

  private mapRowToAlbum(row: any): MusicAlbum {
    return {
      id: row.id,
      spotifyId: row.spotify_id,
      name: row.name,
      releaseDate: row.release_date,
      totalTracks: row.total_tracks,
      imageUrl: row.image_url,
      spotifyUrl: row.spotify_url,
    };
  }

  /**
   * Clear all music data from the database
   * WARNING: This deletes EVERYTHING - playlists, tracks, artists, albums
   * Returns statistics about what was deleted
   */
  clearAll(): { playlistsDeleted: number; tracksDeleted: number; artistsDeleted: number; albumsDeleted: number } {
    const stats = this.getStats();
    
    // Delete in order to respect foreign key constraints
    // 1. Delete junction tables first
    this.db.run('DELETE FROM music_playlist_tracks');
    this.db.run('DELETE FROM music_track_artists');
    
    // 2. Delete main tables
    this.db.run('DELETE FROM music_tracks');
    this.db.run('DELETE FROM music_playlists');
    this.db.run('DELETE FROM music_albums');
    this.db.run('DELETE FROM music_artists');
    
    console.log(`🎵 [MUSIC] CLEARED ALL MUSIC DATA:`);
    console.log(`   📁 Playlists deleted: ${stats.totalPlaylists}`);
    console.log(`   🎵 Tracks deleted: ${stats.totalTracks}`);
    console.log(`   🎤 Artists deleted: ${stats.totalArtists}`);
    console.log(`   💿 Albums deleted: ${stats.totalAlbums}`);
    
    return {
      playlistsDeleted: stats.totalPlaylists,
      tracksDeleted: stats.totalTracks,
      artistsDeleted: stats.totalArtists,
      albumsDeleted: stats.totalAlbums,
    };
  }

  /**
   * Clear all data for a specific playlist and its tracks
   * More targeted than clearAll - only removes tracks unique to this playlist
   */
  clearPlaylistAndTracks(playlistId: number): { tracksRemoved: number } {
    // Get tracks that are ONLY in this playlist (not in any other playlist)
    const uniqueTracks = this.db.query(`
      SELECT pt.track_id
      FROM music_playlist_tracks pt
      WHERE pt.playlist_id = ?
      AND pt.track_id NOT IN (
        SELECT track_id 
        FROM music_playlist_tracks 
        WHERE playlist_id != ?
      )
    `).all(playlistId, playlistId) as Array<{ track_id: number }>;

    const trackIds = uniqueTracks.map(t => t.track_id);
    
    // Remove playlist associations
    this.db.run('DELETE FROM music_playlist_tracks WHERE playlist_id = ?', [playlistId]);
    
    // Remove the playlist
    this.db.run('DELETE FROM music_playlists WHERE id = ?', [playlistId]);
    
    // Remove tracks that were unique to this playlist
    let tracksRemoved = 0;
    if (trackIds.length > 0) {
      // First remove track-artist associations
      for (const trackId of trackIds) {
        this.db.run('DELETE FROM music_track_artists WHERE track_id = ?', [trackId]);
      }
      
      // Then remove the tracks themselves
      const placeholders = trackIds.map(() => '?').join(',');
      this.db.run(`DELETE FROM music_tracks WHERE id IN (${placeholders})`, trackIds);
      tracksRemoved = trackIds.length;
    }
    
    console.log(`🎵 [MUSIC] Cleared playlist ${playlistId} and ${tracksRemoved} unique tracks`);
    
    return { tracksRemoved };
  }
}

// Singleton instance
export const musicService = new MusicService();
