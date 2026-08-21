# Contributing

Thanks for your interest! This project is small but carefully maintained. Here is what you need to know.

## Local development

The server can run outside the add-on, against any HA instance, with a [long-lived access token](https://my.home-assistant.io/redirect/profile_security/):

```bash
cd mcp_ha
npm install
npm run build
HA_URL=http://homeassistant.local:8123 HA_TOKEN=your_long_lived_token \
MCP_API_TOKEN=a-dev-token npm start
```

The server listens on `http://localhost:9583/mcp`. Dev-mode limits: `ha_get_addons` returns a clear error (no Supervisor API outside the add-on). Useful environment variables: `LOG_LEVEL` (trace to fatal), `MCP_PORT`, `MCP_ALLOW_WRITE=true`.

Checks:

```bash
npm run build   # strict tsc
npm test        # vitest
```

To build the image the way the Supervisor would: comment out the `image:` line of `config.yaml` and add the repo folder as a local add-on repository, or use `docker build` in `mcp_ha/`.

## Documentation site

The site (English and French) lives in `docs/` and is built with VitePress:

```bash
npm install        # at the repository root
npm run docs:dev   # local preview
npm run docs:build
```

Any diagram in the documentation must be written with Mermaid.

## Pull request workflow

`main` is protected: no direct pushes, not even for admins. Every change, including maintainer and agent work, lands the same way:

1. Branch from an up-to-date `main` (always `git fetch` and rebase first: Dependabot merges happen on GitHub while you work).
2. Open a PR whose description references its issue: `Closes #N` (or `Refs #N` for partial work). No linked issue usually means the work should not start; open one first.
3. CI must be green (lint, build, typecheck, tests, image build and scan are required checks), then squash merge.
4. Individual commits that address an issue carry a `Refs #N` footer.

History is never rewritten: commit hashes are referenced by security advisories, issues and release tags. To link an already-pushed commit to an issue after the fact, use a commit comment.

## Release and infrastructure safety

Lessons learned from the 2026-08 audit, enforced from now on:

- **Pin against artifacts, not refs.** Before pinning an action or image, verify the pinned reference resolves to a real published artifact (`home-assistant/builder` uses its git ref as its own image tag, and some of its git tags have no published image).
- **Host-enforced features need a real host.** AppArmor profiles, ingress and anything applied by the Supervisor cannot be validated with `docker run`: test them on a disposable Home Assistant OS VM, never straight on a production instance. For AppArmor and interpreted scripts, grant `rix`, not `ix` alone.
- **Standalone containers differ from add-ons.** `bashio::config` queries the Supervisor API, not the local file: keep `run.sh` tolerant to a missing Supervisor so dev and CI smoke runs keep working.
- **Interacting limits are tested together** (e.g. history point caps versus the global response byte cap).

## Definition of done

No task (issue or PR) is finished until every point below holds:

1. **Unit tests**: any new or changed logic is covered by vitest tests, and `npm test` is green. Security-related code (`safety.ts`, authentication, permissions) always ships with tests.
2. **Documentation**: DOCS.md, the README and the documentation site (English root **and** French mirror under `docs/fr/`) reflect the change in the same commit set. Numbers quoted in the docs (caps, defaults, versions) must match the code.
3. **llms.txt**: `/llms.txt` and `/llms-full.txt` are regenerated automatically when the site builds, so keeping the site pages accurate is what keeps the LLM-facing docs accurate. Never let them drift from the shipped behaviour.
4. **CHANGELOG.md** gets a line for any user-visible change.
5. The related issue is commented and closed with a reference to the commits.

## Conventions

- **Languages**: documentation, code, logs and error messages are in English. Issues, commits and internal work discussions are in French: they are the maintainer's knowledge base.
- **Commits**: [conventional commits](https://www.conventionalcommits.org/), description in French. Usual types: `feat`, `fix`, `docs`, `ci`, `chore`, `refactor`, `test`.
- **Writing style**: natural and direct. No em dashes; prefer commas, colons or parentheses.
- **Issues as a knowledge base**: every design decision is captured in an issue labeled `décision` (closed once settled), every non-trivial pitfall in an issue labeled `écueil` with its cause and fix. Issue templates are provided. This is a project habit, not an option.
- **Security first**: any change touching `safety.ts`, authentication or the add-on permissions must come with tests and a SECURITY.md update when the behaviour changes.
- **Documentation**: when visible behaviour changes, DOCS.md, the README and the site change in the same PR, and CHANGELOG.md gets a line.

## Publishing a release

1. Bump the version in `mcp_ha/config.yaml`, `mcp_ha/package.json` and `mcp_ha/src/config.ts` (they must match, the release workflow checks all three at tag time).
2. Update `mcp_ha/CHANGELOG.md`.
3. Commit then tag:

   ```bash
   git tag v0.2.0 && git push origin main --tags
   ```

4. The `release.yaml` workflow builds the aarch64 and amd64 images, pushes them to ghcr and creates the GitHub Release with generated notes.
