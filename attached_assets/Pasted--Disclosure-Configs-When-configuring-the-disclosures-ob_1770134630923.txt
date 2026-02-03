# Disclosure Configs

When configuring the disclosures object in your Self app, you define both verification rules and data disclosures. These determine what the Self mobile app will check for and what data users will reveal during verification.

## Verification Rules

Verification rules let you express compliance and eligibility requirements. They run automatically when the proof is generated.

```typescript
disclosures: {
  // Age verification
  minimumAge: 18,

  // Geographic restrictions
  excludedCountries: ["USA", "RUS"],

  // Compliance checking
  ofac: false,
}
```

### `minimumAge`

* **Purpose:** Ensures the user is at least this age. The check is done on the verified date of birth attribute.
* **Example**: `minimumAge: 18` ensures only adults proceed.

### `excludedCountries`

* **Purpose**: Blocks users whose nationality or residence matches any listed country.
* **Example**: `excludedCountries: ["USA", "RUS"`] rejects users from the US or Russia.

### `ofac`

* **Purpose**: Enables or disables screening against the OFAC sanctions list.
* **Example**: `ofac: true` rejects sanctioned users. `false` skips the check.

## Data Disclosures

Data disclosures define **what attributes are revealed** from the user’s verified identity. You can choose to request personal or document data depending on your use case. Since these are not claims, they are not enforced by your backend / contracts.

## Frontend & Backend Alignment

{% hint style="warning" %}
**Important**: The disclosure configuration used on the **frontend** (in your app) **must exactly match** the configuration enforced on the **backend/contracts**.
{% endhint %}

* **Example**: If the backend requires `minimumAge: 18` but the frontend only specifies 21, verification will fail (and vice versa).
* **Example:** If the contracts require `excludedCountries: ["USA"]` and your frontend only specifies `excludedCountries: ["USA", "RUS"]` then your transaction is going to fail.

Note that in both these cases even though the backend requires a less strict verification config, the transaction/request IS going to fail as the configs are not the same.

{% hint style="success" %}
**Best practice**: Centralize your disclosure config (e.g., in a shared constants file or service) and import it into both frontend and backend to avoid drift.
{% endhint %}
