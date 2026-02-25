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

export async function getHumanCheckmark(walletAddress: string): Promise<HumanCheckmarkResult> {
  let res: Response;
  try {
    res = await fetch(`${TALENT_API_BASE}/human_checkmark?id=${encodeURIComponent(walletAddress)}`, {
      method: 'GET',
      headers: headers(),
    });
  } catch (netErr: any) {
    throw new Error(`Cannot reach Talent Protocol API: ${netErr.message}`);
  }

  if (res.status === 404) {
    throw new Error(`No Talent Protocol Passport found for wallet ${walletAddress}. Create one at talentprotocol.com`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error('Talent Protocol API key is invalid or expired');
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Talent API error (${res.status}): ${text}`);
  }

  const data = await res.json();
  return {
    isHuman: data.human_checkmark === true,
    walletAddress,
    raw: data,
  };
}

export async function getBuilderScore(walletAddress: string): Promise<BuilderScoreResult> {
  const res = await fetch(`${TALENT_API_BASE}/passports/${encodeURIComponent(walletAddress)}`, {
    method: 'GET',
    headers: headers(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Talent API builder score failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  const passport = data.passport || data;
  return {
    score: passport.score ?? passport.builder_score ?? 0,
    walletAddress,
    raw: data,
  };
}

export async function getCredentials(walletAddress: string): Promise<CredentialsResult> {
  const res = await fetch(`${TALENT_API_BASE}/passports/${encodeURIComponent(walletAddress)}/credentials`, {
    method: 'GET',
    headers: headers(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Talent API credentials failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  return {
    credentials: data.credentials || data.passport_credentials || [],
    walletAddress,
    raw: data,
  };
}

export async function getProfile(walletAddress: string): Promise<TalentProfile> {
  let res: Response;
  try {
    res = await fetch(`${TALENT_API_BASE}/passports/${encodeURIComponent(walletAddress)}`, {
      method: 'GET',
      headers: headers(),
    });
  } catch (netErr: any) {
    throw new Error(`Cannot reach Talent Protocol API: ${netErr.message}`);
  }

  if (res.status === 404) {
    throw new Error(`No Talent Protocol Passport found for wallet ${walletAddress}. Create one at talentprotocol.com`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error('Talent Protocol API key is invalid or expired');
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Talent API profile error (${res.status}): ${text}`);
  }

  const data = await res.json();
  const passport = data.passport || data;
  return {
    id: passport.id?.toString() || passport.main_wallet || walletAddress,
    walletAddress,
    displayName: passport.display_name || passport.name || null,
    bio: passport.bio || null,
    raw: data,
  };
}
