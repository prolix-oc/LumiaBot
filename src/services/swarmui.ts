import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadJsonFile, loadTextFile } from './prompts';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export interface GeneratedImageAttachment {
  data: Buffer;
  name: string;
  contentType: string;
  prompt: string;
}

interface SwarmConfig {
  enabled?: boolean;
  apiUrl?: string;
  baseUrl?: string;
  url?: string;
  apiKey?: string;
  token?: string;
  model?: string;
  timeoutMs?: number;
  outputFilename?: string;
  images?: number;
  booruTagSeparator?: 'underscores' | 'spaces';
  parameters?: Record<string, unknown>;
  rawRequestOverride?: Record<string, unknown>;
  [key: string]: unknown;
}

interface SessionEntry {
  sessionId: string;
  expiresAt: number;
}

const SESSION_TTL_MS = 25 * 60 * 1000;
const CONFIG_PATH = 'config/swarm_cfg.json';
const POSITIVE_PROMPT_PATH = 'config/image_prompt_pos.txt';
const NEGATIVE_PROMPT_PATH = 'config/image_prompt_neg.txt';
const NSFW_CONTROL_TAGS = new Set(['nsfw', 'explicit']);

// Tags signalling the model wants to remove or expose clothing. They bypass the
// normal clothing/anatomy filter (so they survive into the prompt) AND cause the
// configured outfit block ({{outfit}}...{{/outfit}}) to be stripped from the base
// prompt so the canonical outfit no longer fights the nudity tags. They only reach
// this point when NSFW image generation is permitted, since the upstream
// isNsfwImagePrompt() guard refuses them otherwise.
const NUDITY_CONTROL_PATTERN = /\b(?:completely nude|fully nude|partially nude|nude|naked|nudity|topless|bottomless|undressed|undressing|no clothes|no clothing|bare breasts|exposed breasts|bare chest|nipples?|areolae?|pussy|vulva|vagina|clitoris|labia|anus)\b/i;

const NSFW_IMAGE_TAG_PATTERN = /\b(?:nsfw|explicit|rating[:_ -]?explicit|rating[:_ -]?questionable|nude|naked|nudity|topless|bottomless|sex|sexual|sexually|intercourse|penetration|oral|blowjob|handjob|cum|semen|ejaculat\w*|orgasm|masturbat\w*|genital\w*|vagina|vulva|penis|cock|dick|pussy|nipples?|areolae?|breasts?|boobs?|ass|butt|spread legs|cameltoe|upskirt|panties|lingerie|bdsm|bondage|fetish|porn|pornographic|erotic|hentai)\b/i;
const DISALLOWED_TOOL_TAG_PATTERN = /\b(?:1girl|1boy|solo|female|male|woman|man|girl|boy|skin|pale|tan|dark skin|light skin|brown skin|black skin|white skin|hair|hairstyle|bangs|ponytail|twintails|braid|ahoge|blonde|brunette|redhead|blue eyes|green eyes|brown eyes|red eyes|purple eyes|pink eyes|yellow eyes|gray eyes|grey eyes|black eyes|white eyes|shirt|dress|skirt|pants|jeans|shorts|jacket|coat|hoodie|sweater|uniform|suit|tie|gloves|socks|shoes|boots|heels|hat|cap|collar|choker|panties|bra|lingerie|underwear|bikini|swimsuit|breasts?|boobs?|nipples?|areolae?|ass|butt|hips|thighs|genitals?|vagina|vulva|penis|cock|dick|pussy|petite|curvy|muscular|slim|fat|tall|short)\b/i;

