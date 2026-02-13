import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { getAIService } from '../services/google-genai';
import { getErrorMessage } from '../services/prompts';
import type { Command } from '../bot/client';

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('chat')
    .setDescription('Chat with the AI assistant')
    .addStringOption((option) =>
      option
        .setName('message')
        .setDescription('Your message to the AI')
        .setRequired(true)
    )
    .addBooleanOption((option) =>
      option
        .setName('search')
        .setDescription('Enable web search for better answers')
        .setRequired(false)
    )
    .addAttachmentOption((option) =>
      option
        .setName('image')
        .setDescription('Attach an image for the AI to analyze')
        .setRequired(false)
    )
    .addAttachmentOption((option) =>
      option
        .setName('video')
        .setDescription('Attach a video for the AI to watch (Gemini 3 models only)')
        .setRequired(false)
    ) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction) {
    const message = interaction.options.getString('message', true);
    const enableSearch = interaction.options.getBoolean('search') ?? false;
    const imageAttachment = interaction.options.getAttachment('image');
    const videoAttachment = interaction.options.getAttachment('video');
    
    // Extract image URL if attachment is provided
    const imageUrls: string[] = [];
    if (imageAttachment && imageAttachment.contentType?.startsWith('image/')) {
      imageUrls.push(imageAttachment.url);
      console.log(`🖼️  [CHAT COMMAND] Image attached: ${imageAttachment.name} (${imageAttachment.contentType})`);
    }
    
    // Extract video URL if attachment is provided
    const videoUrls: { url: string; mimeType?: string }[] = [];
    if (videoAttachment && videoAttachment.contentType?.startsWith('video/')) {
      videoUrls.push({
        url: videoAttachment.url,
        mimeType: videoAttachment.contentType,
      });
      console.log(`🎥 [CHAT COMMAND] Video attached: ${videoAttachment.name} (${videoAttachment.contentType})`);
    }

    await interaction.deferReply();

    try {
      const aiService = getAIService();
      const response = await aiService.createChatCompletion({
        messages: [
          {
            role: 'user',
            content: message,
          },
        ],
        enableSearch,
        images: imageUrls,
        videos: videoUrls,
        userId: interaction.user.id,
        username: interaction.user.username,
        guildId: interaction.guildId || 'dm',
      });

      // Discord has a 2000 character limit for messages
      const truncatedResponse = response.length > 1900 
        ? response.slice(0, 1900) + '... (message truncated)' 
        : response;

      await interaction.editReply(truncatedResponse);
    } catch (error) {
      console.error('Chat command error:', error);
      await interaction.editReply(getErrorMessage('generic_error'));
    }
  },
};

export default command;
