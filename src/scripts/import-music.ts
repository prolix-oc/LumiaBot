#!/usr/bin/env bun
/**
 * Backend Music Import Script
 * Import Spotify playlists without using Discord slash commands
 * 
 * Usage:
 *   bun run src/scripts/import-music.ts <spotify_playlist_url>
 *   bun run src/scripts/import-music.ts https://open.spotify.com/playlist/...
 * 
 * Or import multiple from a file:
 *   bun run src/scripts/import-music.ts --file playlists.txt
 * 
 * Or clear all music data:
 *   bun run src/scripts/import-music.ts --clear-all
 */

import { spotifyService } from '../services/spotify';
import { musicService } from '../services/music';
import * as fs from 'fs';
import * as path from 'path';

interface ImportResult {
  success: boolean;
  playlistName?: string;
  playlistId?: number;
  trackCount?: number;
  newArtists?: number;
  error?: string;
}

/**
 * Import a single playlist from Spotify URL
 */
export async function importPlaylist(url: string): Promise<ImportResult> {
  console.log(`🎵 Importing playlist from: ${url}`);

  // Check if Spotify is configured
  if (!spotifyService.isAvailable()) {
    return {
      success: false,
      error: 'Spotify is not configured. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET environment variables.',
    };
  }

  // Extract playlist ID
  const playlistId = spotifyService.extractPlaylistId(url);
  if (!playlistId) {
    return {
      success: false,
      error: 'Invalid Spotify playlist URL or ID',
    };
  }

  // Check if already imported
  const existingPlaylist = musicService.getPlaylistBySpotifyId(playlistId);
  const isReimport = !!existingPlaylist;

  if (isReimport) {
    console.log(`📝 Playlist "${existingPlaylist!.name}" already exists, will update...`);
  }

  try {
    // Fetch from Spotify
    console.log('📡 Fetching playlist from Spotify API...');
    const spotifyPlaylist = await spotifyService.getPlaylist(playlistId);
    console.log(`✅ Found: "${spotifyPlaylist.name}" with ${spotifyPlaylist.tracks.items.length} tracks`);

    // Import to database
    console.log('💾 Importing to database...');
    const result = await musicService.importPlaylist(
      spotifyPlaylist,
      spotifyPlaylist.tracks.items
    );

    console.log(`✅ ${isReimport ? 'Updated' : 'Imported'} "${spotifyPlaylist.name}"`);
    console.log(`   📊 Tracks: ${result.importedTracks} (${result.newTracks} new · ${result.duplicateTracks} existing)`);
    console.log(`   🎤 Artists: ${result.newArtists} new · ${result.duplicateArtists} existing`);
    console.log(`   💿 Albums: ${result.newAlbums} new · ${result.duplicateAlbums} existing`);
    console.log(`   🆔 Database ID: ${result.playlistId}`);

    return {
      success: true,
      playlistName: spotifyPlaylist.name,
      playlistId: result.playlistId,
      trackCount: result.importedTracks,
      newArtists: result.newArtists,
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`❌ Error importing playlist: ${errorMessage}`);
    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Import multiple playlists from an array of URLs
 */
export async function importMultiplePlaylists(urls: string[]): Promise<ImportResult[]> {
  console.log(`🎵 Importing ${urls.length} playlist(s)...\n`);
  
  const results: ImportResult[] = [];
  
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i]!.trim();
    if (!url) continue;
    
    console.log(`\n[${i + 1}/${urls.length}] Processing: ${url}`);
    const result = await importPlaylist(url);
    results.push(result);
    
    // Small delay to avoid rate limiting
    if (i < urls.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  return results;
}

/**
 * Import playlists from a text file (one URL per line)
 */
export async function importFromFile(filePath: string): Promise<ImportResult[]> {
  console.log(`📁 Reading playlists from: ${filePath}`);
  
  const fullPath = path.resolve(filePath);
  
  if (!fs.existsSync(fullPath)) {
    console.error(`❌ File not found: ${fullPath}`);
    return [{
      success: false,
      error: `File not found: ${fullPath}`,
    }];
  }

  const content = fs.readFileSync(fullPath, 'utf-8');
  const urls = content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));

  console.log(`📝 Found ${urls.length} playlist URL(s) in file\n`);
  
  return importMultiplePlaylists(urls);
}

/**
 * Show current music database statistics
 */
export function showStats(): void {
  const stats = musicService.getStats();
  
  console.log('\n📊 MUSIC DATABASE STATISTICS');
  console.log('═══════════════════════════════');
  console.log(`📁 Playlists: ${stats.totalPlaylists}`);
  console.log(`🎵 Tracks: ${stats.totalTracks}`);
  console.log(`🎤 Artists: ${stats.totalArtists}`);
  console.log(`💿 Albums: ${stats.totalAlbums}`);
  
  if (stats.topGenres.length > 0) {
    console.log('\n🎸 Top Genres:');
    stats.topGenres.slice(0, 10).forEach((g, i) => {
      console.log(`   ${i + 1}. ${g.genre} (${g.count} artists)`);
    });
  }

  if (stats.topArtists.length > 0) {
    console.log('\n⭐ Top Artists (by track count):');
    stats.topArtists.slice(0, 10).forEach((a, i) => {
      console.log(`   ${i + 1}. ${a.artist.name} (${a.trackCount} tracks)`);
    });
  }

  console.log('\n');
}