// Anatomical regions the model may legitimately FRAME or FOCUS a shot on. The
// DISALLOWED pattern above blocks these same words to stop the model redefining the
// bot's fixed body — but "ass focus" / "breast focus" / "from behind" describe
// composition, not identity. When a tag matches this pattern (and carries no
// size/shape adjective — see BODY_SHAPE_PATTERN) we keep it so region-focused
// requests actually reach SwarmUI. These tags are NSFW-gated upstream by
// isNsfwImagePrompt(), so the explicit ones only arrive when NSFW is permitted.
// Unlike NUDITY_CONTROL_PATTERN they do NOT strip the outfit — baring a region still
// requires a separate exposure tag.
const ANATOMY_REGION =
  'ass|asses|butt|buttocks|breast|breasts|boob|boobs|chest|cleavage|side ?boob|under ?boob|' +
  'nipple|nipples|areola|areolae|thigh|thighs|hip|hips|leg|legs|feet|foot|sole|soles|toe|toes|' +
  'navel|belly|stomach|abs|midriff|back|shoulder|shoulders|armpit|armpits|crotch|groin|pussy|vulva|vagina|cameltoe';
const ANATOMY_FOCUS_PATTERN = new RegExp(
  '\\b(?:' +
    '(?:' + ANATOMY_REGION + ') ?focus|' +              // "ass focus", "breast focus"
    'focus on (?:' + ANATOMY_REGION + ')|' +            // "focus on ass"
    'presenting|bent over|spread (?:legs|ass|pussy|anus|thighs)|top-down bottom-up|' +
    'from (?:behind|below|above|side)|looking back|downblouse|downpants|ass visible through thighs|' +
    ANATOMY_REGION +                                    // bare region noun, e.g. "ass", "breasts"
  ')\\b',
  'i',
);
// Size / shape descriptors that DO redefine the bot's fixed body. A tag matching
// ANATOMY_FOCUS_PATTERN is only kept when it does NOT also match this — so "ass focus"
// survives but "huge ass" / "large breasts" / "thicc thighs" fall through to the
// DISALLOWED filter, leaving body proportions to the configured base prompt.
const BODY_SHAPE_PATTERN =
  /\b(?:large|larger|largest|huge|big|bigger|biggest|giant|gigantic|massive|enormous|oversized|small|smaller|smallest|tiny|little|flat|petite|curvy|curvaceous|voluptuous|thicc|thick|busty|buxom|slim|slender|skinny|lean|fat|chubby|plump|wide|narrow|tall|short|saggy|perky)\b/i;

export function isNsfwImagePrompt(tags: string): boolean {
  return NSFW_IMAGE_TAG_PATTERN.test(tags.replace(/[_-]+/g, ' '));
}

class SwarmUIService {
  private sessions = new Map<string, SessionEntry>();

  isConfigured(): boolean {
    const cfg = this.getConfig(false);
    return !!cfg && cfg.enabled !== false && !!this.getBaseUrl(cfg);
  }

