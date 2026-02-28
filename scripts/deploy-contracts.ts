import { compileSolidity, deployContract, loadDeployments, saveDeployments, getPlatformAddress } from '../lib/contract-deployer.js';
import path from 'path';

const SELFCLAW_TOKEN = '0xCD88f99Adf75A9110c0bcd22695A32A20eC54ECb';

async function main() {
  console.log('=== SelfClaw Smart Contract Deployment ===\n');

  const platformAddress = getPlatformAddress();
  console.log(`Platform wallet (resolver/arbiter/distributor): ${platformAddress}\n`);

  const contractsDir = path.join(process.cwd(), 'contracts');

  console.log('--- Compiling contracts ---');
  const staking = await compileSolidity(path.join(contractsDir, 'SelfClawStaking.sol'));
  console.log(`  SelfClawStaking: compiled (${staking.bytecode.length / 2} bytes)`);

  const escrow = await compileSolidity(path.join(contractsDir, 'SelfClawEscrow.sol'));
  console.log(`  SelfClawEscrow: compiled (${escrow.bytecode.length / 2} bytes)`);

  const rewards = await compileSolidity(path.join(contractsDir, 'SelfClawRewards.sol'));
  console.log(`  SelfClawRewards: compiled (${rewards.bytecode.length / 2} bytes)`);

  console.log('\n--- Deploying contracts ---');

  const stakingResult = await deployContract(staking, [platformAddress]);
  console.log(`  SelfClawStaking: ${stakingResult.address}`);

  const escrowResult = await deployContract(escrow, [platformAddress]);
  console.log(`  SelfClawEscrow: ${escrowResult.address}`);

  const rewardsResult = await deployContract(rewards, [platformAddress, SELFCLAW_TOKEN]);
  console.log(`  SelfClawRewards: ${rewardsResult.address}`);

  const deployments = {
    chainId: 42220,
    deployedAt: new Date().toISOString(),
    contracts: {
      SelfClawStaking: { address: stakingResult.address, txHash: stakingResult.txHash, explorerUrl: stakingResult.explorerUrl, abi: staking.abi },
      SelfClawEscrow: { address: escrowResult.address, txHash: escrowResult.txHash, explorerUrl: escrowResult.explorerUrl, abi: escrow.abi },
      SelfClawRewards: { address: rewardsResult.address, txHash: rewardsResult.txHash, explorerUrl: rewardsResult.explorerUrl, abi: rewards.abi },
    },
  };

  saveDeployments(deployments);

  console.log('\n=== Deployment Complete ===');
  console.log(`Deployments saved to contracts/deployments.json`);
  console.log('\nContract Addresses:');
  console.log(`  Staking:  ${stakingResult.address} — ${stakingResult.explorerUrl}`);
  console.log(`  Escrow:   ${escrowResult.address} — ${escrowResult.explorerUrl}`);
  console.log(`  Rewards:  ${rewardsResult.address} — ${rewardsResult.explorerUrl}`);
}

main().catch((err) => {
  console.error('Deployment failed:', err.message);
  process.exit(1);
});
