import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const SALT_ITERATIONS = 100000;

function deriveKey(humanId: string): Buffer {
  const serverSecret = process.env.SESSION_SECRET;
  if (!serverSecret) {
    throw new Error("SESSION_SECRET is required for wallet encryption");
  }
  return crypto.pbkdf2Sync(
    serverSecret,
    humanId,
    SALT_ITERATIONS,
    KEY_LENGTH,
    "sha512"
  );
}

export function encryptPrivateKey(privateKey: string, humanId: string): {
  encrypted: string;
  iv: string;
  tag: string;
} {
  const key = deriveKey(humanId);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(privateKey, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag();

  return {
    encrypted,
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
  };
}

export function decryptPrivateKey(
  encrypted: string,
  iv: string,
  tag: string,
  humanId: string
): string {
  const key = deriveKey(humanId);
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(iv, "hex")
  );
  decipher.setAuthTag(Buffer.from(tag, "hex"));

  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

export async function getDecryptedWalletKey(
  wallet: { encryptedPrivateKey?: string | null; encryptionIv?: string | null; encryptionTag?: string | null },
  humanId: string
): Promise<string | null> {
  if (!wallet.encryptedPrivateKey || !wallet.encryptionIv || !wallet.encryptionTag) {
    return null;
  }
  try {
    return decryptPrivateKey(
      wallet.encryptedPrivateKey,
      wallet.encryptionIv,
      wallet.encryptionTag,
      humanId
    );
  } catch (err: any) {
    console.error("[wallet-crypto] Decryption failed:", err.message);
    return null;
  }
}