  async generateSelfie(toolTags: string): Promise<GeneratedImageAttachment> {
    const cfg = this.getConfig();
    if (!cfg || cfg.enabled === false) {
      throw new Error('SwarmUI image generation is not configured.');
    }

    const baseUrl = this.getBaseUrl(cfg);
    if (!baseUrl) {
      throw new Error('SwarmUI config must include apiUrl, baseUrl, or url.');
    }

    const token = this.getToken(cfg);
    const timeoutMs = this.getNumber(cfg.timeoutMs, 120_000);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const sessionId = await this.getSession(baseUrl, token, controller.signal);
      const prompt = this.buildPositivePrompt(cfg, toolTags);
      const negativePrompt = loadTextFile(NEGATIVE_PROMPT_PATH, false) || '';
      const body = this.buildGenerateBody(sessionId, cfg, prompt, negativePrompt);

      const res = await fetch(`${baseUrl}/API/GenerateText2Image`, {
        method: 'POST',
        headers: this.buildHeaders(token),
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => res.statusText);
        throw new Error(`SwarmUI image generation failed: ${res.status} ${errorText}`);
      }

      const data = await res.json() as Record<string, unknown>;
      if (data.error || data.error_id) {
        throw new Error(`SwarmUI error: ${String(data.error || data.error_id)}`);
      }

      const imagePath = this.extractImagePath(data);
      if (!imagePath) {
        throw new Error('SwarmUI returned no images.');
      }

      const image = await this.fetchImage(baseUrl, imagePath, token, controller.signal);
      return {
        ...image,
        name: this.getOutputFilename(cfg, image.contentType),
        prompt,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private getConfig(useCache: boolean = false): SwarmConfig | null {
    if (!existsSync(join(__dirname, '..', '..', 'prompt_storage', CONFIG_PATH))) {
      return null;
    }

    return loadJsonFile<SwarmConfig>(CONFIG_PATH, useCache);
  }

  private getBaseUrl(cfg: SwarmConfig): string {
    const url = cfg.apiUrl || cfg.baseUrl || cfg.url || 'http://localhost:7801';
    return String(url).replace(/\/+$/, '');
  }

  private getToken(cfg: SwarmConfig): string | undefined {
    const token = cfg.apiKey || cfg.token;
    return token ? String(token) : undefined;
  }

  private buildHeaders(token?: string): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Cookie = `swarm_token=${token}`;
    return headers;
  }

  private async getSession(baseUrl: string, token: string | undefined, signal: AbortSignal): Promise<string> {
    const key = `${baseUrl}\0${token || ''}`;
    const cached = this.sessions.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.sessionId;
    }

    const res = await fetch(`${baseUrl}/API/GetNewSession`, {
      method: 'POST',
      headers: this.buildHeaders(token),
      body: '{}',
      signal,
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => res.statusText);
      throw new Error(`SwarmUI session request failed: ${res.status} ${errorText}`);
    }

    const data = await res.json() as Record<string, unknown>;
    const sessionId = data.session_id;
    if (typeof sessionId !== 'string' || !sessionId) {
      throw new Error('SwarmUI returned no session_id.');
    }

    this.sessions.set(key, { sessionId, expiresAt: Date.now() + SESSION_TTL_MS });
    return sessionId;
  }

  private buildPositivePrompt(cfg: SwarmConfig, toolTags: string): string {
    const { toolTags: normalizedTags, nsfwTags, removeOutfit } = this.preparePromptTags(cfg, toolTags);
    const template = loadTextFile(POSITIVE_PROMPT_PATH, false);
    if (!template) {
      return [normalizedTags, nsfwTags].filter(Boolean).join(', ');
    }

    return this.applyOutfitBlock(template, removeOutfit)
      .replace(/\{\{\s*toolTags\s*\}\}/g, normalizedTags)
      .replace(/\{toolTags\}/g, normalizedTags)
      .replace(/\{\{\s*nsfwTags\s*\}\}/g, nsfwTags)
      .replace(/\{nsfwTags\}/g, nsfwTags)
      .replace(/,\s*,+/g, ',')
      .replace(/^\s*,\s*/, '')
      .replace(/,\s*$/, '')
      .trim();
  }

  /**
   * Resolve the optional {{outfit}}...{{/outfit}} block in the positive prompt
   * template. The block wraps the bot's canonical clothing tags; when the model
   * requests nudity/exposure we strip it entirely so the outfit no longer fights
   * the nudity tags, otherwise we keep its contents and drop only the markers.
   */
  private applyOutfitBlock(template: string, removeOutfit: boolean): string {
    const outfitBlock = /\{\{\s*outfit\s*\}\}([\s\S]*?)\{\{\s*\/\s*outfit\s*\}\}/gi;
    return template.replace(outfitBlock, (_match, inner) => (removeOutfit ? '' : inner));
  }

