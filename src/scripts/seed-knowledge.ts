/**
 * Example seed script for the knowledge graph
 * Run this to add sample documents for testing
 * 
 * Usage: bun run src/scripts/seed-knowledge.ts
 */

import { knowledgeGraphService } from '../services/knowledge-graph';

console.log('🌱 Seeding knowledge base with example documents...\n');

// Example documents about Lucid Loom
const exampleDocuments = [
  {
    topic: 'lucid-loom',
    title: 'What is Lucid Loom?',
    content: `Lucid Loom is a carefully curated preset designed for immersive character interactions. It emphasizes natural, flowing conversations that feel organic and engaging. The preset is built with specific goals in mind: creating deep character connections, maintaining narrative consistency, and enabling complex roleplay scenarios.

Key Features:
- Natural dialogue flow that mimics real conversation
- Strong character voice consistency
- Support for multi-turn narratives
- Enhanced emotional depth and expression
- Built-in safeguards for staying in character

The preset is particularly popular among users who want their AI characters to feel alive and responsive, with personalities that evolve naturally through conversation.`,
    keywords: ['loom', 'lucid loom', 'll', 'preset', 'character', 'roleplay', 'ai', 'persona'],
    type: 'document' as const,
    priority: 9,
  },
  {
    topic: 'lucid-loom',
    title: 'Lucid Loom Setup Guide',
    content: `Getting started with Lucid Loom is straightforward! Here are the basic steps:

1. Download the Lucid Loom preset files from the official repository
2. Import the preset into your AI platform (SillyTavern, Oobabooga, etc.)
3. Configure your character using the LL formatting guidelines
4. Adjust temperature and sampling settings for optimal results
5. Start your first conversation and refine based on responses

Pro Tips:
- Start with a simple character concept and build complexity gradually
- Use the example character cards as templates
- Pay attention to the formatting - it matters for consistency
- Don't be afraid to tweak the system prompt for your specific use case

The community is super helpful if you get stuck! Just ask in the Discord.`,
    keywords: ['setup', 'guide', 'install', 'configure', 'getting started', 'tutorial', 'help'],
    type: 'document' as const,
    priority: 8,
  },
  {
    topic: 'lucid-loom',
    title: 'Official Lucid Loom Repository',
    content: `The official Lucid Loom repository contains all preset files, documentation, example characters, and community resources.`,
    keywords: ['repository', 'github', 'download', 'official', 'source'],
    type: 'link' as const,
    url: 'https://github.com/lucid-loom/presets',
    priority: 10,
  },
  {
    topic: 'lucid-loom',
    title: 'Character Card Format',
    content: `Lucid Loom uses a specific character card format to ensure maximum compatibility and performance. The format includes:

Required Fields:
- name: Character's display name
- description: Physical appearance and personality
- personality: Core character traits
- scenario: Current situation/context
- first_mes: Opening message

Optional Fields:
- mes_example: Example dialogue
- creatorcomment: Notes for the user
- tags: Categories and descriptors
- creator: Your name/alias

The LL format emphasizes brevity and clarity over lengthy descriptions. Aim for concise but evocative writing that gives the AI room to improvise while staying true to the character essence.`,
    keywords: ['character card', 'format', 'json', 'fields', 'structure', 'template'],
    type: 'document' as const,
    priority: 8,
  },
  {
    topic: 'lucid-loom',
    title: 'Best Practices for LL Characters',
    content: `Creating great characters with Lucid Loom requires understanding some key principles:

Character Depth vs Complexity:
- Focus on 2-3 core personality traits rather than listing dozens
- Let the AI fill in gaps naturally through conversation
- Provide motivations and goals, not just descriptions

Writing Style:
- Use active, present-tense descriptions
- Avoid overly flowery or purple prose
- Show, don't tell - demonstrate personality through examples
- Keep descriptions under 500 words when possible

Testing and Iteration:
- Test your character with various conversation starters
- Note where they break character and refine those areas
- Get feedback from the community
- Iterate based on actual usage, not theory

Remember: The goal is a character that feels alive, not one that's exhaustively documented!`,
    keywords: ['best practices', 'tips', 'advice', 'character creation', 'writing', 'guide'],
    type: 'document' as const,
    priority: 7,
  },
];

try {
  // Check if documents already exist
  const existingStats = knowledgeGraphService.getStats();
  
  if (existingStats.totalDocuments > 0) {
    console.log(`⚠️  Knowledge base already has ${existingStats.totalDocuments} documents.`);
    console.log('Do you want to add example documents anyway? (y/n)');
    
    // For automation, just add them
    console.log('Adding example documents...\n');
  }

  // Add each document
  for (const doc of exampleDocuments) {
    knowledgeGraphService.storeDocument(doc);
    console.log(`✅ Added: "${doc.title}" (${doc.topic})`);
  }

  console.log('\n🎉 Successfully seeded knowledge base!');
  
  // Show final stats
  const stats = knowledgeGraphService.getStats();
  console.log(`\n📊 Knowledge Base Stats:`);
  console.log(`   Total Documents: ${stats.totalDocuments}`);
  console.log(`   Topics: ${stats.totalTopics}`);
  
  const topics = knowledgeGraphService.listTopics();
  console.log(`\n📁 Topics: ${topics.join(', ')}`);
  
  console.log('\n💡 Try asking Lumia about "Loom", "Lucid Loom", or "LL" to test!');
  
} catch (error) {
  console.error('❌ Error seeding knowledge base:', error);
  process.exit(1);
}
