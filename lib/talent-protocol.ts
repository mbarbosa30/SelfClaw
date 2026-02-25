const TALENT_API_BASE = 'https://api.talentprotocol.com';

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

async function fetchProfileV3(walletAddress: string): Promise<{ id: string | null; displayName: string | null; raw: any } | null> {
  try {
    const res = await fetch(`${TALENT_API_BASE}/profile?id=${encodeURIComponent(walletAddress)}`, {
      method: 'GET',
      headers: headers(),
    });

    console.log(`[talent-api] v3 /profile for ${walletAddress}: ${res.status}`);

    if (!res.ok) {
      const text = await res.text();
      console.log(`[talent-api] v3 /profile response: ${text.substring(0, 200)}`);
      return null;
    }

    const data = await res.json();
    const profile = data.profile || data;
    return {
      id: profile.id?.toString() || profile.talent_id?.toString() || null,
      displayName: profile.display_name || profile.name || null,
      raw: data,
    };
  } catch (err: any) {
    console.log(`[talent-api] v3 /profile error: ${err.message}`);
    return null;
  }
}

async function fetchHumanCheckmarkV3(walletAddress: string): Promise<boolean | null> {
  try {
    const res = await fetch(`${TALENT_API_BASE}/human_checkmark?id=${encodeURIComponent(walletAddress)}`, {
      method: 'GET',
      headers: headers(),
    });

    console.log(`[talent-api] v3 /human_checkmark for ${walletAddress}: ${res.status}`);

    if (!res.ok) {
      const text = await res.text();
      console.log(`[talent-api] v3 /human_checkmark response: ${text.substring(0, 200)}`);
      return null;
    }

    const data = await res.json();
    return data.humanity_verified === true;
  } catch (err: any) {
    console.log(`[talent-api] v3 /human_checkmark error: ${err.message}`);
    return null;
  }
}

async function fetchBuilderScoreV3(walletAddress: string): Promise<{ points: number; rank: number } | null> {
  try {
    const res = await fetch(`${TALENT_API_BASE}/score?id=${encodeURIComponent(walletAddress)}`, {
      method: 'GET',
      headers: headers(),
    });

    console.log(`[talent-api] v3 /score for ${walletAddress}: ${res.status}`);

    if (!res.ok) {
      const text = await res.text();
      console.log(`[talent-api] v3 /score response: ${text.substring(0, 200)}`);
      return null;
    }

    const data = await res.json();
    const score = data.score || {};
    return {
      points: score.points ?? 0,
      rank: score.rank_position ?? 0,
    };
  } catch (err: any) {
    console.log(`[talent-api] v3 /score error: ${err.message}`);
    return null;
  }
}

export async function checkWalletStatus(walletAddress: string): Promise<WalletCheckResult> {
  const [profile, humanCheckmark, builderScore] = await Promise.all([
    fetchProfileV3(walletAddress),
    fetchHumanCheckmarkV3(walletAddress),
    fetchBuilderScoreV3(walletAddress),
  ]);

  const profileFound = profile !== null;
  const isHuman = humanCheckmark === true;
  const score = builderScore?.points ?? 0;

  if (profileFound) {
    console.log(`[talent-api] Wallet ${walletAddress}: profile found, human=${isHuman}, score=${score}`);
    return {
      found: true,
      isHuman,
      builderScore: score,
      talentId: profile.id,
      displayName: profile.displayName,
      walletAddress,
      source: 'talent',
      raw: { profile: profile.raw, humanCheckmark, builderScore },
    };
  }

  if (humanCheckmark !== null || builderScore !== null) {
    console.log(`[talent-api] Wallet ${walletAddress}: partial data, human=${isHuman}, score=${score}`);
    return {
      found: true,
      isHuman,
      builderScore: score,
      talentId: null,
      displayName: null,
      walletAddress,
      source: 'talent',
      raw: { humanCheckmark, builderScore },
    };
  }

  console.log(`[talent-api] Wallet ${walletAddress}: API unavailable, using wallet-only fallback`);
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
