const TALENT_API_BASE = 'https://api.talentprotocol.com/api/v2';
const TALENT_SEARCH_BASE = 'https://api.talentprotocol.com/search/advanced';

function getApiKey(): string {
  const key = process.env.TALENT_API_KEY;
  if (!key) {
    throw new Error('TALENT_API_KEY environment variable is not set');
  }
  return key;
}

function headers(): Record<string, string> {
  return {
    'X-API-KEY': getApiKey(),
    'Accept': 'application/json',
  };
}

function jsonHeaders(): Record<string, string> {
  return {
    ...headers(),
    'Content-Type': 'application/json',
  };
}

export interface HumanCheckmarkResult {
  isHuman: boolean;
  walletAddress: string;
  raw: any;
}

export interface BuilderScoreResult {
  score: number;
  walletAddress: string;
  raw: any;
}

export interface CredentialsResult {
  credentials: any[];
  walletAddress: string;
  raw: any;
}

export interface TalentProfile {
  id: string;
  walletAddress: string;
  displayName: string | null;
  bio: string | null;
  raw: any;
}

export interface WalletCheckResult {
  found: boolean;
  isHuman: boolean;
  builderScore: number;
  talentId: string | null;
  displayName: string | null;
  walletAddress: string;
  source: 'v2' | 'search';
  raw: any;
}

async function getHumanCheckmarkV2(walletAddress: string): Promise<HumanCheckmarkResult> {
  const res = await fetch(`${TALENT_API_BASE}/human_checkmark?id=${encodeURIComponent(walletAddress)}`, {
    method: 'GET',
    headers: headers(),
  });

  console.log(`[talent-api] V2 human_checkmark for ${walletAddress}: ${res.status}`);

  if (!res.ok) {
    const text = await res.text();
    console.log(`[talent-api] V2 human_checkmark response body: ${text.substring(0, 300)}`);
    throw new Error(`V2 human_checkmark failed (${res.status}): ${text.substring(0, 200)}`);
  }

  const data = await res.json();
  return {
    isHuman: data.human_checkmark === true,
    walletAddress,
    raw: data,
  };
}

async function getProfileV2(walletAddress: string): Promise<TalentProfile & { score: number }> {
  const res = await fetch(`${TALENT_API_BASE}/passports/${encodeURIComponent(walletAddress)}`, {
    method: 'GET',
    headers: headers(),
  });

  console.log(`[talent-api] V2 passports for ${walletAddress}: ${res.status}`);

  if (!res.ok) {
    const text = await res.text();
    console.log(`[talent-api] V2 passports response body: ${text.substring(0, 300)}`);
    throw new Error(`V2 passports failed (${res.status}): ${text.substring(0, 200)}`);
  }

  const data = await res.json();
  const passport = data.passport || data;
  return {
    id: passport.id?.toString() || passport.main_wallet || walletAddress,
    walletAddress,
    displayName: passport.display_name || passport.name || null,
    bio: passport.bio || null,
    score: passport.score ?? passport.builder_score ?? 0,
    raw: data,
  };
}

async function searchProfileByWallet(walletAddress: string): Promise<WalletCheckResult> {
  const searchParams = {
    query: {
      customQuery: {
        bool: {
          must: [
            { term: { "main_wallet.keyword": walletAddress.toLowerCase() } }
          ]
        }
      }
    },
    per_page: 1
  };

  const url = `${TALENT_SEARCH_BASE}/profiles?query=${encodeURIComponent(JSON.stringify(searchParams.query))}&per_page=1`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: headers(),
    });
  } catch (netErr: any) {
    console.log(`[talent-api] Search API network error: ${netErr.message}`);
    throw new Error(`Cannot reach Talent Protocol Search API: ${netErr.message}`);
  }

  console.log(`[talent-api] Search profiles for ${walletAddress}: ${res.status}`);

  if (!res.ok) {
    const text = await res.text();
    console.log(`[talent-api] Search response body: ${text.substring(0, 300)}`);
    throw new Error(`Search API failed (${res.status}): ${text.substring(0, 200)}`);
  }

  const data = await res.json();
  const profiles = data.profiles || data.items || data.results || [];

  if (!profiles.length) {
    return {
      found: false,
      isHuman: false,
      builderScore: 0,
      talentId: null,
      displayName: null,
      walletAddress,
      source: 'search',
      raw: data,
    };
  }

  const profile = profiles[0];
  return {
    found: true,
    isHuman: profile.human_checkmark === true,
    builderScore: profile.score ?? profile.builder_score ?? 0,
    talentId: profile.id?.toString() || null,
    displayName: profile.display_name || profile.name || null,
    walletAddress,
    source: 'search',
    raw: data,
  };
}

export async function checkWalletStatus(walletAddress: string): Promise<WalletCheckResult> {
  try {
    return await searchProfileByWallet(walletAddress);
  } catch (searchErr: any) {
    console.log(`[talent-api] Search API failed: ${searchErr.message}`);

    try {
      const [checkmark, profile] = await Promise.all([
        getHumanCheckmarkV2(walletAddress),
        getProfileV2(walletAddress),
      ]);

      return {
        found: true,
        isHuman: checkmark.isHuman,
        builderScore: profile.score,
        talentId: profile.id,
        displayName: profile.displayName,
        walletAddress,
        source: 'v2',
        raw: { checkmark: checkmark.raw, profile: profile.raw },
      };
    } catch (v2Err: any) {
      console.log(`[talent-api] V2 API also failed: ${v2Err.message}`);
      throw new Error(
        `Could not look up wallet on Talent Protocol. ` +
        `Search API: ${searchErr.message}. ` +
        `V2 API: ${v2Err.message}`
      );
    }
  }
}

export async function getHumanCheckmark(walletAddress: string): Promise<HumanCheckmarkResult> {
  const result = await checkWalletStatus(walletAddress);
  return {
    isHuman: result.isHuman,
    walletAddress,
    raw: result.raw,
  };
}

export async function getBuilderScore(walletAddress: string): Promise<BuilderScoreResult> {
  const result = await checkWalletStatus(walletAddress);
  return {
    score: result.builderScore,
    walletAddress,
    raw: result.raw,
  };
}

export async function getCredentials(walletAddress: string): Promise<CredentialsResult> {
  let res: Response;
  try {
    res = await fetch(`${TALENT_API_BASE}/passports/${encodeURIComponent(walletAddress)}/credentials`, {
      method: 'GET',
      headers: headers(),
    });
  } catch (netErr: any) {
    return { credentials: [], walletAddress, raw: null };
  }

  if (!res.ok) {
    return { credentials: [], walletAddress, raw: null };
  }

  const data = await res.json();
  return {
    credentials: data.credentials || data.passport_credentials || [],
    walletAddress,
    raw: data,
  };
}

export async function getProfile(walletAddress: string): Promise<TalentProfile> {
  const result = await checkWalletStatus(walletAddress);
  return {
    id: result.talentId || walletAddress,
    walletAddress,
    displayName: result.displayName,
    bio: null,
    raw: result.raw,
  };
}
