import { PROGRAM_ID } from "../generated/programId";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  MintLayout,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import {
  AddLiquidity,
  InitializeLpPosition,
  InitializePool,
  RemoveLiquidity,
  RenounceLiquidity,
  Swap,
  WithdrawProtocolFees,
  WithdrawLpFees,
} from "../generated/instructions";
import { LpPositionAccount, PoolAccount } from "../generated/accounts";
import BN from "bn.js";
import { ProtocolFeeRecipientParams, Side } from "../generated/types";
import assert from "assert";
import { ExactIn } from "../generated/types/SwapType";
import { FixedPoint } from "../util/FixedPoint";

// We'll assume the following constants for the the initial liquidity deposit
const GRADUATION_AMOUNT = 279_900_000_000_000;
const GRADUATION_SOL_AMOUNT = 100_000_000_000;
const AMM_SIZE = 8 + 8 + 16 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 8; // fee, protocol allocation, reward factor, total lp shares, slot snapshot, base reserves snapshot, quote reserves snapshot, base reserves, quote reserves, cumulative quote lp fees, cumulative quote protocol fees
const TOKEN_PARAMS_SIZE = 4 + 4 + 32 + 32; // decimals, vault bump, mint key, vault key
const PROTOCOL_FEE_RECIPIENTS_SIZE = (32 + 8 + 8 + 8) * 3 + 12 * 8; // Recipient, shares, total fees, collected fees times 3 plus 12 u64s padding
const POOL_HEADER_SIZE =
  8 + 8 + 2 * TOKEN_PARAMS_SIZE + PROTOCOL_FEE_RECIPIENTS_SIZE + 13 * 8; // Discriminator, sequence number, base params, quote params, fee recipients, padding

const LOG_AUTHORITY = PublicKey.findProgramAddressSync(
  [Buffer.from("log")],
  PROGRAM_ID
)[0];

export const sqrt = (num: BN): BN => {
  if (num.lt(new BN(0))) {
    throw new Error("Sqrt only works on non-negative inputs");
  }
  if (num.lt(new BN(2))) {
    return num;
  }

  const smallCand = sqrt(num.shrn(2)).shln(1);
  const largeCand = smallCand.add(new BN(1));

  if (largeCand.mul(largeCand).gt(num)) {
    return smallCand;
  } else {
    return largeCand;
  }
};

const bootstrapTrader = async (
  c: Connection,
  mintPubkey: PublicKey
): Promise<[Keypair, PublicKey, PublicKey]> => {
  const trader = Keypair.generate();
  const airdropTx = await c.requestAirdrop(trader.publicKey, 500_000_000_000);
  await c.confirmTransaction(airdropTx, "confirmed");

  const mintAtaTrader = await getAssociatedTokenAddress(
    mintPubkey,
    trader.publicKey
  );
  const wSolAtaTrader = await getAssociatedTokenAddress(
    NATIVE_MINT,
    trader.publicKey
  );
  const initTraderTx = new Transaction()
    .add(
      createAssociatedTokenAccountInstruction(
        trader.publicKey,
        mintAtaTrader,
        trader.publicKey,
        mintPubkey
      )
    )
    .add(
      createAssociatedTokenAccountInstruction(
        trader.publicKey,
        wSolAtaTrader,
        trader.publicKey,
        NATIVE_MINT
      )
    )
    .add(
      SystemProgram.transfer({
        fromPubkey: trader.publicKey,
        toPubkey: wSolAtaTrader,
        lamports: 100_000_000_000, // 100 SOL
      })
    )
    .add(createSyncNativeInstruction(wSolAtaTrader));
  await sendAndConfirmTransaction(c, initTraderTx, [trader], {
    commitment: "confirmed",
    skipPreflight: true,
  });
  return [trader, mintAtaTrader, wSolAtaTrader];
};

