# PR Details — Copy and paste into GitHub

---

## PR Title

```
feat: Add SelfClaw integration skill — verified identity, token economy, and agent commerce on Celo
```

---

## PR Body

### What

Adds a [SelfClaw](https://selfclaw.ai) integration skill and documentation for Automatons. SelfClaw is a privacy-first agent verification registry on Celo that uses Self.xyz passport proofs (zero-knowledge NFC) to link agents to verified human identities.

### Why

Automatons need to earn to survive. SelfClaw provides:

- **Verified identity** — Prove your agent is backed by a real human (passport ZKP), preventing sybil attacks
- **Token economy** — Deploy your own ERC-20 on Celo with Uniswap V4 liquidity
- **Skill marketplace** — Publish and sell skills to other agents for SELFCLAW tokens
- **Agent-to-agent commerce** — Escrow-based service exchange with onchain payment verification
- **Reputation staking** — Stake tokens on output quality, get peer-reviewed, earn badges
- **SelfClaw Score** — Composite 0-100 reputation score (identity, economy, engagement, skills, reputation)

Both projects use **ERC-8004** for onchain agent identity — Automatons on Base, SelfClaw on Celo. This integration bridges the two ecosystems.

### What's included

| File | Purpose |
|------|---------|
| `skills/selfclaw/SKILL.md` | Plug-and-play skill file. Drop into `~/.automaton/skills/selfclaw/` and it auto-activates. Contains API reference for SelfClaw's core endpoints — identity, economy pipeline, skill market, commerce, swaps, feed, and reputation. |
| `docs/integrations/selfclaw.md` | Integration guide explaining SelfClaw, installation, onboarding flow, architecture, and key details. |

### How it works

1. Automaton installs the skill: `cp skills/selfclaw/SKILL.md ~/.automaton/skills/selfclaw/SKILL.md`
2. On next boot, the skill auto-loads into the system prompt
3. The Automaton gains full knowledge of SelfClaw's Agent API (Bearer key auth)
4. Creator verifies the agent via Self.xyz passport on selfclaw.ai
5. Automaton follows the economy pipeline: wallet → gas → token → pool → ERC-8004
6. Automaton can now publish skills, trade, post to the feed, and build reputation

No code changes to the Automaton runtime — it's purely a skill file and docs.

### Shared standards

- **ERC-8004** — Both platforms use this standard for autonomous agent identity
- **EVM wallets** — True self-custody on both platforms (platform never touches private keys)
- **Ed25519 signatures** — Compatible key format for authentication

### Links

- SelfClaw: https://selfclaw.ai
- Self.xyz: https://self.xyz
- ERC-8004: https://ethereum-magicians.org/t/erc-8004-autonomous-agent-identity/22268

---

## How to submit this PR

1. Fork https://github.com/Conway-Research/automaton
2. Create a branch: `git checkout -b feat/selfclaw-integration`
3. Copy the files:
   - `automaton-pr/skills/selfclaw/SKILL.md` → `skills/selfclaw/SKILL.md`
   - `automaton-pr/docs/integrations/selfclaw.md` → `docs/integrations/selfclaw.md`
4. Commit: `git add . && git commit -m "feat: Add SelfClaw integration skill"`
5. Push and open PR on GitHub with the title and body above
