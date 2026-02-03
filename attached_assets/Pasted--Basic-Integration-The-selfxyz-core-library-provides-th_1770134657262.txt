# Basic Integration

The `@selfxyz/core` library provides the essential building blocks to integrate Self’s verification flows into your backend. It contains utilities, types, and helpers for working with scopes, configs, and verification data.

Within this library, the `SelfBackendVerifier` class is the main tool you’ll use on the server. It helps you verify that the proofs produced by the frontend/mobile flow are valid against the on‑chain hub and your configured rules.

{% hint style="info" %}
Make sure your version of @selfxyz/core is >= 1.1.0-beta.1. Versions prior to this use Celo Alfajores for mock passports and will not verify correctly.
{% endhint %}

## Creating a verifier instance

You typically instantiate a `SelfBackendVerifier` once with your chosen **scope**, **endpoint**, and other settings.

```typescript
import { 
    SelfBackendVerifier, 
    DefaultConfigStore, 
    AllIds 
} from '@selfxyz/core'

const selfBackendVerifier = new SelfBackendVerifier(
    'docs', // scope string
    'https://docs.self.xyz/api/verify', // endpoint (your backend verification API)
    true, // mockPassport → true = testnet, realPassport → false = mainnet
    AllIds, // allowed attestation IDs map
    new DefaultConfigStore({ // config store (see separate docs)
        minimumAge: 18,
        excludedCountries: ['USA'],
        ofac: false,
    }),
    'hex' // user identifier type
);
```

### Parameters

* **scope**: identifier for your application. Must match the frontend scope.
* **endpoint**: the URL where your proofs will be verified (including the route). Must match the frontend endpoint.
* **mockPassport**: toggle to use testnet/staging vs mainnet hub.
* **allowedIds**: map of attestation IDs you want to accept.
* **configStorage**: implementation of `IConfigStorage` (for now, use `DefaultConfigStore` or `InMemoryConfigStore` see [configstore](https://docs.self.xyz/backend-integration/configstore "mention")).
* **userIdentifierType**: either `'uuid'` or `'hex'` (depending on how your frontend built the user identifier).

## Verifying a proof

Call `.verify()` with the attestation ID, proof, public signals, and user context data. These will be passed to your endpoint from Self's relayers. The verifier will check validity against on‑chain contracts and your config store.

```typescript
const result = await selfBackendVerifier.verify(
    attestationId, // e.g. AttestationId.Passport
    proof, // zkSNARK proof object
    pubSignals, // array of public signals from prover
    userContextData //user context data
);

console.log(result)
```

### Example output

```json
{
    "attestationId": 1,
    "isValidDetails": {
        "isValid": true,
        "isMinimumAgeValid": true,
        "isOfacValid": false
    },
    "forbiddenCountriesList": ["USA"],
    "discloseOutput": {
        "minimumAge": "18",
        "nationality": "IND",
        "gender": "M"
    ...
    },
    "userData": {
        "userIdentifier": "8e4e6f24-...",
        "userDefinedData": "..." //what you pass in the qrcode
    }
}
```

## Using in an API endpoint

You’ll usually expose this via a backend route that your Self's relayers call after creating your proof.

{% hint style="warning" %}
Since your API must be reachable to Self's relayers, we recommend you use `ngrok` to tunnel requests to your local API endpoint during development and then set this API in your frontend and backend.
{% endhint %}

```typescript
import express from "express"
import bodyParser from "body-parser"
import { SelfBackendVerifier } from "@selfxyz/core"
import { AllIds } from "./utils/constants.js"
import { DefaultConfigStore } from "./store/DefaultConfigStore.js"

const app = express()
app.use(bodyParser.json())

const selfBackendVerifier = new SelfBackendVerifier(
  process.env.SELF_SCOPE_SEED,
  process.env.SELF_ENDPOINT,
  true,
  AllIds,
  new DefaultConfigStore({
    minimumAge: 18,
    excludedCountries: ["USA"],
    ofac: false,
  }),
  "hex"
)

app.post("/api/verify", async (req, res) => {
  try {
    const { attestationId, proof, publicSignals, userContextData } = req.body
    if (!proof || !publicSignals || !attestationId || !userContextData) {
      return res.status(200).json({
        status: "error",
        result: false,
        reason: "Proof, publicSignals, attestationId and userContextData are required",
      })
    }

    const result = await selfBackendVerifier.verify(
      attestationId,
      proof,
      publicSignals,
      userContextData
    );

    const { isValid, isMinimumAgeValid } = result.isValidDetails;
    if (!isValid || !isMinimumAgeValid) {
      let reason = "Verification failed"
      if (!isMinimumAgeValid) reason = "Minimum age verification failed"
      return res.status(200).json({
        status: "error",
        result: false,
        reason,
      })
    }

    return res.status(200).json({
      status: "success",
      result: true,
    })
  } catch (error) {
    return res.status(200).json({
      status: "error",
      result: false,
      reason: error instanceof Error ? error.message : "Unknown error",
    });
  }
})

app.listen(3000, () => {
  console.log("Server listening on http://localhost:3000");
})
```

{% hint style="info" %}
Notice however that the `status` of the http request is 200 regardless of whether the inputs were correct / wrong and if the proof was verified or not. In general, you will need to follow the format below when creating an API.
{% endhint %}

## Endpoint API Reference

<mark style="color:green;">`POST`</mark> `/api/verify`

Verifies a Self Identity proof.

**Headers**

| Name         | Value              |
| ------------ | ------------------ |
| Content-Type | `application/json` |

**Body**

<table><thead><tr><th>Name</th><th>Type</th><th>Description</th></tr></thead><tbody><tr><td><code>attestationId</code></td><td>number</td><td>The id of the document being verified.</td></tr><tr><td><code>proof</code></td><td><pre><code>{
    a: [string, string],
    b: [[string, string], 
        [string, string]],
    c: [string, string]
}
</code></pre></td><td>The self identity proof.</td></tr><tr><td><code>publicSignals</code></td><td><code>string[]</code></td><td>The public signals for the proof</td></tr><tr><td><code>userContextData</code></td><td>string</td><td>Contains information about the user id and app defined user data.</td></tr></tbody></table>

**Response**

{% tabs %}
{% tab title="200 (success)" %}

```json
{
    status: "success",
    result: true,
}
```

{% endtab %}

{% tab title="200 (error)" %}

```json
{
    status: "error",
    result: false,
    reason: "Not enough inputs",
}
```

{% endtab %}
{% endtabs %}

## Accepting only certain type of documents

If you want to only accept certain types of documents (for example if you don't want to use Aadhaar) then you can create a map that has all attestation ids other than Aadhaar.

```typescript
import { ATTESTATION_ID, AttestationId } from "@selfxyz/core"

const allowedIds = new Map<AttestationId, boolean>([
    [ATTESTATION_ID.PASSPORT, true],
    [ATTESTATION_ID.BIOMETRIC_ID_CARD, true],
]);
```
