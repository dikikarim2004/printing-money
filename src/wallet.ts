import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { config } from "./config.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

function decodeBase58(value: string): Uint8Array {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let number = 0n;
  for (const character of value) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error("Private key must be valid base58");
    number = number * 58n + BigInt(index);
  }
  const bytes: number[] = [];
  while (number > 0n) {
    bytes.unshift(Number(number % 256n));
    number /= 256n;
  }
  for (const character of value) {
    if (character !== "1") break;
    bytes.unshift(0);
  }
  return new Uint8Array(bytes);
}

export function encodeBase58(value: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let number = 0n;
  for (const byte of value) number = number * 256n + BigInt(byte);
  let encoded = "";
  while (number > 0n) {
    encoded = alphabet[Number(number % 58n)] + encoded;
    number /= 58n;
  }
  for (const byte of value) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }
  return encoded || "1";
}

export function importSolanaPrivateKey(value: string): { address: string; encryptedPrivateKey: string } {
  const trimmed = value.trim();
  let secretKey: Uint8Array;
  if (trimmed.startsWith("[")) {
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); } catch { throw new Error("Private key JSON is invalid"); }
    if (!Array.isArray(parsed) || !parsed.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) throw new Error("Private key JSON must be a byte array");
    secretKey = new Uint8Array(parsed);
  } else if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
    secretKey = new Uint8Array(Buffer.from(trimmed, "hex"));
  } else {
    secretKey = decodeBase58(trimmed);
  }
  if (secretKey.length !== 32 && secretKey.length !== 64) throw new Error("Solana private key must contain 32 or 64 bytes");
  const keypair = Keypair.fromSecretKey(secretKey.length === 64 ? secretKey : Keypair.fromSeed(secretKey).secretKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(keypair.secretKey)), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    address: keypair.publicKey.toBase58(),
    encryptedPrivateKey: `${iv.toString("base64url")}.${authTag.toString("base64url")}.${ciphertext.toString("base64url")}`
  };
}

const encryptionKey = createHash("sha256").update(config.WALLET_ENCRYPTION_KEY, "hex").digest();

export function encryptPrivateKey(privateKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(privateKey, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("base64url")}.${authTag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

export function importWalletForChain(chain: "SOLANA" | "ROBINHOOD", value: string): { address: string; encryptedPrivateKey: string } {
  if (chain === "SOLANA") return importSolanaPrivateKey(value);
  const [address, ...privateKeyParts] = value.trim().split(/\s+/);
  const privateKey = privateKeyParts.join(" ");
  if (!address || !privateKey) throw new Error("Robinhood import format: wallet_address private_key");
  return { address, encryptedPrivateKey: encryptPrivateKey(privateKey) };
}

export function generateWalletForChain(chain: "SOLANA" | "ROBINHOOD"): { address: string; encryptedPrivateKey: string } {
  if (chain === "SOLANA") return generateWallet();
  const privateKey = randomBytes(32);
  const publicKey = secp256k1.getPublicKey(privateKey, false);
  const address = `0x${Buffer.from(keccak_256(publicKey.slice(1))).subarray(-20).toString("hex")}`;
  return { address, encryptedPrivateKey: encryptPrivateKey(privateKey.toString("hex")) };
}
export const solanaConnection = new Connection(config.SOLANA_RPC_URL, "confirmed");

export function generateWallet(): { address: string; encryptedPrivateKey: string } {
  const keypair = Keypair.generate();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(keypair.secretKey)), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    address: keypair.publicKey.toBase58(),
    encryptedPrivateKey: `${iv.toString("base64url")}.${authTag.toString("base64url")}.${ciphertext.toString("base64url")}`
  };
}

export function decryptPrivateKey(encryptedPrivateKey: string): Uint8Array {
  const [ivEncoded, authTagEncoded, ciphertextEncoded] = encryptedPrivateKey.split(".");
  if (!ivEncoded || !authTagEncoded || !ciphertextEncoded) throw new Error("Invalid encrypted wallet key format");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(ivEncoded, "base64url"));
  decipher.setAuthTag(Buffer.from(authTagEncoded, "base64url"));
  return new Uint8Array(Buffer.concat([decipher.update(Buffer.from(ciphertextEncoded, "base64url")), decipher.final()]));
}

export function exportPrivateKey(encryptedPrivateKey: string, chain: "SOLANA" | "ROBINHOOD"): string {
  const decrypted = decryptPrivateKey(encryptedPrivateKey);
  if (chain === "SOLANA") return encodeBase58(decrypted);
  return Buffer.from(decrypted).toString("utf8");
}

export async function getSolBalance(address: string): Promise<number> {
  return (await solanaConnection.getBalance(new PublicKey(address), "confirmed")) / LAMPORTS_PER_SOL;
}

export async function getRobinhoodBalance(address: string): Promise<number> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("Robinhood wallet address must be a 20-byte hexadecimal address");
  if (!config.ROBINHOOD_RPC_URL) throw new Error("ROBINHOOD_RPC_URL is not configured");
  const response = await fetch(config.ROBINHOOD_RPC_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "eth_getBalance", params: [address, "latest"] }),
    signal: AbortSignal.timeout(10000)
  });
  const body = await response.json() as { result?: unknown; error?: { message?: string } };
  if (!response.ok || body.error) throw new Error(`Robinhood balance RPC failed (${response.status}): ${body.error?.message ?? "unknown error"}`);
  if (typeof body.result !== "string" || !/^0x[0-9a-fA-F]+$/.test(body.result)) throw new Error("Robinhood balance RPC returned an invalid result");
  return Number(BigInt(body.result)) / 10 ** config.ROBINHOOD_NATIVE_DECIMALS;
}

export async function sendSol(encryptedPrivateKey: string, recipientAddress: string, amountSol: number): Promise<string> {
  if (!Number.isFinite(amountSol) || amountSol <= 0) throw new Error("Amount must be greater than zero");
  const sender = Keypair.fromSecretKey(decryptPrivateKey(encryptedPrivateKey));
  const recipient = new PublicKey(recipientAddress);
  const lamports = Math.round(amountSol * LAMPORTS_PER_SOL);
  if (lamports <= 0) throw new Error("Amount is below the minimum SOL unit");
  const transaction = new Transaction().add(SystemProgram.transfer({ fromPubkey: sender.publicKey, toPubkey: recipient, lamports }));
  return sendAndConfirmTransaction(solanaConnection, transaction, [sender], { commitment: "confirmed" });
}