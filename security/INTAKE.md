# Federal Cyber Intake Bundle

This document describes the artifacts produced by the
[`security-bundle`](../.github/workflows/security-bundle.yml) workflow and
how a receiving cyber team (e.g. LANL, DOE labs, federal customers) can
verify and consume them.

The bundle aligns with **NIST SSDF (SP 800-218)** and **EO 14028**
software-supply-chain expectations. It is the default response to
"send us the software for scanning."

## Three intake postures

We support three delivery options. Most teams start with **A**.

| | Posture | When to use | What we deliver |
|---|---|---|---|
| **A** | Static intake | Default. Enterprise / federal first-pass review. | This bundle (SBOMs + signed image + scan reports). |
| **B** | Source review under NDA | Reviewer policy requires source-level inspection. | Read-only GitHub access to named accounts, or a signed `git archive` tarball over a secure channel. |
| **C** | Dynamic / live instance | DAST, fuzzing, or higher-classification deployments. | Dedicated Azure App Service slot or the signed image (option A) for the customer to run inside their own enclave. |

Options B and C are arranged out-of-band; this document covers **A**.

## Bundle contents

Every release tag (`v*`) and every manual `workflow_dispatch` produces:

| File | Purpose | Format |
|---|---|---|
| `MANIFEST.txt` | Human-readable summary: ref, commit SHA, image reference, digest, build time, signature-verification command. | text |
| `SHA256SUMS` | SHA-256 of every other file in the bundle. | text |
| `sbom-python.cdx.json` | CycloneDX SBOM of declared Python dependencies (`requirements.txt`). | CycloneDX 1.x JSON |
| `sbom-container.cdx.json` | CycloneDX SBOM of the full container image (Python wheels + Debian base layer + apt packages). | CycloneDX 1.x JSON |
| `pip-audit.json` | CVE scan of Python deps against the PyPI advisory DB. | pip-audit JSON |
| `bandit.json` | Python SAST findings. | Bandit JSON |
| `semgrep.sarif` | SAST findings (Semgrep `p/python` + `p/owasp-top-ten` rule packs). | SARIF 2.1.0 |
| `trivy.sarif` | Container vuln scan (CRITICAL / HIGH / MEDIUM). | SARIF 2.1.0 |
| `trivy.json` | Same scan in JSON, suitable as input to a VEX triage. | Trivy JSON |

Plus, attached to the OCI image (not in the bundle directory):

- **Cosign signature** (Sigstore keyless via Fulcio, transparency-logged in
  Rekor) on the image digest.
- **SLSA build provenance attestation** (`provenance: mode=max`).
- **SBOM attestation** built into the image by Buildx.

## Where to get the bundle

1. **GitHub Releases** — every tag attaches the bundle files directly to the
   release page (`https://github.com/probloch/pyth-sched-analytics/releases`).
2. **Workflow artifacts** — the workflow run page exposes the same files for
   90 days under "Artifacts."
3. **Container image** — `ghcr.io/probloch/pyth-sched-analytics:<tag>`,
   pinned by the digest in `MANIFEST.txt`.

Out-of-band delivery (signed tarball over GovCloud SFTP, etc.) is available
on request.

## Verifying the bundle

### 1. Verify file integrity

```bash
sha256sum -c SHA256SUMS
```

### 2. Verify the image signature (Sigstore keyless)

```bash
IMAGE=ghcr.io/probloch/pyth-sched-analytics
DIGEST=<sha256:...>   # from MANIFEST.txt

cosign verify "${IMAGE}@${DIGEST}" \
  --certificate-identity-regexp 'https://github.com/probloch/pyth-sched-analytics/.github/workflows/security-bundle.yml@.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

A successful verification proves the image was built by this repo's
`security-bundle` workflow and recorded in the public Rekor transparency
log — no shared secret or long-lived signing key is involved.

### 3. Inspect the SLSA provenance attestation

```bash
cosign verify-attestation "${IMAGE}@${DIGEST}" \
  --type slsaprovenance \
  --certificate-identity-regexp 'https://github.com/probloch/pyth-sched-analytics/.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

### 4. Run your own scans

The image follows hardened conventions:

- Non-root user (`appuser`, created in the Dockerfile).
- Slim base (`python:3.12-slim`).
- No build-time secrets; all configuration is read from environment
  variables at runtime.
- HTTP healthcheck on `GET /health` (port 8000).

Any DAST tooling can be pointed at a running container; the JSON API
surface and per-endpoint contracts are documented under
[`docs/api/`](../docs/api/README.md).

## Reproducibility

To rebuild the same artifacts locally from a tag:

```bash
git checkout <tag>
docker build -t pyth-sched-analytics:<tag> .
syft pyth-sched-analytics:<tag> -o cyclonedx-json=sbom-container.cdx.json
trivy image -f json -o trivy.json pyth-sched-analytics:<tag>
```

Python-side SBOM and SAST:

```bash
pip install cyclonedx-bom pip-audit bandit semgrep
cyclonedx-py requirements -i requirements.txt -o sbom-python.cdx.json --output-format JSON
pip-audit -r requirements.txt -f json -o pip-audit.json
bandit -r . -x ./tests,./Reference -f json -o bandit.json
semgrep --config p/python --config p/owasp-top-ten --sarif --output semgrep.sarif .
```

The image digest from a local rebuild will differ from the published one
(timestamps, base-image refresh) — for byte-exact reproducibility, pull
the published image by digest from GHCR.

## VEX (Vulnerability Exploitability eXchange)

A CycloneDX VEX document is **not** generated automatically — VEX
requires per-CVE triage that depends on how a finding is exercised in
deployment. On request, we will produce a VEX from `trivy.json` for a
specific release, marking each CVE as `not_affected` /
`under_investigation` / `affected` with the appropriate justification.

## Contact

Vulnerability disclosure and bundle requests: see
[`SECURITY.md`](../SECURITY.md) at the repo root (when present), or
contact the maintainers via the channel agreed in your NDA.