  private preparePromptTags(cfg: SwarmConfig, toolTags: string): { toolTags: string; nsfwTags: string; removeOutfit: boolean } {
    const normalizedTags = this.normalizeBooruTags(cfg, toolTags);
    const regularTags: string[] = [];
    const nsfwTags: string[] = [];
    let removeOutfit = false;

    for (const tag of normalizedTags) {
      const normalized = tag.replace(/[_-]+/g, ' ').toLowerCase();
      if (NSFW_CONTROL_TAGS.has(normalized)) {
        nsfwTags.push(tag);
      } else if (NUDITY_CONTROL_PATTERN.test(normalized)) {
        // Clothing-removal / exposure control: keep the tag (bypassing the normal
        // clothing/anatomy filter) and strip the configured outfit block.
        regularTags.push(tag);
        removeOutfit = true;
      } else if (this.isAnatomyFocusTag(normalized)) {
        // Region framing/emphasis (ass focus, breast focus, from behind, …). Keep it
        // so the shot can target the area the user asked for, but do NOT strip the
        // outfit — baring the region still requires an explicit exposure tag above.
        regularTags.push(tag);
      } else if (this.isAllowedToolTag(tag)) {
        regularTags.push(tag);
      } else {
        console.log(`🖼️  [SwarmUI] Dropping disallowed generated tag: ${tag}`);
      }
    }

    // When nudity is requested, ensure the explicit rating control tags are present
    // so the model renders it rather than implying it under remaining cloth.
    if (removeOutfit) {
      for (const control of ['nsfw', 'explicit']) {
        if (!nsfwTags.some((tag) => tag.toLowerCase() === control)) {
          nsfwTags.push(control);
        }
      }
    }

    return {
      toolTags: regularTags.join(', '),
      nsfwTags: nsfwTags.join(', '),
      removeOutfit,
    };
  }

  private isAllowedToolTag(tag: string): boolean {
    return !DISALLOWED_TOOL_TAG_PATTERN.test(tag.replace(/_/g, ' '));
  }

  /**
   * Region-focus / composition tags (e.g. "ass focus", "breast focus", "from behind")
   * that DISALLOWED_TOOL_TAG_PATTERN would otherwise strip. Kept so region-targeted
   * requests work, but rejected when the tag also carries a size/shape adjective so
   * the model can't redefine the bot's fixed proportions. Expects an already
   * separator-normalised, lowercased tag (underscores/dashes → spaces).
   */
  private isAnatomyFocusTag(normalized: string): boolean {
    return ANATOMY_FOCUS_PATTERN.test(normalized) && !BODY_SHAPE_PATTERN.test(normalized);
  }

  private normalizeBooruTags(cfg: SwarmConfig, toolTags: string): string[] {
    const separator = cfg.booruTagSeparator || 'underscores';
    const tags = toolTags.trim();

    return tags
      .split(',')
      .map((tag) => {
        const trimmed = tag.trim();
        return separator === 'spaces'
          ? trimmed.replace(/_/g, ' ')
          : trimmed.replace(/\s+/g, '_');
      })
      .filter(Boolean)
      .filter((tag, index, list) => list.findIndex((candidate) => candidate.toLowerCase() === tag.toLowerCase()) === index);
  }

