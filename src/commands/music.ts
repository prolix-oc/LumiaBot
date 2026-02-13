import { 
  SlashCommandBuilder, 
  ChatInputCommandInteraction, 
  EmbedBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} from 'discord.js';
import { spotifyService } from '../services/spotify';
import { musicService, type MusicPlaylist } from '../services/music';
import type { Command } from '../bot/client';

const musicCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('music')
    .setDescription('Manage Lumia\'s music knowledge and playlists')
    .setDefaultMemberPermissions(PermissionFlagsBits.SendMessages)
    .addSubcommand(subcommand =>
      subcommand
        .setName('import')
        .setDescription('Import a Spotify playlist into Lumia\'s music knowledge')
        .addStringOption(option =>
          option
            .setName('url')
            .setDescription('Spotify playlist URL or ID')
            .setRequired(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('list')
        .setDescription('List all imported playlists')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('stats')
        .setDescription('Show music statistics and taste profile')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('taste')
        .setDescription('Generate a music taste description based on imported tracks')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('delete')
        .setDescription('Delete an imported playlist')
        .addIntegerOption(option =>
          option
            .setName('id')
            .setDescription('Playlist ID to delete (use /music list to see IDs)')
            .setRequired(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('search')
        .setDescription('Search for tracks in the music database')
        .addStringOption(option =>
          option
            .setName('query')
            .setDescription('Search for track or artist name')
            .setRequired(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('clear-all')
        .setDescription('⚠️ Delete ALL music data (admin only)')
    ) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction) {
  const subcommand = interaction.options.getSubcommand();

  try {
    switch (subcommand) {
      case 'import':
        await handleImport(interaction);
        break;
      case 'list':
        await handleList(interaction);
        break;
      case 'stats':
        await handleStats(interaction);
        break;
      case 'taste':
        await handleTaste(interaction);
        break;
      case 'delete':
        await handleDelete(interaction);
        break;
      case 'search':
        await handleSearch(interaction);
        break;
      case 'clear-all':
        await handleClearAll(interaction);
        break;
      default:
        await interaction.reply({
          content: '❓ Unknown subcommand!',
          ephemeral: true,
        });
    }
  } catch (error) {
    console.error('❌ [MUSIC COMMAND] Error:', error);
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    
    if (interaction.replied || interaction.deferred) {
      await interaction.editReply({
        content: `❌ Error: ${errorMessage}`,
      });
    } else {
      await interaction.reply({
        content: `❌ Error: ${errorMessage}`,
        ephemeral: true,
      });
    }
  }
  },
};

export default musicCommand;

async function handleImport(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  // Check if Spotify is configured
  if (!spotifyService.isAvailable()) {
    await interaction.editReply({
      content: '❌ Spotify is not configured. Please set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET environment variables.',
    });
    return;
  }

  const url = interaction.options.getString('url', true);
  
  // Extract playlist ID
  const playlistId = spotifyService.extractPlaylistId(url);
  if (!playlistId) {
    await interaction.editReply({
      content: '❌ Invalid Spotify playlist URL or ID. Please provide a valid Spotify playlist link.',
    });
    return;
  }

  // Check if already imported
  const existingPlaylist = musicService.getPlaylistBySpotifyId(playlistId);
  const isReimport = !!existingPlaylist;

  await interaction.editReply({
    content: `🎵 Fetching playlist from Spotify... ${isReimport ? '(This will update the existing import)' : ''}`,
  });

  try {
    // Fetch playlist from Spotify
    const spotifyPlaylist = await spotifyService.getPlaylist(playlistId);

    await interaction.editReply({
      content: `🎵 Found "${spotifyPlaylist.name}" with ${spotifyPlaylist.tracks.items.length} tracks. Importing...`,
    });

    // Import into database
    const result = await musicService.importPlaylist(
      spotifyPlaylist,
      spotifyPlaylist.tracks.items
    );

    // Create embed with results
    const embed = new EmbedBuilder()
      .setTitle(`🎵 Playlist ${isReimport ? 'Updated' : 'Imported'}!`)
      .setDescription(`**${spotifyPlaylist.name}**`)
      .setColor(isReimport ? 0xFFA500 : 0x1DB954) // Orange for update, Spotify green for new
      .setThumbnail(spotifyPlaylist.images[0]?.url || null)
      .addFields(
        { name: '📊 Tracks', value: `${result.importedTracks} total\n${result.newTracks} new · ${result.duplicateTracks} existing`, inline: true },
        { name: '🎤 Artists', value: `${result.newArtists} new\n${result.duplicateArtists} existing`, inline: true },
        { name: '💿 Albums', value: `${result.newAlbums} new\n${result.duplicateAlbums} existing`, inline: true },
        { name: '🎵 Total in DB', value: `${musicService.getStats().totalTracks} tracks`, inline: true },
        { name: '👤 Owner', value: spotifyPlaylist.owner.displayName, inline: true },
        { name: '🔗 Spotify', value: `[Open](https://open.spotify.com/playlist/${playlistId})`, inline: true }
      )
      .setFooter({ text: `Playlist ID: ${result.playlistId} • ${isReimport ? 'Updated' : 'Imported'} just now` });

    if (spotifyPlaylist.description) {
      embed.addFields({ name: '📝 Description', value: spotifyPlaylist.description.substring(0, 1024) });
    }

    await interaction.editReply({
      content: isReimport ? '✅ Playlist updated successfully!' : '✅ Playlist imported successfully!',
      embeds: [embed],
    });

  } catch (error) {
    console.error('❌ [MUSIC IMPORT] Error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to import playlist';
    
    await interaction.editReply({
      content: `❌ Failed to import playlist: ${errorMessage}`,
    });
  }
}

async function handleList(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const playlists = musicService.getAllPlaylists();

  if (playlists.length === 0) {
    await interaction.editReply({
      content: '🎵 No playlists imported yet! Use `/music import <spotify_url>` to add some music.',
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('🎵 Lumia\'s Music Collection')
    .setDescription(`${playlists.length} playlist(s) • ${musicService.getStats().totalTracks} total tracks`)
    .setColor(0x1DB954)
    .setFooter({ text: 'Use /music import to add more playlists' });

  const playlistFields = playlists.map((playlist: MusicPlaylist) => ({
    name: `${playlist.name} (ID: ${playlist.id})`,
    value: [
      `🎵 ${playlist.trackCount} tracks`,
      `👤 ${playlist.ownerName}`,
      `📅 Imported ${formatDate(playlist.importedAt)}`,
      playlist.imageUrl ? `[Cover](${playlist.imageUrl})` : '',
      `[Spotify](${playlist.spotifyUrl})`,
    ].filter(Boolean).join(' • '),
  }));

  // Discord has a limit of 25 fields per embed
  if (playlistFields.length <= 25) {
    embed.addFields(playlistFields);
    await interaction.editReply({ embeds: [embed] });
  } else {
    // Paginate if more than 25 playlists
    const pages: EmbedBuilder[] = [];
    for (let i = 0; i < playlistFields.length; i += 25) {
      const pageEmbed = new EmbedBuilder()
        .setTitle(`🎵 Lumia\'s Music Collection (Page ${Math.floor(i / 25) + 1})`)
        .setDescription(`${playlists.length} playlist(s) • ${musicService.getStats().totalTracks} total tracks`)
        .setColor(0x1DB954)
        .addFields(playlistFields.slice(i, i + 25));
      pages.push(pageEmbed);
    }

    if (pages.length === 0) {
      await interaction.editReply({
        content: '🎵 No playlists to display.',
      });
      return;
    }

    let currentPage = 0;

    const row = new ActionRowBuilder<ButtonBuilder>()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('prev')
          .setLabel('◀ Previous')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId('next')
          .setLabel('Next ▶')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(pages.length === 1)
      );

    const currentEmbed = pages[currentPage]!;
    const message = await interaction.editReply({
      embeds: [currentEmbed],
      components: [row],
    });

    const collector = message.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 60000,
    });

    collector.on('collect', async (i) => {
      if (i.user.id !== interaction.user.id) {
        await i.reply({ content: '❌ This button is not for you!', ephemeral: true });
        return;
      }

      if (i.customId === 'prev') {
        currentPage--;
      } else if (i.customId === 'next') {
        currentPage++;
      }

      row.components[0]!.setDisabled(currentPage === 0);
      row.components[1]!.setDisabled(currentPage === pages.length - 1);

      const updatedEmbed = pages[currentPage]!;
      await i.update({
        embeds: [updatedEmbed],
        components: [row],
      });
    });

    collector.on('end', () => {
      row.components.forEach(btn => btn.setDisabled(true));
      interaction.editReply({ components: [row] }).catch(() => {});
    });
  }
}

async function handleStats(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const stats = musicService.getStats();

  if (stats.totalTracks === 0) {
    await interaction.editReply({
      content: '🎵 No music in the database yet! Use `/music import <spotify_url>` to add some.',
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('🎵 Lumia\'s Music Stats')
    .setDescription('Current state of my musical knowledge')
    .setColor(0x1DB954)
    .addFields(
      { name: '📁 Playlists', value: `${stats.totalPlaylists}`, inline: true },
      { name: '🎵 Tracks', value: `${stats.totalTracks}`, inline: true },
      { name: '🎤 Artists', value: `${stats.totalArtists}`, inline: true },
      { name: '💿 Albums', value: `${stats.totalAlbums}`, inline: true }
    );

  // Top genres
  if (stats.topGenres.length > 0) {
    const genreText = stats.topGenres
      .slice(0, 10)
      .map((g, i) => `${i + 1}. ${g.genre} (${g.count} artists)`)
      .join('\n');
    
    embed.addFields({
      name: '🎸 Top Genres',
      value: genreText || 'No genre data available',
    });
  }

  // Top artists
  if (stats.topArtists.length > 0) {
    const artistText = stats.topArtists
      .slice(0, 10)
      .map((a, i) => `${i + 1}. ${a.artist.name} (${a.trackCount} tracks)`)
      .join('\n');
    
    embed.addFields({
      name: '⭐ Top Artists (by track count)',
      value: artistText || 'No artist data available',
    });
  }

  // All genres list
  const allGenres = musicService.getAllGenres();
  if (allGenres.length > 0) {
    const genreSummary = allGenres.slice(0, 20).join(', ');
    const moreText = allGenres.length > 20 ? ` (+${allGenres.length - 20} more)` : '';
    embed.addFields({
      name: `🎼 All Genres (${allGenres.length} total)`,
      value: genreSummary + moreText,
    });
  }

  await interaction.editReply({ embeds: [embed] });
}

async function handleTaste(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: false });

  const stats = musicService.getStats();

  if (stats.totalTracks === 0) {
    await interaction.editReply({
      content: '🎵 I don\'t have any music imported yet! Ask someone to `/music import` some Spotify playlists so I can develop my taste!',
    });
    return;
  }

  // Get random sample of tracks for taste generation
  const sampleTracks = musicService.getRandomTracks(20);
  
  // Get genre breakdown
  const genreCounts = new Map<string, number>();
  sampleTracks.forEach(track => {
    track.genres.forEach(genre => {
      genreCounts.set(genre, (genreCounts.get(genre) || 0) + 1);
    });
  });

  const topGenres = Array.from(genreCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  // Get unique artists
  const artists = [...new Set(sampleTracks.flatMap(t => t.artists.map(a => a.name)))];
  
  // Calculate average popularity
  const avgPopularity = Math.round(
    sampleTracks.reduce((sum, t) => sum + t.popularity, 0) / sampleTracks.length
  );

  // Create taste description
  let tasteDescription = '';
  
  if (topGenres.length > 0) {
    tasteDescription += `I'm really into **${topGenres.map(g => g[0]).join(', ')}** right now. `;
  }

  tasteDescription += `My collection has **${stats.totalTracks} tracks** across **${stats.totalPlaylists} playlists**. `;

  if (artists.length > 0) {
    const artistSample = artists.slice(0, 5).join(', ');
    tasteDescription += `I've been listening to artists like **${artistSample}**${artists.length > 5 ? ` and ${artists.length - 5} more` : ''}. `;
  }

  if (avgPopularity < 30) {
    tasteDescription += "I'm into pretty obscure stuff that most people haven't heard of.";
  } else if (avgPopularity < 60) {
    tasteDescription += "I like a mix of mainstream hits and hidden gems.";
  } else {
    tasteDescription += "I'm not afraid to admit I love popular music!";
  }

  const embed = new EmbedBuilder()
    .setTitle('🎵 My Music Taste')
    .setDescription(tasteDescription)
    .setColor(0x1DB954)
    .addFields(
      { 
        name: '🎭 Taste Profile', 
        value: [
          `Popularity: ${avgPopularity}/100`,
          `Main Genres: ${topGenres.length > 0 ? topGenres.map(g => g[0]).join(', ') : 'Mixed'}`,
          `Artist Diversity: ${stats.totalArtists} unique artists`,
        ].join('\n'),
      },
      {
        name: '🎲 Random Sample from My Collection',
        value: sampleTracks
          .slice(0, 5)
          .map(t => `• **${t.name}** - ${t.artists.map(a => a.name).join(', ')}`)
          .join('\n') || 'No tracks available',
      }
    )
    .setFooter({ text: 'These are tracks I actually know and can talk about!' });

  await interaction.editReply({ embeds: [embed] });
}

async function handleDelete(interaction: ChatInputCommandInteraction) {
  // Only admins can delete
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({
      content: '❌ Only administrators can delete playlists!',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const playlistId = interaction.options.getInteger('id', true);
  
  // Get playlist info before deleting
  const playlists = musicService.getAllPlaylists();
  const playlist = playlists.find(p => p.id === playlistId);

  if (!playlist) {
    await interaction.editReply({
      content: `❌ Playlist with ID ${playlistId} not found. Use \`/music list\` to see available playlists.`,
    });
    return;
  }

  // Create confirmation buttons
  const row = new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('confirm')
        .setLabel('✅ Yes, Delete')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('cancel')
        .setLabel('❌ Cancel')
        .setStyle(ButtonStyle.Secondary)
    );

  const confirmMessage = await interaction.editReply({
    content: `⚠️ Are you sure you want to delete "${playlist.name}"? This will remove the playlist association but keep the tracks in the database.`,
    components: [row],
  });

  const collector = confirmMessage.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 30000,
  });

  collector.on('collect', async (i) => {
    if (i.user.id !== interaction.user.id) {
      await i.reply({ content: '❌ This button is not for you!', ephemeral: true });
      return;
    }

    if (i.customId === 'confirm') {
      musicService.deletePlaylist(playlistId);
      await i.update({
        content: `✅ Deleted "${playlist.name}" from the playlist collection.`,
        components: [],
      });
    } else {
      await i.update({
        content: '❌ Deletion cancelled.',
        components: [],
      });
    }

    collector.stop();
  });

  collector.on('end', (collected) => {
    if (collected.size === 0) {
      interaction.editReply({
        content: '⏱️ Confirmation timed out. Playlist not deleted.',
        components: [],
      }).catch(() => {});
    }
  });
}

async function handleSearch(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const query = interaction.options.getString('query', true);
  const tracks = musicService.searchTracks(query, 10);

  if (tracks.length === 0) {
    await interaction.editReply({
      content: `🔍 No tracks found matching "${query}". Try a different search term!`,
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(`🔍 Search Results: "${query}"`)
    .setDescription(`Found ${tracks.length} track(s)`)
    .setColor(0x1DB954);

  const trackFields = tracks.map((track, i) => ({
    name: `${i + 1}. ${track.name}`,
    value: [
      `🎤 ${track.artists.map(a => a.name).join(', ')}`,
      `💿 ${track.album.name}`,
      track.genres.length > 0 ? `🎸 ${track.genres.slice(0, 3).join(', ')}` : '',
      `[Spotify](${track.spotifyUrl})`,
    ].filter(Boolean).join(' • '),
  }));

  embed.addFields(trackFields);

  await interaction.editReply({ embeds: [embed] });
}

async function handleClearAll(interaction: ChatInputCommandInteraction) {
  // Only admins can clear all
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({
      content: '❌ Only administrators can clear all music data!',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const stats = musicService.getStats();

  if (stats.totalPlaylists === 0 && stats.totalTracks === 0) {
    await interaction.editReply({
      content: '📭 Music database is already empty!',
    });
    return;
  }

  // Create confirmation buttons
  const row = new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('confirm-clear')
        .setLabel('⚠️ Yes, Delete Everything')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('cancel-clear')
        .setLabel('❌ Cancel')
        .setStyle(ButtonStyle.Secondary)
    );

  const confirmMessage = await interaction.editReply({
    content: `⚠️ **WARNING: This will DELETE ALL MUSIC DATA!**\n\nThis action cannot be undone.\n\n📊 Current data:\n• ${stats.totalPlaylists} playlists\n• ${stats.totalTracks} tracks\n• ${stats.totalArtists} artists\n• ${stats.totalAlbums} albums\n\nAre you absolutely sure?`,
    components: [row],
  });

  const collector = confirmMessage.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 30000,
  });

  collector.on('collect', async (i) => {
    if (i.user.id !== interaction.user.id) {
      await i.reply({ content: '❌ This button is not for you!', ephemeral: true });
      return;
    }

    if (i.customId === 'confirm-clear') {
      const deleted = musicService.clearAll();
      await i.update({
        content: `✅ **All music data deleted!**\n\n🗑️ Deleted:\n• ${deleted.playlistsDeleted} playlists\n• ${deleted.tracksDeleted} tracks\n• ${deleted.artistsDeleted} artists\n• ${deleted.albumsDeleted} albums`,
        components: [],
      });
    } else {
      await i.update({
        content: '❌ Clear operation cancelled.',
        components: [],
      });
    }

    collector.stop();
  });

  collector.on('end', (collected) => {
    if (collected.size === 0) {
      interaction.editReply({
        content: '⏱️ Confirmation timed out. No data was deleted.',
        components: [],
      }).catch(() => {});
    }
  });
}

function formatDate(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}
