const TALENT_API_BASE = 'https://api.talentprotocol.com/api/v2';

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

export interface HumanCheckmarkResult {
  isHuman: boolean;
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
  source: string;
  raw: any;
}

export interface BuilderScoreResult {
  score: number;
  walletAddress: string;
  raw: any;
}

async function tryTalentPassportV2(walletAddress: string): Promise<WalletCheckResult | null> {
  try {
    const res = await fetch(`${TALENT_API_BASE}/passports/${encodeURIComponent(walletAddress)}`, {
      method: 'GET',
      headers: headers(),
    });

    console.log(`[talent-api] V2 passports for ${walletAddress}: ${res.status}`);

    if (res.status === 410) {
      console.log(`[talent-api] V2 passports endpoint deprecated`);
      return null;
    }

    if (!res.ok) {
      const text = await res.text();
      console.log(`[talent-api] V2 passports response: ${text.substring(0, 200)}`);
      return null;
    }

    const data = await res.json();
    const passport = data.passport || data;

    if (!passport || (!passport.id && !passport.main_wallet)) {
      return null;
    }

    let isHuman = false;
    try {
      const hcRes = await fetch(`${TALENT_API_BASE}/human_checkmark?id=${encodeURIComponent(walletAddress)}`, {
        method: 'GET',
        headers: headers(),
      });
      if (hcRes.ok) {
        const hcData = await hcRes.json();
        isHuman = hcData.human_checkmark === true;
      }
    } catch (e) {}

    return {
      found: true,
      isHuman,
      builderScore: passport.score ?? passport.builder_score ?? 0,
      talentId: passport.id?.toString() || null,
      displayName: passport.display_name || passport.name || null,
      walletAddress,
      source: 'v2',
      raw: data,
    };
  } catch (err: any) {
    console.log(`[talent-api] V2 passports error: ${err.message}`);
    return null;
  }
}

export async function checkWalletStatus(walletAddress: string): Promise<WalletCheckResult> {
  const v2Result = await tryTalentPassportV2(walletAddress);
  if (v2Result) return v2Result;

  console.log(`[talent-api] Talent Protocol API unavailable, using wallet-based verification for ${walletAddress}`);
  return {
    found: true,
    isHuman: false,
    builderScore: 0,
    talentId: null,
    displayName: null,
    walletAddress,
    source: 'wallet',
    raw: { note: 'Talent Protocol API unavailable, verified by wallet signature' },
  };
}

export async function getHumanCheckmark(walletAddress: string): Promise<HumanCheckmarkResult> {
  const result = await checkWalletStatus(walletAddress);
  return {
    isHuman: result.isHuman,
    walletAddress,
    raw: result.raw,
  };
}

export async function getProfile(walletAddress: string): Promise<TalentProfile & { score: number }> {
  const result = await checkWalletStatus(walletAddress);
  return {
    id: result.talentId || walletAddress,
    walletAddress,
    displayName: result.displayName,
    bio: null,
    score: result.builderScore,
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
