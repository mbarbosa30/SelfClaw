# Introduction & Overview

## Self Connect: Introduction & Overview

### What is Self Connect

Self Connect is an open-source protocol that maps off-chain personal identifiers (such as phone numbers, Twitter handles, email addresses, etc.) to on-chain blockchain addresses. It enables a convenient and interoperable user experience by allowing users to discover and transact with each other using familiar identifiers instead of complex hexadecimal addresses.

Self Connect uses a federated model, meaning that anyone has the power to be an issuer of attestation mappings. Issuers have the freedom to decide how to verify that users actually have ownership of their identifiers. After verification, issuers register the mapping as an attestation to the on-chain smart contract registry.

### Key Concepts

#### Plaintext Identifiers

A `plaintextIdentifier` is any string of text that a user can use to identify another user. This makes it easier to represent an EVM-based address in a human-readable format.

**Examples:**

* Phone number: `+12345678901`
* Twitter handle: `@alice`
* Email address: `alice@example.com`
* GitHub username: `alicecodes`

#### Obfuscated Identifiers

An `obfuscatedIdentifier` is the identifier used on-chain, to which the account address is mapped. It preserves user privacy by not revealing the underlying plaintext identifier.

The obfuscated identifier is obtained by hashing the plaintext identifier, identifier prefix, and pepper using the following schema:

```
sha3(sha3({prefix}://{plaintextIdentifier})__{pepper})
```

This ensures that even if someone monitors on-chain attestation events, they cannot determine which phone number or social handle belongs to which address without access to the pepper.

#### Identifier Prefix

Identifier prefixes are used to differentiate users having the same plaintext identifier for different purposes and to enable composability across applications.

**Example:** Consider Alice having the same username on both Twitter and GitHub: `alicecodes`

* Twitter identifier: `twitter://alicecodes`
* GitHub identifier: `github://alicecodes`

By using prefixes, dApps can differentiate between verification methods. If dApps follow a standard prefix convention, the corresponding obfuscated identifiers will be consistent, making it easier to lookup identifiers verified by different issuers.

**Standard Prefixes:**

* Phone numbers: `PHONE_NUMBER`
* Twitter: `twitter://`
* GitHub: `github://`
* Email: `email://`

#### Pepper

A `pepper` is a unique secret obtained by taking the first 13 characters of the SHA256 hash of the unblinded signature from ODIS (Oblivious Decentralized Identifier Service).

The pepper is crucial for privacy preservation because:

* No single party can compute it unilaterally
* It prevents rainbow table attacks
* It's unique per identifier

#### Unblinded Signature

The unblinded signature is obtained by unblinding the signature returned by ODIS, which is the combined output comprised of signatures from multiple ODIS signers.

#### Issuers

An **issuer** is an entity willing to take on the responsibility of verifying a user's ownership of an identifier. Issuers:

* Perform verification (e.g., SMS verification for phone numbers, OAuth for social accounts)
* Register attestations on-chain
* Are trusted by applications that rely on their attestations
* Can be anyone - Self Connect is open and permissionless

**Active Issuers:**

| Issuer Name | Address                                                                                                                                         |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Kaala       | `0x6549aF2688e07907C1b821cA44d6d65872737f05` (mainnet)                                                                                          |
| Libera      | <p><code>0x388612590F8cC6577F19c9b61811475Aa432CB44</code> (mainnet)<br><code>0xe3475047EF9F9231CD6fAe02B3cBc5148E8eB2c8</code> (alfajores)</p> |

#### Attestations

Attestations are on-chain mappings between an obfuscated identifier and a blockchain address. Each attestation is associated with the issuer that registered it. When looking up attestations, applications decide which issuers to trust.

#### Federated Model

Self Connect uses a federated attestation model where:

* Multiple issuers can exist independently
* Each issuer maintains their own verification standards
* Applications choose which issuers to trust
* No single point of failure or control

### Use Cases

#### 1. Payments to Phone Numbers

Send cryptocurrency directly to a friend's phone number without needing to know their wallet address.

**Example:** A Kaala wallet user can send funds to a Libera wallet user using only their phone number.

#### 2. Social Discovery

Find someone's blockchain account based on their social media handle or other identifiers.

**Example:** Discover a user's wallet address by their Twitter handle to send them tokens or NFTs.

#### 3. Cross-Wallet Interoperability

Enable seamless transactions across different wallet applications by mapping identifiers to addresses.

**Example:** Users registered in different wallet ecosystems can find and transact with each other using shared identifiers.

#### 4. MiniPay Integration

MiniPay leverages Self Connect to enable phone number-based transactions, making cryptocurrency payments as simple as traditional mobile money transfers.

#### 5. Social Applications

Build social applications where users can connect using familiar identifiers instead of wallet addresses.

#### 6. Contact List Integration

Import phone contacts and automatically discover which contacts have cryptocurrency wallets.

### Why Self Connect

#### Privacy Preservation

Self Connect uses ODIS (Oblivious Decentralized Identifier Service) to ensure that:

* Identifiers are obfuscated before being stored on-chain
* No single party can reverse the obfuscation
* Rainbow table attacks are prevented through rate limiting
* Users' sensitive information remains private

#### Open and Decentralized

* **Permissionless:** Anyone can become an issuer
* **Federated:** No central authority controls attestations
* **Open Source:** Full transparency and community-driven development
* **Composable:** Applications can build on existing attestations

#### Cost-Effective

Self Connect is economical for issuers:

* **10 cUSD of ODIS quota = 10,000 user attestations**
* Lookup operations require no gas (only ODIS quota)
* Registration can be paid by either issuer or user

#### Flexible Verification

Issuers have complete control over their verification methods:

* SMS verification for phone numbers
* OAuth for social accounts
* Email verification
* Custom verification logic

#### Interoperability

Standard identifier prefixes enable cross-application compatibility:

* Attestations from one issuer can be used by multiple applications
* Users don't need to re-verify for each application
* Ecosystem-wide identifier mapping

### Architecture Overview

Self Connect consists of three main components:

#### 1. FederatedAttestations Smart Contract

The on-chain registry where attestation mappings are stored. Each attestation includes:

* Obfuscated identifier
* Account address
* Issuer address
* Verification timestamp

#### 2. ODIS (Oblivious Decentralized Identifier Service)

A decentralized service that provides privacy-preserving identifier obfuscation:

* Distributed across multiple operators
* Uses threshold cryptography
* Rate-limited to prevent abuse
* Provides peppers for identifier hashing

#### 3. Issuer Infrastructure

Applications or services that:

* Verify user ownership of identifiers
* Query ODIS for obfuscated identifiers
* Register attestations on-chain
* Maintain ODIS quota

### Getting Started

To integrate Self Connect:

1. **As an Application:** Choose trusted issuers and lookup attestations
2. **As an Issuer:** Set up verification infrastructure and register attestations
3. **As a User:** Get verified by issuers to map your identifiers to your address

Continue to the next sections for detailed architecture and implementation guides.
