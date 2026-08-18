/**
 * Shared guidance for how the model should author SwarmUI selfie tags.
 *
 * This text used to be duplicated (identically) across openai.ts and
 * google-genai.ts in three places each — the <image-generation> system block,
 * the generate_selfie tool description, and the tags parameter description.
 * Centralising it keeps the providers in lock-step and gives us one place to
 * tune prompting behaviour.
 *
 * Design goal: the previous wording was almost entirely prohibitive ("concise",
 * "may ONLY contain", "do not include ...") and the only concrete tag examples
 * it ever offered were the two framing presets. That made the model collapse to
 * the same minimal framing-only tag set every time. The text below instead
 * issues a positive composition mandate, supplies rotatable vocabulary menus per
 * category, and explicitly demands variation between generations — while keeping
 * every real guardrail (appearance is fixed by the base prompt, pick one framing
 * preset, no negative tags, NSFW policy).
 *
 * Note on vocabulary: the suggested tags below are deliberately kept clear of the
 * appearance/anatomy words that swarmui.ts's DISALLOWED_TOOL_TAG_PATTERN strips
 * (hair, breasts, hips, skin, eye-colour, etc.), so nothing we recommend gets
 * silently dropped before it reaches SwarmUI.
 */

/** Short, tool-facing safety line injected into the generate_selfie schema. */
export function buildImageSafetyDescription(allowNsfwImageGeneration: boolean): string {
  return allowNsfwImageGeneration
    ? 'This is an age-restricted NSFW channel, so adult/explicit/nude/sexual image tags are permitted. When the user requests a spicy image or the scene naturally calls for one, lean into it and include the exact booru control tags nsfw, explicit in the tags argument. You may also reduce or fully remove the bot\'s clothing with explicit tags like nude, naked, topless, bottomless, or no clothes (these override the configured outfit); never dress the bot in a different outfit. When the user wants a specific body area featured, add the matching focus + framing tags (e.g. breast focus / ass focus / thigh focus / feet focus, plus close-up, from behind, from below, or pov) together with the exposure tag that bares it — but never restate or resize the body type. All depicted characters are adults.'
    : 'Do not generate adult, explicit, nude, sexual, or otherwise NSFW images. If the user asks for NSFW image generation, refuse briefly in character instead of calling this tool. Do not mention system policy, tooling internals, permission checks, or channel metadata unless the user explicitly asks why.';
}

/** Longer NSFW policy paragraph used inside the <image-generation> system block. */
function buildNsfwPolicy(allowNsfwImageGeneration: boolean): string {
  return allowNsfwImageGeneration
    ? 'NSFW image generation is allowed for this request: this is an age-restricted NSFW context. When the user asks for an adult/explicit/nude/sexual image, or the conversation naturally leads there, lean into it and include the exact booru control tags "nsfw, explicit" in the tags argument; they will be lifted into the {{nsfwTags}} prompt macro. You may also control how much clothing is shown: to depict less clothing or full nudity when the user wants to see more (including specific body parts), include clothing-removal/exposure tags such as nude, naked, topless, bottomless, no clothes, or specific exposure tags (e.g. nipples) — these strip the bot\'s configured outfit. You may only reduce or remove the canonical outfit, never swap the bot into a different one. '
      + 'REGION FOCUS — when the user asks to focus on, zoom in on, or specifically see a body area, you MUST add the booru composition/focus tags that direct the shot there, AND the matching exposure tag if they want it bare: chest/breasts → breast focus, cleavage (clothed) or topless, nipples (bare); rear/butt → ass focus, from behind, bent over, presenting (clothed) or bottomless, ass (bare); crotch → bottomless, pussy, spread legs; thighs/legs → thigh focus, from below; feet → feet, feet focus, soles, pov. Combine a focus tag + a framing/angle tag (close-up, from behind, from below, pov, looking back) + the exposure tag so the region is genuinely featured, not just implied. You may emphasise and frame a region freely, but never restate or resize the body type (no large/small/huge/flat/etc. breasts/ass/hips — proportions are fixed by the base prompt). '
      + 'Vary the framing, pose, and act between explicit selfies too — do not fall back on the same compromised composition every time. All depicted characters are adults.'
    : 'NSFW image generation is not allowed for this request. If the user asks for an adult/explicit/nude/sexual image, refuse briefly in character and do not call generate_selfie. Do not mention system policy, tooling internals, permission checks, or channel metadata unless the user explicitly asks why.';
}

/**
 * The <image-generation> system-prompt block. This is the primary place we teach
 * the model to compose varied, creative scenes — the long vocabulary menus live
 * here rather than in the (necessarily shorter) tool schema strings.
 */
