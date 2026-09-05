# sdk-probe: which @terminal3/t3n-sdk versions can open a verified testnet session?
Evidence script for docs/BUGS.md #0 (SDK >= 5.3.0 rejects testnet's trust manifest; the CLI pins 5.2.0).
Run `bash sdk-probe/run.sh` (defaults to 5.2.0 5.3.0 5.10.0) or `bash sdk-probe/run.sh 5.2.0 5.4.0`; `T3N_ENV=sandbox` switches environment.
Each version is installed alone in a temp dir and `probe.mjs` prints `OK` or `FAIL <reason>` for `fetchTrustedManifest(env)`; exit 1 if any FAIL.
Needs node >= 20, npm and network; nothing is written into the repo (no node_modules, no lock file).
