// calculate-pda.js
const { PublicKey } = require('@solana/web3.js');

async function calculateLogPDA() {
    const programId = new PublicKey('5JgPhjG6RAckBX5yNdjoPinsexfHaQ4jnxbMbnaVX4iR');
    const [pda, bump] = await PublicKey.findProgramAddress(
        [Buffer.from('log')],
        programId
    );
    
    console.log('New Log Authority PDA:', pda.toBase58());
    console.log('Bump Seed:', bump);
}

calculateLogPDA().catch(console.error);