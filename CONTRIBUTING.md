# Contributing Guide

Thank you for helping improve this project.

## Before You Start

- Read and follow the [Code of Conduct](CODE_OF_CONDUCT.md).
- Check open issues and pull requests to avoid duplicate work.
- For large changes, open an issue first to align on scope.

## Ways To Contribute

- Bug reports and reproducible test cases
- Feature proposals and design feedback
- Runtime and extension implementation work
- Prompt, docs, and DX improvements
- Tests, CI, and release process hardening

## Issue Reporting

- Use [Bug Report](.github/ISSUE_TEMPLATE/bug_report.yml) for reproducible defects.
- Use [Feature Request](.github/ISSUE_TEMPLATE/feature_request.yml) for enhancements.
- Search existing issues before opening a new one.
- Keep reports focused, minimal, and actionable.
- Do not file vulnerabilities in public issues; follow [SECURITY.md](SECURITY.md).

## Development Setup

### Prerequisites

- Go 1.22+
- Node.js 20+
- VS Code

### Install and Build

1. Build runtime dependencies:

```bash
cd runtime
go mod tidy
```

2. Build extension dependencies:

```bash
cd extension
npm ci
npm run build
```

3. Run the runtime locally:

```bash
cd runtime
go run ./cmd/agentd
```

## Branching and Commits

- Create focused branches from `main`.
- Keep each pull request scoped to a single concern.
- Use clear commit messages that describe intent and impact.

Suggested branch prefixes:

- `feature/` for new behavior
- `fix/` for bug fixes
- `docs/` for documentation-only changes
- `chore/` for maintenance updates

## Validate Changes Locally

Run these checks before opening a pull request:

```bash
cd extension && npm ci && npm run build
cd runtime && go test ./...
```

If your change touches docs or prompts, verify links and examples still work.

## Pull Request Process

- Use one of the existing pull request templates in [.github/PULL_REQUEST_TEMPLATE](.github/PULL_REQUEST_TEMPLATE).
- Explain the problem, solution, and any tradeoffs.
- Add screenshots or recordings for UI changes.
- Mention follow-up work if scope is intentionally limited.

A good PR is:

- Reviewable in one pass
- Backward-compatible unless explicitly documented
- Matched with docs and prompt updates when behavior changes

## Documentation Expectations

Update related docs when behavior, command names, APIs, or workflows change.

Primary documentation entry points:

- [README.md](README.md)
- [docs/getting-started.md](docs/getting-started.md)
- [docs/architecture/prompt-architecture.md](docs/architecture/prompt-architecture.md)

## Security Issues

Please do not open public issues for suspected vulnerabilities.
Follow [SECURITY.md](SECURITY.md) for private reporting guidance.
