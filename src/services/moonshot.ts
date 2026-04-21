import { config } from '../utils/config';

interface MoonshotBalance {
  cash_balance: number;
  voucher_balance: number;
  available_balance: number;
}

interface BalanceResponse {
  data: MoonshotBalance;
}

interface TokenEstimateResponse {
  data: {
    total_tokens: number;
  };
}

let lastBalance: MoonshotBalance | null = null;
let lastRequestCost: number | null = null;

/**
 * Currency symbol based on the Moonshot endpoint domain.
 * moonshot.ai reports in USD, moonshot.cn reports in Yuan.
 */
function getCurrencySymbol(): string {
  const baseUrl = (config.openai.baseUrl || '').toLowerCase();
  return baseUrl.includes('moonshot.cn') ? '¥' : '$';
}

export function getBalanceCurrency(): string {
  return getCurrencySymbol();
}

function getHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${config.openai.apiKey}`,
  };
}

function getBaseUrl(): string {
  return config.openai.baseUrl!.replace(/\/+$/, '');
}

/**
 * Fetch the baseline balance at startup so subsequent requests can compute cost deltas.
 */
export async function initBalance(): Promise<void> {
  try {
    const balance = await fetchBalance();
    if (balance) {
      lastBalance = balance;
      const c = getCurrencySymbol();
      console.log(
        `💰 [Moonshot] Startup balance — available: ${c}${balance.available_balance.toFixed(2)}, ` +
        `cash: ${c}${balance.cash_balance.toFixed(2)}, ` +
        `voucher: ${c}${balance.voucher_balance.toFixed(2)}`
      );
    }
  } catch (error) {
    console.warn(`⚠️ [Moonshot] Failed to fetch startup balance:`, error instanceof Error ? error.message : error);
  }
}

/**
 * Estimate token count for a set of messages via Moonshot's tokenizer endpoint.
 */
export async function estimateTokenCount(
  model: string,
  messages: Array<{ role: string; content: unknown }>,
  tools?: unknown[]
): Promise<number | null> {
  try {
    const url = `${getBaseUrl()}/tokenizers/estimate-token-count`;
    const body: Record<string, unknown> = { model, messages };
    if (tools && tools.length > 0) body.tools = tools;
    const res = await fetch(url, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      console.warn(`⚠️ [Moonshot] Token estimate failed: ${res.status} ${res.statusText}`);
      return null;
    }

    const json = (await res.json()) as TokenEstimateResponse;
    const totalTokens = json.data.total_tokens;
    console.log(`🔢 [Moonshot] Estimated prompt tokens: ${totalTokens}`);
    return totalTokens;
  } catch (error) {
    console.warn(`⚠️ [Moonshot] Token estimate error:`, error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Raw fetch of the balance endpoint.
 */
async function fetchBalance(): Promise<MoonshotBalance | null> {
  const url = `${getBaseUrl()}/users/me/balance`;
  const res = await fetch(url, {
    method: 'GET',
    headers: getHeaders(),
  });

  if (!res.ok) {
    console.warn(`⚠️ [Moonshot] Balance check failed: ${res.status} ${res.statusText}`);
    return null;
  }

  const json = (await res.json()) as BalanceResponse;
  return json.data;
}

/**
 * Fetch the current account balance, compute cost since last check, and store both.
 */
export async function checkBalance(): Promise<MoonshotBalance | null> {
  try {
    const newBalance = await fetchBalance();
    if (!newBalance) return null;

    // Compute cost delta if we have a previous balance to compare against
    if (lastBalance) {
      const cost = lastBalance.available_balance - newBalance.available_balance;
      // Only record positive costs (negative means a top-up happened)
      lastRequestCost = cost > 0 ? cost : 0;
      if (lastRequestCost > 0) {
        console.log(`💸 [Moonshot] Request cost: ${getCurrencySymbol()}${lastRequestCost.toFixed(4)}`);
      }
    }

    lastBalance = newBalance;
    const c = getCurrencySymbol();
    console.log(
      `💰 [Moonshot] Balance — available: ${c}${newBalance.available_balance.toFixed(2)}, ` +
      `cash: ${c}${newBalance.cash_balance.toFixed(2)}, ` +
      `voucher: ${c}${newBalance.voucher_balance.toFixed(2)}`
    );
    return newBalance;
  } catch (error) {
    console.warn(`⚠️ [Moonshot] Balance check error:`, error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Return the last fetched balance (or null if never fetched).
 */
export function getLastBalance(): MoonshotBalance | null {
  return lastBalance;
}

/**
 * Return the cost of the most recent request (or null if not yet computed).
 */
export function getLastRequestCost(): number | null {
  return lastRequestCost;
}