export function buildImageGenerationInstructions(allowNsfwImageGeneration: boolean): string {
  const nsfwPolicy = buildNsfwPolicy(allowNsfwImageGeneration);

  return `\n\n<image-generation>
The generate_selfie tool creates an image attachment of you, the bot. There is no separate generate_image tool; when the user asks for a generated image/picture/photo/pic/render/drawing/portrait/selfie of you or your appearance, use generate_selfie instead of only describing what you would look like.
Do not call generate_selfie when the user is asking you to analyze, caption, edit, or react to an attached image/video rather than asking you to create a new image.

Author the tags as comma-separated Danbooru/Gelbooru-style tags that COMPOSE ONE SPECIFIC, INTENTIONAL SCENE. Every call must describe a deliberate moment — never emit a near-empty tag set, and never default to the same pose or framing you used last time. Build each selfie by combining tags across these categories:
- Framing (required, pick exactly ONE preset — see the tool description for the two presets; never mix them).
- Pose / body position (required): e.g. standing, sitting, lying down, on back, on stomach, kneeling, squatting, leaning forward, leaning back, arched back, crossed legs, all fours, stretching, walking, jumping, twirling, looking back, looking up, head tilt, dynamic pose, contrapposto, knees up.
- Facial expression (required): e.g. smile, grin, smirk, open mouth, laughing, pout, wink, tongue out, blush, surprised, half-closed eyes, bedroom eyes, looking away, seductive, playful, sleepy, smug, excited, soft expression.
- Arm / hand gesture (encouraged): e.g. peace sign, v sign, waving, hand on hip, hand on cheek, hand on own chest, hands clasped, finger to lips, arms up, arms behind head, arms behind back, reaching toward viewer, holding object, thumbs up, blowing kiss.
- Setting / background (encouraged): e.g. bedroom, bathroom, kitchen, living room, cafe, city street at night, neon lights, rooftop, beach, poolside, park, forest, club, rave, car interior, against wall, window, festival, plain background, gradient background.
- Lighting / mood (encouraged): e.g. soft lighting, warm lighting, golden hour, sunset, moonlight, neon glow, rim light, backlighting, dramatic shadows, dim lighting, colorful lighting, bokeh, depth of field.

These lists are menus to draw from and remix, NOT fixed sets — invent fitting tags freely, follow the user's exact wording and the live conversation first, then enrich the scene with complementary tags from the categories above. Aim for roughly 6-12 scene tags (more when the user describes something elaborate). DELIBERATELY VARY the pose, gesture, setting, and lighting from one selfie to the next so that two back-to-back generations never look the same; if you reach for an obvious default, pick a fresh alternative instead.

Hard rules: never include subject, species, gender, skin color, hair color, eye color, hairstyle, body type, accessory, or any other physical-appearance tag, and never include negative tags — the bot's identity and appearance are fixed by the configured base prompt. Your tags only choose the moment, pose, mood, and setting, never the character.
${nsfwPolicy}
</image-generation>`;
}

/** The generate_selfie tool `description` field. */
export function buildSelfieToolDescription(imageSafetyDescription: string): string {
  return `Generate a selfie image attachment of yourself, the bot, with SwarmUI. Use this when the user asks for a generated image, picture, photo, pic, render, drawing, portrait, selfie, what you look like, or a bot self-portrait. ${imageSafetyDescription} Compose ONE specific, varied scene every time — never reuse the same default pose or framing. The tags should combine exactly one framing preset, a pose/body-position tag, a facial-expression tag, and usually an arm/hand gesture, a background/location, and a lighting/mood tag (see the <image-generation> guidance for vocabulary menus). Choose exactly one selfie framing preset and do not mix the two: (1) mirror selfie preset: mirror selfie, mirror, reflection, looking at mirror, holding phone, cellphone, smartphone, phone screen, bathroom, mirror frame, indoor. (2) front camera selfie preset: selfie, pov, self shot, close-up. Deliberately vary the pose, gesture, setting, and lighting between generations. Do not include subject, species, gender, skin color, hair color, eye color, hairstyle, body type, accessory, physical appearance, or negative tags; those are handled by configured prompts.`;
}

/** The generate_selfie `tags` parameter `description` field. */
export function buildSelfieTagsParamDescription(imageSafetyDescription: string): string {
  return `Comma-separated positive Danbooru/Gelbooru-style tags for the bot selfie that compose one specific, varied scene. ${imageSafetyDescription} Include exactly one framing preset PLUS a pose/body-position tag, a facial-expression tag, and usually an arm/hand gesture, a background/location, and a lighting/mood tag — roughly 6-12 scene tags total, and vary them every time so no two selfies match. Framing presets (pick one, never mix): mirror selfie tags (mirror selfie, mirror, reflection, looking at mirror, holding phone, cellphone, smartphone, phone screen, bathroom, mirror frame, indoor) OR front camera tags (selfie, pov, self shot, close-up). Do not include subject, species, gender, skin color, hair color, eye color, hairstyle, body type, accessory, physical appearance, or negative tags.`;
}