/**
 * List all imported playlists
 */
export function listPlaylists(): void {
  const playlists = musicService.getAllPlaylists();
  
  console.log('\n📋 IMPORTED PLAYLISTS');
  console.log('═══════════════════════');
  
  if (playlists.length === 0) {
    console.log('No playlists imported yet.\n');
    return;
  }

  playlists.forEach((playlist, i) => {
    console.log(`\n[${i + 1}] ${playlist.name}`);
    console.log(`    ID: ${playlist.id}`);
    console.log(`    Spotify ID: ${playlist.spotifyId}`);
    console.log(`    Tracks: ${playlist.trackCount}`);
    console.log(`    Owner: ${playlist.ownerName}`);
    console.log(`    Imported: ${new Date(playlist.importedAt).toLocaleDateString()}`);
    console.log(`    URL: ${playlist.spotifyUrl}`);
  });

  console.log('\n');
}

/**
 * Clear all music data from the database
 */
export function clearAllMusic(): { success: boolean; deleted?: { playlistsDeleted: number; tracksDeleted: number; artistsDeleted: number; albumsDeleted: number }; error?: string } {
  try {
    console.log('\n⚠️  WARNING: This will DELETE ALL music data!');
    console.log('   This includes all playlists, tracks, artists, and albums.\n');
    
    const stats = musicService.getStats();
    
    if (stats.totalPlaylists === 0 && stats.totalTracks === 0) {
      console.log('📭 Music database is already empty.\n');
      return { success: true, deleted: { playlistsDeleted: 0, tracksDeleted: 0, artistsDeleted: 0, albumsDeleted: 0 } };
    }
    
    console.log('📊 Current music database:');
    console.log(`   📁 Playlists: ${stats.totalPlaylists}`);
    console.log(`   🎵 Tracks: ${stats.totalTracks}`);
    console.log(`   🎤 Artists: ${stats.totalArtists}`);
    console.log(`   💿 Albums: ${stats.totalAlbums}\n`);
    
    const deleted = musicService.clearAll();
    
    console.log('\n✅ Successfully cleared all music data!\n');
    
    return { success: true, deleted };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`❌ Error clearing music data: ${errorMessage}\n`);
    return { success: false, error: errorMessage };
  }
}

// CLI execution
if (import.meta.main) {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log(`
🎵 Lumia Music Import Tool
═══════════════════════════

Usage:
  bun run src/scripts/import-music.ts <spotify_url>     Import a single playlist
  bun run src/scripts/import-music.ts --file <path>     Import from file (one URL per line)
  bun run src/scripts/import-music.ts --stats           Show database statistics
  bun run src/scripts/import-music.ts --list            List all imported playlists
  bun run src/scripts/import-music.ts --clear-all       ⚠️  Delete ALL music data

Examples:
  bun run src/scripts/import-music.ts https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M
  bun run src/scripts/import-music.ts --file ./my-playlists.txt
  bun run src/scripts/import-music.ts --stats
  bun run src/scripts/import-music.ts --clear-all

Note:
  Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in your .env file first!
`);
    process.exit(0);
  }

  const command = args[0]!;

  // Handle commands
  (async () => {
    switch (command) {
      case '--stats':
        showStats();
        break;
      
      case '--list':
        listPlaylists();
        break;

      case '--clear-all':
        clearAllMusic();
        break;
      
      case '--file':
        if (!args[1]) {
          console.error('❌ Please provide a file path: --file <path>');
          process.exit(1);
        }
        const results = await importFromFile(args[1]);
        
        // Summary
        const successful = results.filter(r => r.success).length;
        const failed = results.filter(r => !r.success).length;
        
        console.log(`\n📊 IMPORT SUMMARY`);
        console.log(`   ✅ Successful: ${successful}`);
        console.log(`   ❌ Failed: ${failed}`);
        
        if (failed > 0) {
          console.log('\n❌ FAILED IMPORTS:');
          results.filter(r => !r.success).forEach(r => {
            console.log(`   - ${r.error}`);
          });
        }
        break;
      
      default:
        // Assume it's a URL
        if (command.startsWith('http') || command.startsWith('spotify:')) {
          const result = await importPlaylist(command);
          if (!result.success) {
            console.error(`❌ Import failed: ${result.error}`);
            process.exit(1);
          }
        } else {
          console.error(`❌ Unknown command: ${command}`);
          console.error('Use --help for usage information');
          process.exit(1);
        }
    }
  })();
}

export default {
  importPlaylist,
  importMultiplePlaylists,
  importFromFile,
  showStats,
  listPlaylists,
  clearAllMusic,
};