const initPool = async (
  c: Connection,
  poolKeypair: Keypair,
  payer: Keypair,
  mintPubkey: PublicKey,
  mintAtaPayer: PublicKey,
  wSolAtaPayer: PublicKey,
  initialLpShares: BN,
  feeRecipients: ProtocolFeeRecipientParams[]
) => {
  const initTx = new Transaction()
    .add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: poolKeypair.publicKey,
        lamports: await c.getMinimumBalanceForRentExemption(
          POOL_HEADER_SIZE + AMM_SIZE
        ),
        space: POOL_HEADER_SIZE + AMM_SIZE,
        programId: PROGRAM_ID,
      })
    )
    .add(
      InitializePool(
        {
          params: {
            lpFeeInBps: new BN(25),
            protocolLpFeeAllocationInPct: new BN(10),
            feeRecipientsParams: feeRecipients,
            numSlotsToVestLpShares: null,
          },
        },
        {
          plasmaProgram: PROGRAM_ID,
          logAuthority: LOG_AUTHORITY,
          pool: poolKeypair.publicKey,
          poolCreator: payer.publicKey,
          baseMint: mintPubkey,
          quoteMint: NATIVE_MINT,
          baseVault: PublicKey.findProgramAddressSync(
            [
              Buffer.from("vault"),
              poolKeypair.publicKey.toBuffer(),
              mintPubkey.toBuffer(),
            ],
            PROGRAM_ID
          )[0],
          quoteVault: PublicKey.findProgramAddressSync(
            [
              Buffer.from("vault"),
              poolKeypair.publicKey.toBuffer(),
              NATIVE_MINT.toBuffer(),
            ],
            PROGRAM_ID
          )[0],
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        }
      )
    )
    .add(
      InitializeLpPosition({
        plasmaProgram: PROGRAM_ID,
        logAuthority: LOG_AUTHORITY,
        pool: poolKeypair.publicKey,
        payer: payer.publicKey,
        lpPositionOwner: payer.publicKey,
        lpPosition: PublicKey.findProgramAddressSync(
          [
            Buffer.from("lp_position"),
            poolKeypair.publicKey.toBuffer(),
            payer.publicKey.toBuffer(),
          ],
          PROGRAM_ID
        )[0],
        systemProgram: SystemProgram.programId,
      })
    )
    .add(
      AddLiquidity(
        {
          params: {
            desiredBaseAmountIn: new BN(GRADUATION_AMOUNT),
            desiredQuoteAmountIn: new BN(GRADUATION_SOL_AMOUNT),
            initialLpShares,
          },
        },
        {
          plasmaProgram: PROGRAM_ID,
          logAuthority: LOG_AUTHORITY,
          pool: poolKeypair.publicKey,
          trader: payer.publicKey,
          lpPosition: PublicKey.findProgramAddressSync(
            [
              Buffer.from("lp_position"),
              poolKeypair.publicKey.toBuffer(),
              payer.publicKey.toBuffer(),
            ],
            PROGRAM_ID
          )[0],
          baseAccount: mintAtaPayer,
          quoteAccount: wSolAtaPayer,
          baseVault: PublicKey.findProgramAddressSync(
            [
              Buffer.from("vault"),
              poolKeypair.publicKey.toBuffer(),
              mintPubkey.toBuffer(),
            ],
            PROGRAM_ID
          )[0],
          quoteVault: PublicKey.findProgramAddressSync(
            [
              Buffer.from("vault"),
              poolKeypair.publicKey.toBuffer(),
              NATIVE_MINT.toBuffer(),
            ],
            PROGRAM_ID
          )[0],
          tokenProgram: TOKEN_PROGRAM_ID,
        }
      )
    )
    .add(
      RenounceLiquidity(
        {
          params: {
            allowFeeWithdrawal: true,
          },
        },
        {
          plasmaProgram: PROGRAM_ID,
          logAuthority: LOG_AUTHORITY,
          pool: poolKeypair.publicKey,
          trader: payer.publicKey,
          lpPosition: PublicKey.findProgramAddressSync(
            [
              Buffer.from("lp_position"),
              poolKeypair.publicKey.toBuffer(),
              payer.publicKey.toBuffer(),
            ],
            PROGRAM_ID
          )[0],
        }
      )
    );
  await sendAndConfirmTransaction(c, initTx, [payer, poolKeypair], {
    commitment: "confirmed",
    skipPreflight: true,
  });
  return [mintPubkey, mintAtaPayer, wSolAtaPayer];
};

