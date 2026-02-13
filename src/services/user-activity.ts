import { ActivityType, Guild, GuildMember, Activity } from 'discord.js';

/**
 * Interface representing a user's Spotify listening activity
 */
export interface SpotifyActivity {
  trackName: string;
  artistName: string;
  albumName?: string;
  trackId: string;
  isPlaying: boolean;
  startTimestamp?: number;
  endTimestamp?: number;
  duration?: number;
  partySize?: number;
  partyMax?: number;
  albumArtUrl?: string;
}

/**
 * Interface representing any music listening activity (Spotify or other)
 */
export interface MusicActivity {
  source: 'spotify' | 'other';
  trackName?: string;
  artistName?: string;
  albumName?: string;
  state: string;
  details?: string;
  isPlaying: boolean;
  timestamps?: {
    start?: number;
    end?: number;
  };
}

/**
 * Service for detecting and tracking user activities from Discord presence
 */
export class UserActivityService {
  /**
   * Check if an activity is a Spotify listening activity
   */
  private isSpotifyActivity(activity: Activity): boolean {
    return activity.name === 'Spotify' && activity.type === ActivityType.Listening;
  }

  /**
   * Check if an activity is any music listening activity
   */
  private isMusicActivity(activity: Activity): boolean {
    return activity.type === ActivityType.Listening;
  }

  /**
   * Parse Spotify activity details
   */
  private parseSpotifyActivity(activity: Activity): SpotifyActivity | null {
    if (!this.isSpotifyActivity(activity)) {
      return null;
    }

    // Extract track info from activity
    const trackName = activity.details || 'Unknown Track';
    const artistName = activity.state || 'Unknown Artist';
    const albumName = activity.assets?.largeText || undefined;
    
    // Get Spotify track ID from sync_id
    const trackId = activity.syncId || '';
    
    // Check if currently playing (has timestamps)
    const isPlaying = !!activity.timestamps?.start;
    
    // Get timestamps
    const startTimestamp = activity.timestamps?.start?.getTime();
    const endTimestamp = activity.timestamps?.end?.getTime();
    
    // Calculate duration if we have both start and end
    let duration: number | undefined;
    if (startTimestamp && endTimestamp) {
      duration = endTimestamp - startTimestamp;
    }

    // Get party info (for shared listening)
    const partySize = activity.party?.size?.[0];
    const partyMax = activity.party?.size?.[1];

    // Get album art URL (if available)
    const albumArtUrl = activity.assets?.largeImageURL({ size: 512 }) || 
                       activity.assets?.largeImageURL({ size: 256 }) || undefined;

    return {
      trackName,
      artistName,
      albumName,
      trackId,
      isPlaying,
      startTimestamp,
      endTimestamp,
      duration,
      partySize,
      partyMax,
      albumArtUrl,
    };
  }

  /**
   * Parse any music listening activity
   */
  private parseMusicActivity(activity: Activity): MusicActivity | null {
    if (!this.isMusicActivity(activity)) {
      return null;
    }

    const isSpotify = this.isSpotifyActivity(activity);
    
    return {
      source: isSpotify ? 'spotify' : 'other',
      trackName: activity.details || undefined,
      artistName: activity.state || undefined,
      albumName: activity.assets?.largeText || undefined,
      state: activity.state || '',
      details: activity.details || undefined,
      isPlaying: !!activity.timestamps?.start,
      timestamps: activity.timestamps ? {
        start: activity.timestamps.start?.getTime(),
        end: activity.timestamps.end?.getTime(),
      } : undefined,
    };
  }

  /**
   * Get the current Spotify activity for a guild member
   */
  getSpotifyActivity(member: GuildMember): SpotifyActivity | null {
    if (!member.presence) {
      return null;
    }

    const activities = member.presence.activities;
    const spotifyActivity = activities.find(activity => this.isSpotifyActivity(activity));

    if (!spotifyActivity) {
      return null;
    }

    return this.parseSpotifyActivity(spotifyActivity);
  }

  /**
   * Get any current music listening activity for a guild member
   */
  getMusicActivity(member: GuildMember): MusicActivity | null {
    if (!member.presence) {
      return null;
    }

    const activities = member.presence.activities;
    const musicActivity = activities.find(activity => this.isMusicActivity(activity));

    if (!musicActivity) {
      return null;
    }

    return this.parseMusicActivity(musicActivity);
  }

  /**
   * Check if a member is currently listening to music (Spotify or other)
   */
  isListeningToMusic(member: GuildMember): boolean {
    if (!member.presence) {
      return false;
    }

    return member.presence.activities.some(activity => this.isMusicActivity(activity));
  }

  /**
   * Check if a member is currently listening to Spotify specifically
   */
  isListeningToSpotify(member: GuildMember): boolean {
    if (!member.presence) {
      return false;
    }

    return member.presence.activities.some(activity => this.isSpotifyActivity(activity));
  }

  /**
   * Get a formatted description of what the user is listening to
   */
  formatListeningDescription(member: GuildMember): string | null {
    const activity = this.getMusicActivity(member);
    
    if (!activity) {
      return null;
    }

    if (activity.source === 'spotify' && activity.trackName && activity.artistName) {
      return `"${activity.trackName}" by ${activity.artistName}`;
    } else if (activity.trackName) {
      return activity.trackName;
    } else if (activity.state) {
      return activity.state;
    }

    return 'music';
  }

  /**
   * Get Spotify track URL from track ID
   */
  getSpotifyTrackUrl(trackId: string): string {
    return `https://open.spotify.com/track/${trackId}`;
  }

  /**
   * Get all activities for a guild member
   */
  getAllActivities(member: GuildMember): Activity[] {
    if (!member.presence) {
      return [];
    }

    return [...member.presence.activities];
  }

  /**
   * Format a Spotify activity for display in the bot's response
   */
  formatSpotifyForBot(spotify: SpotifyActivity): string {
    let text = `🎵 **Now Playing:** "${spotify.trackName}" by ${spotify.artistName}`;
    
    if (spotify.albumName) {
      text += `\n💿 Album: ${spotify.albumName}`;
    }
    
    if (spotify.duration) {
      const minutes = Math.floor(spotify.duration / 60000);
      const seconds = Math.floor((spotify.duration % 60000) / 1000);
      text += `\n⏱️ Duration: ${minutes}:${seconds.toString().padStart(2, '0')}`;
    }
    
    if (spotify.trackId) {
      text += `\n🔗 ${this.getSpotifyTrackUrl(spotify.trackId)}`;
    }

    return text;
  }

  /**
   * Get a fun commentary about what someone is listening to
   * This can be used to generate contextual responses
   */
  getListeningCommentary(spotify: SpotifyActivity): string {
    const track = spotify.trackName || 'something';
    const artist = spotify.artistName || 'someone';
    
    const commentaries: string[] = [
      `I see you're vibing to "${track}"!`,
      `"${track}" by ${artist} - solid choice!`,
      `Ooh, listening to ${artist}? Nice taste!`,
      `Is that "${track}" I see? Great track!`,
      `Currently jamming to: ${track} 🎧`,
    ];

    return commentaries[Math.floor(Math.random() * commentaries.length)] || 'Nice tunes!';
  }
}

// Export singleton instance
export const userActivityService = new UserActivityService();
