/**
 * Bot Definition Loader
 * 
 * This module provides backwards compatibility for code that imports from './bot-definition'.
 * The actual prompt loading logic has been moved to '../services/prompts' for better organization.
 * 
 * For new code, prefer importing directly from '../services/prompts' to access:
 * - getBotIdentity() - Get the full bot persona/identity
 * - getErrorMessage() - Get error message templates
 * - getCommandResponse() - Get command response templates
 * - And more dynamic prompt functions
 */

import { getBotIdentity, reloadPrompts } from '../services/prompts';

let cachedDefinition: string | null = null;

/**
 * Load the bot definition from prompt storage
 * @deprecated Use getBotIdentity() from '../services/prompts' instead
 */
export function loadBotDefinition(): string {
  // Return cached definition if already loaded
  if (cachedDefinition !== null) {
    return cachedDefinition;
  }

  const identity = getBotIdentity();
  cachedDefinition = identity;
  return cachedDefinition;
}

/**
 * Reload the bot definition from disk
 * @deprecated Use reloadPrompts() from '../services/prompts' instead
 */
export function reloadBotDefinition(): string {
  cachedDefinition = null;
  reloadPrompts();
  return loadBotDefinition();
}

/**
 * Get the cached bot definition
 * @deprecated Use getBotIdentity() from '../services/prompts' instead
 */
export function getBotDefinition(): string {
  return cachedDefinition || loadBotDefinition();
}