const setupMint = async (
  c: Connection,
  payer: Keypair
): Promise<[PublicKey, PublicKey, PublicKey]> => {
  const mintKeypair = Keypair.generate();
  const mintAtaPayer = await getAssociatedTokenAddress(
    mintKeypair.publicKey,
    payer.publicKey
  );
  const wSolAtaPayer = await getAssociatedTokenAddress(
    NATIVE_MINT,
    payer.publicKey
  );
  const initMintTx = new Transaction()
    .add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: mintKeypair.publicKey,
        lamports: await c.getMinimumBalanceForRentExemption(MintLayout.span),
        space: MintLayout.span,
        programId: TOKEN_PROGRAM_ID,
      })
    )
    .add(
      createInitializeMintInstruction(
        mintKeypair.publicKey,
        6,
        payer.publicKey,
        null
      )
    )
    .add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        mintAtaPayer,
        payer.publicKey,
        mintKeypair.publicKey
      )
    )
    .add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        wSolAtaPayer,
        payer.publicKey,
        NATIVE_MINT
      )
    )
    .add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: wSolAtaPayer,
        lamports: GRADUATION_SOL_AMOUNT,
      })
    )
    .add(createSyncNativeInstruction(wSolAtaPayer))
    .add(
      createMintToInstruction(
        mintKeypair.publicKey,
        mintAtaPayer,
        payer.publicKey,
        GRADUATION_AMOUNT
      )
    );
  await sendAndConfirmTransaction(c, initMintTx, [payer, mintKeypair], {
    commitment: "confirmed",
  });
  return [mintKeypair.publicKey, mintAtaPayer, wSolAtaPayer];
};

