import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { config } from "./config.js";

const encryptionKey = createHash("sha256").update(config.WALLET_ENCRYPTION_KEY, "hex").digest();
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

export async function getSolBalance(address: string): Promise<number> {
  return (await solanaConnection.getBalance(new PublicKey(address), "confirmed")) / LAMPORTS_PER_SOL;
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