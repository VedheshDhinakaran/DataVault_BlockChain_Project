# Slither static analysis notes

Tool: Slither 0.11.6 (102 detectors), run on `contracts/ConsentRegistry.sol` with
OpenZeppelin excluded. Full output: [`docs/slither-report.txt`](../docs/slither-report.txt).

```bash
pip install slither-analyzer          # Python 3.8+
cd contracts
npx hardhat compile
slither . --hardhat-ignore-compile --filter-paths node_modules
```

**Result: 9 findings, all informational. None are vulnerabilities and none needed a code change.**

| # | Detector | Where | Verdict | Explanation |
|---|----------|-------|---------|-------------|
| 1 | `incorrect-equality` | `getConsent`: `status == Status.None` | False positive | The detector targets strict equality on balances or other values an attacker can nudge. Here we compare an enum to detect "consent id does not exist", which is exact by design. |
| 2-9 | `timestamp` | `isAccessAllowed`, `isAccessAllowedByScan`, `getData`, `getConsent`, `isConsentEffective`, `_allows`, `_validateTerms`, `_activeConsentOwnedByCaller` | Accepted risk | Consent expiry has to be compared with `block.timestamp`. A validator can shift the timestamp by a few seconds at most, which is irrelevant for consents that expire after hours or days. Several of the flagged lines do not use the timestamp at all (e.g. `o == address(0)`); Slither flags every comparison in a function that reads `block.timestamp` somewhere. |

## Security properties checked by tests

The unit tests in `test/ConsentRegistry.test.js` also cover the access-control
paths Slither cannot judge:

* Only the data owner can grant, modify, revoke or update the data pointer (`NotDataOwner`).
* Only the admin can authorise gateways (`OwnableUnauthorizedAccount`); only authorised gateways can `logAccess` (`NotGateway`).
* `logAccess` re-checks consent, so a gateway cannot record an access that consent does not allow (`AccessNotAllowed`).
* Revoked consents cannot be modified or revoked again (`ConsentNotActive`); duplicates are rejected (`ConsentAlreadyExists`).
* Inputs are validated: zero/self requester, action mask outside 1..7, expiry in the past, empty CID or zero hash.

## Design choices that avoid common issues

* No ether is held or transferred, so there is no reentrancy surface and no `call` to external contracts.
* Custom errors instead of revert strings (cheaper, and decoded by the frontend).
* No unbounded loops in state-changing functions. The only loop is in `isAccessAllowedByScan`, a `view` kept for the loop-vs-mapping benchmark; the gateway uses the O(1) `isAccessAllowed`.
* No personal data on-chain: only CIDs of ciphertext, hashes, addresses, purpose hashes and permission flags.
