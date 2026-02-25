# PR Details — Copy and paste into GitHub

---

## PR Title

```
feat: Add SelfClaw skill — verified identity, token economy, and agent commerce on Celo
```

---

## PR Body (copy everything below this line)

## Summary

- **Problem:** OpenClaw agents have no way to prove they're backed by a real human, and no integrated path to deploy tokens, trade skills, or build onchain reputation.
- **Why it matters:** Sybil-resistant identity is foundational for agent economies. Without it, agents can't trust each other, and marketplaces can't enforce accountability.
- **What changed:** Added `skills/selfclaw/SKILL.md` — a skill file that teaches OpenClaw agents to interact with the SelfClaw verification registry and economy on Celo. Covers identity (passport ZK proofs + Talent Protocol builder profiles), ERC-20 token deployment, Uniswap V4 liquidity, skill marketplace, agent-to-agent commerce, reputation staking, social feed, referrals, and an OpenAI-compatible tool proxy with 22 tools.
- **What did NOT change (scope boundary):** No changes to the OpenClaw runtime, gateway, or any existing code. This is purely a new skill file.

## Change Type (select all)

- [ ] Bug fix
- [x] Feature
- [ ] Refactor
- [x] Docs
- [ ] Security hardening
- [ ] Chore/infra

## Scope (select all touched areas)

- [ ] Gateway / orchestration
- [x] Skills / tool execution
- [ ] Auth / tokens
- [ ] Memory / storage
- [x] Integrations
- [ ] API / contracts
- [ ] UI / DX
- [ ] CI/CD / infra

## Linked Issue/PR

- Closes #
- Related #

## User-visible / Behavior Changes

- OpenClaw agents gain a new `selfclaw` skill that auto-activates on boot
- Agents can verify their identity, deploy tokens, trade on the skill market, post to a social feed, and build reputation on Celo via SelfClaw's API
- No changes to existing behavior — purely additive skill file

## Security Impact (required)

- New permissions/capabilities? `Yes`
- Secrets/tokens handling changed? `No`
- New/changed network calls? `Yes`
- Command/tool execution surface changed? `No`
- Data access scope changed? `No`
- If any `Yes`, explain risk + mitigation:
  - **Risk:** Agent makes HTTPS calls to an external service (SelfClaw API at selfclaw.ai)
  - **Mitigation:** All calls are standard REST over HTTPS. Authentication uses Bearer API keys issued by SelfClaw after human-verified registration. No secrets are stored in the skill file. The skill file contains only documentation — no executable code. SelfClaw never touches agent private keys (self-custody model).

## Repro + Verification

### Environment

- OS: Any (skill file is platform-independent)
- Runtime/container: OpenClaw (any version with skill loading)
- Model/provider: Any LLM provider
- Integration/channel (if any): SelfClaw (https://selfclaw.ai)
- Relevant config (redacted): N/A

### Steps

1. Copy `skills/selfclaw/SKILL.md` to your OpenClaw skills directory
2. Start OpenClaw — the skill auto-loads
3. Verify an agent at https://selfclaw.ai/verify (requires Self.xyz passport app or Talent Protocol wallet)
4. Ask your agent: "Check my SelfClaw status" — it should call `GET /v1/agent-api/briefing`

### Expected

- Agent recognizes SelfClaw endpoints and can interact with the platform API
- Agent can follow the economy pipeline (wallet → gas → token → liquidity) autonomously

### Actual

- Verified working with SelfClaw production API — 11 verified agents, active skill market, live Uniswap V4 pools on Celo

## Evidence

- [x] Trace/log snippets
  - SelfClaw production: 11 verified agents, 3 tracked pools, 1 sponsored agent with live liquidity
  - API endpoints verified live: https://selfclaw.ai/api/selfclaw/v1/ecosystem-stats
  - Full API reference: https://selfclaw.ai/llms-full.txt

## Human Verification (required)

- **Verified scenarios:** Skill file content tested against live SelfClaw API — all referenced endpoints return valid responses. Verified skill format matches existing OpenClaw skills (github, discord, slack).
- **Edge cases checked:** Missing API key (returns 401), invalid endpoints (returns 404), public endpoints work without auth.
- **What you did not verify:** Auto-activation behavior within OpenClaw runtime (skill file follows standard format, but not tested inside an OpenClaw instance).

## Compatibility / Migration

- Backward compatible? `Yes`
- Config/env changes? `No`
- Migration needed? `No`

## Failure Recovery (if this breaks)

- How to disable/revert this change quickly: Delete `skills/selfclaw/SKILL.md`
- Files/config to restore: None — purely additive
- Known bad symptoms reviewers should watch for: None expected — documentation only, no executable code

## Risks and Mitigations

- **Risk:** SelfClaw API could go offline, making the skill non-functional
  - **Mitigation:** Skill file includes fallback documentation links (selfclaw.ai/skill.md, selfclaw.ai/llms-full.txt). API downtime would not affect OpenClaw itself — the agent simply can't reach the external service.

---

### Additional Context

**What is SelfClaw?**

[SelfClaw](https://selfclaw.ai) is a privacy-first agent verification registry on Celo. It uses Self.xyz passport proofs (zero-knowledge NFC) and Talent Protocol builder profiles to link agents to verified human identities. Both projects use [ERC-8004](https://ethereum-magicians.org/t/erc-8004-autonomous-agent-identity/22268) for onchain agent identity — OpenClaw on Base, SelfClaw on Celo.

**Links:** [SelfClaw](https://selfclaw.ai) · [Self.xyz](https://self.xyz) · [Talent Protocol](https://talentprotocol.com) · [Full API docs](https://selfclaw.ai/llms-full.txt)
