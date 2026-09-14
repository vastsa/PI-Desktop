# Security Policy

PI-Desktop is an early-preview, local-first desktop application. We take
security reports seriously and appreciate responsible disclosure.

## Supported Versions

Security fixes are provided for the latest release published on the
[GitHub Releases page](https://github.com/vastsa/PI-Desktop/releases). Older
releases and development builds may not receive security fixes.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
pull requests, or discussions.**

Send a private report to **hhxk666@gmail.com** with the subject:

```text
[PI-Desktop Security] <short description>
```

If private vulnerability reporting is enabled for this repository, you may
also use GitHub's private security advisory form:

<https://github.com/vastsa/PI-Desktop/security/advisories/new>

Please include as much of the following information as you can:

- A clear description of the vulnerability and its security impact.
- The affected PI-Desktop version, operating system, and installation type.
- Reproduction steps or a minimal proof of concept.
- The affected component, feature, configuration, or extension boundary.
- Any relevant logs, screenshots, stack traces, or suggested remediation.

Please remove API keys, access tokens, passwords, private source code, personal
data, and other sensitive information before sending a report. Do not test
against other users, access data that does not belong to you, or perform
destructive actions. PI-Desktop does not currently operate a bug bounty
program.

## Response and Disclosure

We aim to acknowledge a report within 7 calendar days and provide an initial
assessment within 14 calendar days. We will keep the reporter informed about
triage, remediation, and release plans when appropriate.

Please allow us reasonable time to investigate and release a fix before making
the vulnerability public. We will coordinate a disclosure date with the
reporter whenever possible and will credit the reporter in release notes only
with their permission.

## Scope

Reports are generally in scope when they affect the PI-Desktop application,
official release artifacts, Electron main or preload boundaries, the Rust host
core, the agent runtime, or the handling of credentials, permissions, local
files, plugins, MCP servers, or IPC/RPC messages.

Issues that affect only a third-party provider, model service, operating
system, dependency, or user-installed extension should also be reported to the
relevant maintainer. They are still in scope for PI-Desktop if the application
introduces an exploitable integration, permission, sandbox, or credential
handling weakness.
