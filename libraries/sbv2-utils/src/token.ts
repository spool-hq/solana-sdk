import type * as anchor from "@project-serum/anchor";
import * as spl from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  ProgramStateAccount,
  programWallet,
} from "@switchboard-xyz/switchboard-v2";

export const getOrCreateSwitchboardTokenAccount = async (
  program: anchor.Program,
  switchboardMint?: spl.Mint,
  payer = programWallet(program)
): Promise<PublicKey> => {
  const getAssociatedAddress = async (mint: spl.Mint): Promise<PublicKey> => {
    const tokenAccount = await spl.getOrCreateAssociatedTokenAccount(
      program.provider.connection,
      payer,
      mint.address,
      payer.publicKey,
      undefined,
      undefined,
      undefined,
      spl.TOKEN_PROGRAM_ID,
      spl.ASSOCIATED_TOKEN_PROGRAM_ID
    );
    return tokenAccount.address;
  };

  let mint = switchboardMint;
  if (mint) {
    return getAssociatedAddress(mint);
  }
  const [programState] = ProgramStateAccount.fromSeed(program);
  mint = await programState.getTokenMint();
  if (mint) {
    return getAssociatedAddress(mint);
  }

  throw new Error(`failed to get associated token account`);
};

export async function transferWrappedSol(
  connection: Connection,
  payerKeypair: Keypair,
  amount: number
): Promise<number> {
  const payerBalance = await connection.getBalance(payerKeypair.publicKey);
  const payerAssociatedWallet = (
    await spl.getOrCreateAssociatedTokenAccount(
      connection,
      payerKeypair,
      spl.NATIVE_MINT,
      payerKeypair.publicKey
    )
  ).address;

  // create new account to temporarily hold wrapped funds
  const ephemeralAccount = Keypair.generate();
  const ephemeralWallet = await spl.getAssociatedTokenAddress(
    spl.NATIVE_MINT,
    ephemeralAccount.publicKey
  );

  const tx = new Transaction().add(
    spl.createAssociatedTokenAccountInstruction(
      payerKeypair.publicKey,
      ephemeralWallet,
      payerKeypair.publicKey,
      spl.NATIVE_MINT,
      spl.TOKEN_PROGRAM_ID,
      spl.ASSOCIATED_TOKEN_PROGRAM_ID
    ),
    SystemProgram.transfer({
      fromPubkey: payerKeypair.publicKey,
      toPubkey: ephemeralWallet,
      lamports: amount,
    }),
    spl.createSyncNativeInstruction(ephemeralWallet, spl.TOKEN_PROGRAM_ID),
    spl.createTransferInstruction(
      ephemeralWallet,
      payerAssociatedWallet,
      payerKeypair.publicKey,
      amount,
      [payerKeypair, ephemeralAccount],
      spl.TOKEN_PROGRAM_ID
    ),
    spl.createCloseAccountInstruction(
      ephemeralWallet,
      payerKeypair.publicKey,
      payerKeypair.publicKey,
      [payerKeypair, ephemeralAccount],
      spl.TOKEN_PROGRAM_ID
    )
  );

  const txn = await sendAndConfirmTransaction(connection, tx, [
    payerKeypair,
    ephemeralAccount,
  ]);

  const finalBalance = await spl.getAccount(connection, payerAssociatedWallet);
  return Number(finalBalance.amount);
}