  private buildGenerateBody(
    sessionId: string,
    cfg: SwarmConfig,
    prompt: string,
    negativePrompt: string,
  ): Record<string, unknown> {
    const parameters = cfg.parameters && typeof cfg.parameters === 'object' ? cfg.parameters : {};
    const body: Record<string, unknown> = {
      session_id: sessionId,
      images: this.getNumber(cfg.images ?? parameters.images, 1),
      prompt,
      aspectratio: String(parameters.aspectratio || cfg.aspectratio || 'Custom'),
    };

    if (cfg.model) body.model = String(cfg.model);
    if (negativePrompt) body.negativeprompt = negativePrompt;

    this.copyNumber(body, 'width', cfg.width ?? parameters.width);
    this.copyNumber(body, 'height', cfg.height ?? parameters.height);
    this.copyNumber(body, 'steps', cfg.steps ?? parameters.steps);
    this.copyNumber(body, 'cfgscale', cfg.cfgScale ?? cfg.cfgscale ?? parameters.cfgScale ?? parameters.cfgscale);
    this.copyNumber(body, 'seed', cfg.seed ?? parameters.seed);
    this.copyString(body, 'sampler', cfg.sampler ?? parameters.sampler);
    this.copyString(body, 'scheduler', cfg.scheduler ?? parameters.scheduler);
    this.copyString(body, 'vae', cfg.vae ?? parameters.vae);
    this.copyString(body, 'cliplmodel', cfg.clipLModel ?? parameters.clipLModel);
    this.copyString(body, 'clipgmodel', cfg.clipGModel ?? parameters.clipGModel);
    this.copyString(body, 'txxlmodel', cfg.t5XXLModel ?? parameters.t5XXLModel);
    this.copyString(body, 'qwenmodel', cfg.qwenModel ?? parameters.qwenModel);
    this.copyString(body, 'mistralmodel', cfg.mistralModel ?? parameters.mistralModel);
    this.copyString(body, 'gemmamodel', cfg.gemmaModel ?? parameters.gemmaModel);
    this.copyString(body, 'llamamodel', cfg.llamaModel ?? parameters.llamaModel);
    this.copyCommaValue(body, 'loras', cfg.loras ?? parameters.loras);
    this.copyCommaValue(body, 'loraweights', cfg.loraWeights ?? parameters.loraWeights);

    const rawOverride = cfg.rawRequestOverride || parameters.rawRequestOverride;
    if (rawOverride && typeof rawOverride === 'object' && !Array.isArray(rawOverride)) {
      Object.assign(body, rawOverride);
    }

    return body;
  }

  private extractImagePath(data: Record<string, unknown>): string | null {
    if (Array.isArray(data.images) && typeof data.images[0] === 'string') return data.images[0];
    if (typeof data.image === 'string') return data.image;
    if (typeof data.output === 'string') return data.output;
    if (Array.isArray(data.outputs) && typeof data.outputs[0] === 'string') return data.outputs[0];
    return null;
  }

  private async fetchImage(
    baseUrl: string,
    imagePath: string,
    token: string | undefined,
    signal: AbortSignal,
  ): Promise<{ data: Buffer; contentType: string }> {
    if (imagePath.startsWith('data:')) {
      const match = imagePath.match(/^data:([^;]+);base64,(.*)$/s);
      if (!match) throw new Error('SwarmUI returned an unsupported data URL.');
      return { data: Buffer.from(match[2]!, 'base64'), contentType: match[1]! };
    }

    const url = `${baseUrl}/${imagePath.replace(/^\/+/, '')}`;
    const headers: Record<string, string> = {};
    if (token) headers.Cookie = `swarm_token=${token}`;

    const res = await fetch(url, { headers, signal });
    if (!res.ok) {
      throw new Error(`Failed to fetch SwarmUI image: ${res.status}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    return {
      data: Buffer.from(arrayBuffer),
      contentType: res.headers.get('content-type') || 'image/png',
    };
  }

  private getOutputFilename(cfg: SwarmConfig, contentType: string): string {
    if (cfg.outputFilename) return String(cfg.outputFilename);
    const extension = contentType.includes('jpeg') ? 'jpg' : contentType.includes('webp') ? 'webp' : 'png';
    return `swarmui-${Date.now()}.${extension}`;
  }

  private getNumber(value: unknown, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private copyNumber(body: Record<string, unknown>, key: string, value: unknown): void {
    if (value === undefined || value === null || value === '') return;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) body[key] = parsed;
  }

  private copyString(body: Record<string, unknown>, key: string, value: unknown): void {
    if (value === undefined || value === null || value === '') return;
    body[key] = String(value);
  }

  private copyCommaValue(body: Record<string, unknown>, key: string, value: unknown): void {
    if (value === undefined || value === null || value === '') return;
    body[key] = Array.isArray(value) ? value.map(String).join(',') : String(value);
  }
}

export const swarmUIService = new SwarmUIService();
