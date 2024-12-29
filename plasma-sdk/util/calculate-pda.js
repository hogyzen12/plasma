// calculate-pda.ts
import { PublicKey } from '@solana/web3.js';

async function calculateLogPDA() {
    const programId = new PublicKey('p1smVdFtyHV36TVnes2QXpRw3GHtpfEjCWqjRDKKkBh');
    const [pda, bump] = await PublicKey.findProgramAddress(
        [Buffer.from('log')],
        programId
    );
    
    console.log('New Log Authority PDA:', pda.toBase58());
    console.log('Bump Seed:', bump);
}

calculateLogPDA();