describe("plasma", async () => {
  const c = new Connection("http://127.0.0.1:8899", "confirmed");
  const payer = Keypair.generate();
  const traders: [Keypair, PublicKey, PublicKey][] = [];
  let mintPubkey: PublicKey;
  let mintAtaPayer: PublicKey;
  let wSolAtaPayer: PublicKey;
  let poolKey: PublicKey;

  before(async () => {
    console.log("Airdropping to payer");
    const airdropTx = await c.requestAirdrop(
      payer.publicKey,
      1_000_000_000_000
    );
    console.log("Confirming airdrop");
    await c.confirmTransaction(airdropTx, "confirmed");
    [mintPubkey, mintAtaPayer, wSolAtaPayer] = await setupMint(c, payer);
    for (let i = 0; i < 4; i++) {
      console.log("Bootstapping trader", i);
      traders.push(await bootstrapTrader(c, mintPubkey));
    }
  });
  it("initialize fails if protocol fee recipients are the same", async () => {
    const initialLpShares = sqrt(
      new BN(GRADUATION_AMOUNT).mul(new BN(GRADUATION_SOL_AMOUNT))
    );
    const feeRecipients = [
      new ProtocolFeeRecipientParams({
        recipient: traders[0][0].publicKey,
        shares: new BN(100),
      }),
      new ProtocolFeeRecipientParams({
        recipient: traders[0][0].publicKey,
        shares: new BN(100),
      }),
      new ProtocolFeeRecipientParams({
        recipient: traders[0][0].publicKey,
        shares: new BN(100),
      }),
    ];

    const poolKeypair = Keypair.generate();
    console.log("Creating pool account");

    try {
      await initPool(
        c,
        poolKeypair,
        payer,
        mintPubkey,
        mintAtaPayer,
        wSolAtaPayer,
        initialLpShares,
        feeRecipients
      );

      assert(false);
    } catch (err) {
      console.log(
        "Initialize pool fails as expected because protocol fee recipients are the same. Error: ",
        err
      );
    }
  });

  it("Mint and deposit initial liquidity", async () => {
    const initialLpShares = sqrt(
      new BN(GRADUATION_AMOUNT).mul(new BN(GRADUATION_SOL_AMOUNT))
    );

    const feeRecipients = [
      new ProtocolFeeRecipientParams({
        recipient: traders[0][0].publicKey,
        shares: new BN(100),
      }),
      new ProtocolFeeRecipientParams({
        recipient: traders[1][0].publicKey,
        shares: new BN(100),
      }),
      new ProtocolFeeRecipientParams({
        recipient: traders[2][0].publicKey,
        shares: new BN(100),
      }),
    ];

    const poolKeypair = Keypair.generate();
    console.log("Creating pool account");
    await initPool(
      c,
      poolKeypair,
      payer,
      mintPubkey,
      mintAtaPayer,
      wSolAtaPayer,
      initialLpShares,
      feeRecipients
    );

    poolKey = poolKeypair.publicKey;
    const poolAccount = await PoolAccount.fetch(c, poolKeypair.publicKey);
    console.log(poolAccount?.toJSON());

    try {
      const removeLiqTx = new Transaction().add(
        RemoveLiquidity(
          {
            params: {
              lpShares: initialLpShares,
            },
          },
          {
            plasmaProgram: PROGRAM_ID,
            logAuthority: LOG_AUTHORITY,
            pool: poolKeypair.publicKey,
            trader: payer.publicKey,
            lpPosition: PublicKey.findProgramAddressSync(
              [
                Buffer.from("lp_position"),
                poolKeypair.publicKey.toBuffer(),
                payer.publicKey.toBuffer(),
              ],
              PROGRAM_ID
            )[0],
            baseAccount: mintAtaPayer,
            quoteAccount: wSolAtaPayer,
            baseVault: PublicKey.findProgramAddressSync(
              [
                Buffer.from("vault"),
                poolKeypair.publicKey.toBuffer(),
                mintPubkey.toBuffer(),
              ],
              PROGRAM_ID
            )[0],
            quoteVault: PublicKey.findProgramAddressSync(
              [
                Buffer.from("vault"),
                poolKeypair.publicKey.toBuffer(),
                NATIVE_MINT.toBuffer(),
              ],
              PROGRAM_ID
            )[0],
            tokenProgram: TOKEN_PROGRAM_ID,
          }
        )
      );
      await sendAndConfirmTransaction(c, removeLiqTx, [payer], {
        commitment: "confirmed",
      });
      assert(false);
    } catch (err) {
      console.log("Remove liquidity failed as expected", err);
    }
  });
  it("Show that non-atomic sandwich is still profitable", async () => {
    const [attacker, mintAtaAttacker, wSolAtaAttacker] = traders[0];
    const [victim, mintAtaVictim, wSolAtaVictim] = traders[1];

    const attackerStartingBalance = new BN(
      (
        await c.getTokenAccountBalance(wSolAtaAttacker, "confirmed")
      ).value.amount
    );

    console.log("Sending frontrun transaction");

    let atomicFrontrunTx = new Transaction()
      .add(
        Swap(
          {
            params: {
              side: new Side.Buy(),
              swapType: new ExactIn({
                amountIn: new BN(2_000_000_000),
                minAmountOut: new BN(0),
              }),
            },
          },
          {
            plasmaProgram: PROGRAM_ID,
            logAuthority: LOG_AUTHORITY,
            pool: poolKey,
            trader: attacker.publicKey,
            baseAccount: mintAtaAttacker,
            quoteAccount: wSolAtaAttacker,
            baseVault: PublicKey.findProgramAddressSync(
              [Buffer.from("vault"), poolKey.toBuffer(), mintPubkey.toBuffer()],
              PROGRAM_ID
            )[0],
            quoteVault: PublicKey.findProgramAddressSync(
              [
                Buffer.from("vault"),
                poolKey.toBuffer(),
                NATIVE_MINT.toBuffer(),
              ],
              PROGRAM_ID
            )[0],
            tokenProgram: TOKEN_PROGRAM_ID,
          }
        )
      )
      .add(
        Swap(
          {
            params: {
              side: new Side.Buy(),
              swapType: new ExactIn({
                amountIn: new BN(1000_000_000),
                minAmountOut: new BN(0),
              }),
            },
          },
          {
            plasmaProgram: PROGRAM_ID,
            logAuthority: LOG_AUTHORITY,
            pool: poolKey,
            trader: victim.publicKey,
            baseAccount: mintAtaVictim,
            quoteAccount: wSolAtaVictim,
            baseVault: PublicKey.findProgramAddressSync(
              [Buffer.from("vault"), poolKey.toBuffer(), mintPubkey.toBuffer()],
              PROGRAM_ID
            )[0],
            quoteVault: PublicKey.findProgramAddressSync(
              [
                Buffer.from("vault"),
                poolKey.toBuffer(),
                NATIVE_MINT.toBuffer(),
              ],
              PROGRAM_ID
            )[0],
            tokenProgram: TOKEN_PROGRAM_ID,
          }
        )
      );

    const txId = await sendAndConfirmTransaction(
      c,
      atomicFrontrunTx,
      [attacker, victim],
      {
        commitment: "confirmed",
        skipPreflight: true,
      }
    );

    const attackerMintBalance = new BN(
      (
        await c.getTokenAccountBalance(mintAtaAttacker, "confirmed")
      ).value.amount
    );

    const txContents = await c.getTransaction(txId, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });

    if (txContents === null || !txContents?.slot) {
      new Error("Transaction not found");
    }
    const txSnapshotSlot = ((txContents?.slot || 0) >> 2) << 2;
    const currentSlot = await c.getSlot("confirmed");

    console.log(
      `Waiting for pool to reset, snapshot slot: ${txSnapshotSlot}, current slot: ${currentSlot}`
    );
    // Spin until we are confident that the pool has reset
    while ((await c.getSlot("confirmed")) < txSnapshotSlot + 4) {}

    console.log("Sending backrun transaction");
    let atomicBackrunTx = new Transaction().add(
      Swap(
        {
          params: {
            side: new Side.Sell(),
            swapType: new ExactIn({
              amountIn: attackerMintBalance,
              minAmountOut: new BN(2_000_000_000),
            }),
          },
        },
        {
          plasmaProgram: PROGRAM_ID,
          logAuthority: LOG_AUTHORITY,
          pool: poolKey,
          trader: attacker.publicKey,
          baseAccount: mintAtaAttacker,
          quoteAccount: wSolAtaAttacker,
          baseVault: PublicKey.findProgramAddressSync(
            [Buffer.from("vault"), poolKey.toBuffer(), mintPubkey.toBuffer()],
            PROGRAM_ID
          )[0],
          quoteVault: PublicKey.findProgramAddressSync(
            [Buffer.from("vault"), poolKey.toBuffer(), NATIVE_MINT.toBuffer()],
            PROGRAM_ID
          )[0],
          tokenProgram: TOKEN_PROGRAM_ID,
        }
      )
    );

    await sendAndConfirmTransaction(c, atomicBackrunTx, [attacker], {
      commitment: "confirmed",
      skipPreflight: true,
    });

    const attackerRemainingMintBalance = new BN(
      (
        await c.getTokenAccountBalance(mintAtaAttacker, "confirmed")
      ).value.amount
    );

    assert(attackerRemainingMintBalance.eq(new BN(0)));

    const attackerEndingBalance = new BN(
      (
        await c.getTokenAccountBalance(wSolAtaAttacker, "confirmed")
      ).value.amount
    );

    console.log(
      "Attacker starting balance: ",
      attackerStartingBalance.toString()
    );
    console.log("Attacker ending balance: ", attackerEndingBalance.toString());
    assert(attackerEndingBalance.gt(attackerStartingBalance));
  });

  it("Show that sandwiches in the same snapshot window are no longer profitable", async () => {
    const [attacker, mintAtaAttacker, wSolAtaAttacker] = traders[2];
    const [victim, mintAtaVictim, wSolAtaVictim] = traders[3];

    console.log("First, sleep until we hit a new slot window boundary");
    // Wait until the current slot is divisible by 4 (on the boundary).
    // Note that this is a bit of a hack and it would be far better to test this behavior in a more controlled environment
    // like solana-program-test or bankrun where we can control the clock
    while ((await c.getSlot("confirmed")) % 4 != 0) {}

    const attackerStartingBalance = new BN(
      (
        await c.getTokenAccountBalance(wSolAtaAttacker, "confirmed")
      ).value.amount
    );

    console.log("Sending frontrun transaction");

    let atomicFrontrunTx = new Transaction()
      .add(
        Swap(
          {
            params: {
              side: new Side.Buy(),
              swapType: new ExactIn({
                amountIn: new BN(1_000_000_000),
                minAmountOut: new BN(0),
              }),
            },
          },
          {
            plasmaProgram: PROGRAM_ID,
            logAuthority: LOG_AUTHORITY,
            pool: poolKey,
            trader: attacker.publicKey,
            baseAccount: mintAtaAttacker,
            quoteAccount: wSolAtaAttacker,
            baseVault: PublicKey.findProgramAddressSync(
              [Buffer.from("vault"), poolKey.toBuffer(), mintPubkey.toBuffer()],
              PROGRAM_ID
            )[0],
            quoteVault: PublicKey.findProgramAddressSync(
              [
                Buffer.from("vault"),
                poolKey.toBuffer(),
                NATIVE_MINT.toBuffer(),
              ],
              PROGRAM_ID
            )[0],
            tokenProgram: TOKEN_PROGRAM_ID,
          }
        )
      )
      .add(
        Swap(
          {
            params: {
              side: new Side.Buy(),
              swapType: new ExactIn({
                amountIn: new BN(500_000_000),
                minAmountOut: new BN(0),
              }),
            },
          },
          {
            plasmaProgram: PROGRAM_ID,
            logAuthority: LOG_AUTHORITY,
            pool: poolKey,
            trader: victim.publicKey,
            baseAccount: mintAtaVictim,
            quoteAccount: wSolAtaVictim,
            baseVault: PublicKey.findProgramAddressSync(
              [Buffer.from("vault"), poolKey.toBuffer(), mintPubkey.toBuffer()],
              PROGRAM_ID
            )[0],
            quoteVault: PublicKey.findProgramAddressSync(
              [
                Buffer.from("vault"),
                poolKey.toBuffer(),
                NATIVE_MINT.toBuffer(),
              ],
              PROGRAM_ID
            )[0],
            tokenProgram: TOKEN_PROGRAM_ID,
          }
        )
      );
    await sendAndConfirmTransaction(c, atomicFrontrunTx, [attacker, victim], {
      commitment: "confirmed",
      skipPreflight: true,
    });

    const attackerMintBalance = new BN(
      (
        await c.getTokenAccountBalance(mintAtaAttacker, "confirmed")
      ).value.amount
    );

    console.log(
      "This time we don't sleep. The current slot should be far enough away from the slot boundary"
    );

    console.log("Sending backrun transaction");
    let atomicBackrunTx = new Transaction().add(
      Swap(
        {
          params: {
            side: new Side.Sell(),
            swapType: new ExactIn({
              amountIn: attackerMintBalance,
              minAmountOut: new BN(0),
            }),
          },
        },
        {
          plasmaProgram: PROGRAM_ID,
          logAuthority: LOG_AUTHORITY,
          pool: poolKey,
          trader: attacker.publicKey,
          baseAccount: mintAtaAttacker,
          quoteAccount: wSolAtaAttacker,
          baseVault: PublicKey.findProgramAddressSync(
            [Buffer.from("vault"), poolKey.toBuffer(), mintPubkey.toBuffer()],
            PROGRAM_ID
          )[0],
          quoteVault: PublicKey.findProgramAddressSync(
            [Buffer.from("vault"), poolKey.toBuffer(), NATIVE_MINT.toBuffer()],
            PROGRAM_ID
          )[0],
          tokenProgram: TOKEN_PROGRAM_ID,
        }
      )
    );

    await sendAndConfirmTransaction(c, atomicBackrunTx, [attacker], {
      commitment: "confirmed",
      skipPreflight: true,
    });

    const attackerRemainingMintBalance = new BN(
      (
        await c.getTokenAccountBalance(mintAtaAttacker, "confirmed")
      ).value.amount
    );

    assert(attackerRemainingMintBalance.eq(new BN(0)));

    const attackerEndingBalance = new BN(
      (
        await c.getTokenAccountBalance(wSolAtaAttacker, "confirmed")
      ).value.amount
    );

    console.log(
      "Attacker starting balance: ",
      attackerStartingBalance.toString()
    );
    console.log("Attacker ending balance: ", attackerEndingBalance.toString());
    assert(attackerEndingBalance.lt(attackerStartingBalance));
  });

  it("Should accumulate fees for a liquidity provider", async () => {
    // Perform some swaps to generate fees
    const swapper = traders[0][0];
    const swapperMintAta = traders[0][1];
    const swapperWsolAta = traders[0][2];

    for (let i = 0; i < 5; i++) {
      const swapTx = new Transaction().add(
        Swap(
          {
            params: {
              side: new Side.Buy(),
              swapType: new ExactIn({
                amountIn: new BN(2_000_000_000),
                minAmountOut: new BN(0),
              }),
            },
          },

          {
            plasmaProgram: PROGRAM_ID,
            logAuthority: LOG_AUTHORITY,
            pool: poolKey,
            trader: swapper.publicKey,
            baseAccount: swapperMintAta,
            quoteAccount: swapperWsolAta,
            baseVault: PublicKey.findProgramAddressSync(
              [Buffer.from("vault"), poolKey.toBuffer(), mintPubkey.toBuffer()],
              PROGRAM_ID
            )[0],
            quoteVault: PublicKey.findProgramAddressSync(
              [
                Buffer.from("vault"),
                poolKey.toBuffer(),
                NATIVE_MINT.toBuffer(),
              ],
              PROGRAM_ID
            )[0],
            tokenProgram: TOKEN_PROGRAM_ID,
          }
        )
      );
      await sendAndConfirmTransaction(c, swapTx, [swapper], {
        commitment: "confirmed",
      });
    }

    // Check if fees have accumulated
    const poolAccount = await PoolAccount.fetch(c, poolKey);
    if (!poolAccount) {
      throw new Error("Pool account not found");
    }

    const lpPositionAddress = PublicKey.findProgramAddressSync(
      [
        Buffer.from("lp_position"),
        poolKey.toBuffer(),
        payer.publicKey.toBuffer(),
      ],
      PROGRAM_ID
    )[0];

    const lpPositionBefore = await LpPositionAccount.fetch(
      c,
      lpPositionAddress
    );

    // Check fees accumulated for the LP
    if (!lpPositionBefore) {
      throw new Error("LP position account not found");
    }

    const poolRewardFactor = new FixedPoint(poolAccount.amm.rewardFactor);
    console.log(`poolRewardFactor: ${poolRewardFactor.toNumber()}`);
    const lpRewardFactorSnapshot = new FixedPoint(
      lpPositionBefore.lpPosition.rewardFactorSnapshot
    );
    console.log(`lpRewardFactorSnapshot: ${lpRewardFactorSnapshot.toNumber()}`);

    const rewardDiff =
      poolRewardFactor.toNumber() - lpRewardFactorSnapshot.toNumber();
    console.log(`rewardDiff: ${rewardDiff}`);
    const expectedReward =
      rewardDiff * lpPositionBefore.lpPosition.lpShares.toNumber();

    // Claim fees
    const withdrawLpFeesTx = new Transaction().add(
      WithdrawLpFees(
        {
          plasmaProgram: PROGRAM_ID,
          logAuthority: LOG_AUTHORITY,
          pool: poolKey,
          trader: payer.publicKey,
          lpPositionOwner: payer.publicKey,
          lpPosition: lpPositionAddress,
          quoteAccount: wSolAtaPayer,
          quoteVault: PublicKey.findProgramAddressSync(
            [Buffer.from("vault"), poolKey.toBuffer(), NATIVE_MINT.toBuffer()],
            PROGRAM_ID
          )[0],
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        PROGRAM_ID
      )
    );

    await sendAndConfirmTransaction(c, withdrawLpFeesTx, [payer], {
      commitment: "confirmed",
    });

    // Fetch the LP position account
    const lpPositionAfter = await LpPositionAccount.fetch(c, lpPositionAddress);
    if (!lpPositionAfter) {
      throw new Error("LP position account not found");
    }

    assert(
      lpPositionAfter.lpPosition.rewardFactorSnapshot.eq(
        poolAccount.amm.rewardFactor
      ),
      "LP position reward factor should be updated"
    );

    const collectedFees = lpPositionAfter.lpPosition.collectedFees.toNumber();
    const difference = collectedFees - expectedReward;
    console.log("Collected fees: ", collectedFees);
    console.log("Expected reward: ", expectedReward);

    const poolAfter = await PoolAccount.fetch(c, poolKey);
    if (!poolAfter) {
      throw new Error("Pool account not found");
    }

    const poolFees = poolAfter.amm.cumulativeQuoteLpFees.toNumber();
    console.log("Total pool fees: ", poolFees);

    const tolerance = 1000;
    assert(
      difference <= tolerance,
      "Collected fees should be close to expected reward"
    );
  });

  it("Withdraw protocol fees", async () => {
    const quoteVault = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), poolKey.toBuffer(), NATIVE_MINT.toBuffer()],
      PROGRAM_ID
    )[0];
    const poolAccount = await PoolAccount.fetch(c, poolKey);
    const protocolFeeRecipients =
      poolAccount?.poolHeader.feeRecipients.recipients;

    const traderZeroQuotePreBalance = await c.getTokenAccountBalance(
      traders[0][2],
      "confirmed"
    );
    const traderOneQuotePreBalance = await c.getTokenAccountBalance(
      traders[1][2],
      "confirmed"
    );
    const traderTwoQuotePreBalance = await c.getTokenAccountBalance(
      traders[2][2],
      "confirmed"
    );

    const traderZeroExpectedFees =
      protocolFeeRecipients?.[0].totalAccumulatedQuoteFees ?? new BN(0);
    const traderOneExpectedFees =
      protocolFeeRecipients?.[1].totalAccumulatedQuoteFees ?? new BN(0);
    const traderTwoExpectedFees =
      protocolFeeRecipients?.[2].totalAccumulatedQuoteFees ?? new BN(0);

    const totalProtocolFees =
      poolAccount?.amm.cumulativeQuoteProtocolFees ?? new BN(0);
    const sumProtocolFeesAcrossRecipients = traderZeroExpectedFees
      .add(traderOneExpectedFees)
      .add(traderTwoExpectedFees);
    console.log("AMM cumulative protocol fees: ", totalProtocolFees.toNumber());
    console.log(
      "Sum of protocol fees across recipients: ",
      sumProtocolFeesAcrossRecipients.toNumber()
    );
    assert(
      totalProtocolFees
        .sub(
          traderZeroExpectedFees
            .add(traderOneExpectedFees)
            .add(traderTwoExpectedFees)
        )
        .abs()
        .lt(new BN(2))
    );

    let traderZeroWithdrawTx = new Transaction().add(
      WithdrawProtocolFees({
        plasmaProgram: PROGRAM_ID,
        logAuthority: LOG_AUTHORITY,
        pool: poolKey,
        protocolFeeRecipient: traders[0][0].publicKey,
        quoteAccount: traders[0][2],
        quoteVault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
    );
    await sendAndConfirmTransaction(c, traderZeroWithdrawTx, [traders[0][0]], {
      commitment: "confirmed",
    });

    let traderOneWithdrawTx = new Transaction().add(
      WithdrawProtocolFees({
        plasmaProgram: PROGRAM_ID,
        logAuthority: LOG_AUTHORITY,
        pool: poolKey,
        protocolFeeRecipient: traders[1][0].publicKey,
        quoteAccount: traders[1][2],
        quoteVault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
    );
    await sendAndConfirmTransaction(c, traderOneWithdrawTx, [traders[1][0]], {
      commitment: "confirmed",
    });

    let traderTwoWithdrawTx = new Transaction().add(
      WithdrawProtocolFees({
        plasmaProgram: PROGRAM_ID,
        logAuthority: LOG_AUTHORITY,
        pool: poolKey,
        protocolFeeRecipient: traders[2][0].publicKey,
        quoteAccount: traders[2][2],
        quoteVault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
    );
    await sendAndConfirmTransaction(c, traderTwoWithdrawTx, [traders[2][0]], {
      commitment: "confirmed",
    });

    const traderZeroQuotePostBalance = await c.getTokenAccountBalance(
      traders[0][2],
      "confirmed"
    );
    const traderOneQuotePostBalance = await c.getTokenAccountBalance(
      traders[1][2],
      "confirmed"
    );
    const traderTwoQuotePostBalance = await c.getTokenAccountBalance(
      traders[2][2],
      "confirmed"
    );

    assert(
      Number(traderZeroQuotePostBalance.value.amount) -
        Number(traderZeroQuotePreBalance.value.amount) ==
        traderZeroExpectedFees.toNumber()
    );
    assert(
      Number(traderOneQuotePostBalance.value.amount) -
        Number(traderOneQuotePreBalance.value.amount) ==
        traderOneExpectedFees.toNumber()
    );
    assert(
      Number(traderTwoQuotePostBalance.value.amount) -
        Number(traderTwoQuotePreBalance.value.amount) ==
        traderTwoExpectedFees.toNumber()
    );

    try {
      // Non-recipient trader trying to receive fees should fail
      let traderThreeWithdrawTx = new Transaction().add(
        WithdrawProtocolFees({
          plasmaProgram: PROGRAM_ID,
          logAuthority: LOG_AUTHORITY,
          pool: poolKey,
          protocolFeeRecipient: traders[3][0].publicKey,
          quoteAccount: traders[3][2],
          quoteVault,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
      );
      await sendAndConfirmTransaction(
        c,
        traderThreeWithdrawTx,
        [traders[3][0]],
        {
          commitment: "confirmed",
        }
      );
      assert(false);
    } catch (err) {
      console.log(
        "Non-recipient trader trying to receive fees should fail",
        err
      );
    }

    // Fetch pool again and make sure the collected fees are updated
    const poolAccountPostWithdraw = await PoolAccount.fetch(c, poolKey);
    const protocolFeeRecipientsPostWithdraw =
      poolAccountPostWithdraw?.poolHeader.feeRecipients.recipients;
    const recipientOne = protocolFeeRecipientsPostWithdraw?.[0];
    const recipientTwo = protocolFeeRecipientsPostWithdraw?.[1];
    const recipientThree = protocolFeeRecipientsPostWithdraw?.[2];

    assert(
      recipientOne?.collectedQuoteFees.eq(
        recipientOne?.totalAccumulatedQuoteFees
      )
    );
    assert(
      recipientTwo?.collectedQuoteFees.eq(
        recipientTwo?.totalAccumulatedQuoteFees
      )
    );
    assert(
      recipientThree?.collectedQuoteFees.eq(
        recipientThree?.totalAccumulatedQuoteFees
      )
    );
  });
});
