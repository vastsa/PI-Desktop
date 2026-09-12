# Privacy Policy

**Effective date: 2026-09-10**

This Privacy Policy describes how PI-Desktop handles information when you use
the PI-Desktop desktop application. PI-Desktop is a local-first, open-source
project maintained by contributors to [vastsa/PI-Desktop](https://github.com/vastsa/PI-Desktop).

This policy describes the current application behavior. It is not legal advice;
operators who distribute a modified build or offer an additional hosted service
are responsible for providing any notices required for that service.

The documentation website is a separate static service. Its current
configuration loads fonts from Google Fonts, so a page visit can send a request
and network metadata to Google. The website host may also process ordinary
server access logs. Those providers' own privacy policies apply to that
processing.

## 1. Privacy at a glance

- PI-Desktop does not require a PI-Desktop account.
- Projects, sessions, settings, transcripts, and application logs are stored
  locally by default.
- PI-Desktop does not currently operate a remote telemetry pipeline or cloud
  crash-analytics service.
- Your prompts, files, tool results, and other content may be sent to the model
  provider, gateway, local model server, plugin, or MCP server that you choose
  or invoke.
- API keys and OAuth credentials are stored in the application's local
  encrypted secret store. The current host implementation uses AES-256-GCM
  encrypted files and a machine-local key.

## 2. Information stored locally

Depending on the features you use, PI-Desktop may store the following on your
computer:

- project paths and project/session metadata;
- prompts, model responses, thinking blocks, attachments, tool calls, tool
  results, and Plan or Goal artifacts;
- provider, model, interface, and application settings;
- API-key and OAuth-credential metadata, while raw credentials remain in the
  encrypted local secret store and are not shown in the UI;
- plugin code, plugin settings, plugin-owned data, and plugin logs;
- application, host, agent, and audit logs;
- temporary files, caches, review snapshots, and other operational data; and
- a bounded in-memory clipboard history containing explicit clipboard writes
  and user-initiated paste events. It may retain up to 500 entries or 256 MB for
  up to 30 days, and plugins with clipboard permission may read it.

Some of this information can contain personal data or confidential source code.
PI-Desktop treats it as user data and does not upload it to PI-Desktop merely
because it is stored locally.

## 3. Information sent to other services

PI-Desktop is a client. Network destinations depend on your configuration and
actions.

### 3.1 Model providers and gateways

When you send a prompt or start an agent turn, the application sends the
content needed for that request to the provider, gateway, or local model server
selected by you. Depending on the request, this can include conversation
history, project excerpts, tool results, attachments, provider/model metadata,
and instructions loaded from your workspace.

The selected provider's privacy policy and retention practices apply to data it
receives. A provider may be hosted by a third party even when it is configured
through an OpenAI-compatible endpoint. Review the endpoint and provider terms
before sending confidential information.

### 3.2 Plugins and MCP servers

Plugins and MCP servers can be local or remote. Through PI-Desktop host APIs,
a plugin or MCP server receives data involved in an operation you invoke or
authorize, but its own code and service may process that data under its own
terms. A remote MCP server may also receive protocol initialization and tool
catalog requests (including `initialize` and `tools/list`) before any tool is
called. Review permissions, source, and privacy practices before installing or
enabling one.

PI-Desktop does not intentionally expose the host secret store through its
documented plugin APIs. However, plugin code currently runs locally with the
user's operating-system privileges and is not fully capability-sandboxed. Treat
all plugins, especially marketplace packages, as user-privileged third-party
code. Marketplace packages and remote MCP servers are third-party software and
services.

### 3.3 Catalogs, updates, links, and media

The application may contact configured model catalogs, plugin marketplace
endpoints, GitHub release/update endpoints, provider OAuth endpoints, and
other services required by features you enable. Those services may receive
network metadata such as your IP address and user agent.

Links opened through the application are handled by the operating system or an
external browser. Markdown written by a model may include remote images,
audio, or video; when rendered, the relevant host may receive a request from
your computer. Do not include sensitive data in URLs or remote media requests.

### 3.4 Local control interfaces

The optional local MCP control plane is disabled by default and binds to the
loopback interface when enabled. It is intended for trusted local clients, not
for remote access or untrusted local users. Protect the local user-data
directory and its bearer token.

## 4. What PI-Desktop does not do

PI-Desktop does not currently:

- sell personal information or use it for advertising;
- require registration with PI-Desktop to use the desktop application;
- send application telemetry to a PI-Desktop-operated remote analytics service;
  or
- send raw provider credentials to the renderer, application logs, or plugins.

A modified build, third-party plugin, configured provider, marketplace, MCP
server, or hosting provider may have different practices.

## 5. How information is used

Information is used to:

- run agent sessions and provide the features you request;
- save and restore local sessions, projects, settings, and review history;
- execute and audit tools according to the permission policy;
- store, load, update, and remove plugins and their local data;
- diagnose failures through local logs; and
- check for application, model-catalog, or plugin updates. Packaged builds
  may check the configured GitHub release endpoint after startup and roughly
  every six hours while running.

PI-Desktop does not use your local project or transcript content for its own
model training. A model provider or other service may have its own training and
retention policy; consult that service before using it.

## 6. Retention and deletion

PI-Desktop keeps local data until you remove it, subject to normal filesystem,
backup, and operating-system behavior.

- Sessions and transcripts are not automatically deleted by age. Delete a
  session from the application to remove its session records and transcript
  files.
- Application, host, and agent logs are size-capped and rotated. Audit records
  are retained locally and normally pruned after 90 days.
- Temporary session scratch data is removed with the session, and disposable
  caches may be recreated or removed during maintenance.
- Provider credentials remain until you remove the provider or credential,
  or remove the application's local data. Ordinary application uninstall may
  leave the local data directory behind; filesystem and backup copies require
  separate removal.
- Plugin code, plugin data, and plugin-specific logs are removed according to
  the uninstall flow. Plugin diagnostics written to shared application logs
  may remain until log rotation or application-data deletion. A plugin may also
  maintain data outside PI-Desktop if its own code creates it there.

Deleting local data does not delete copies already sent to a provider, plugin,
MCP server, update service, or other third party. Request deletion from that
service under its own policy.

## 7. Security

PI-Desktop uses local process boundaries, renderer sandboxing, workspace path
checks, permission prompts, secret redaction, and encrypted local secret files.
Plugin capability sandboxing is not complete. No security measure is perfect.
You are responsible for protecting your computer, project files, credentials,
local user-data directory, and any local control token.

Agent tools and shell commands run with the user's operating-system privileges
when allowed. Treat prompts, model output, plugins, MCP servers, and remote
content as untrusted. Do not grant permissions to software you do not trust.

## 8. Your choices and privacy requests

You can control data collection and exposure by:

- choosing a local model or a provider you trust;
- reviewing provider, plugin, MCP, and shell permissions before use;
- disabling plugins and optional network features;
- deleting sessions, credentials, logs, plugins, and application data locally;
  and
- avoiding personal or confidential information in prompts, public issue
  reports, URLs, and remote media.

Where applicable law gives you rights to access, correct, export, restrict, or
delete personal information, contact the maintainers first. Because PI-Desktop
is local-first, the maintainers generally do not possess your local project,
transcript, or credential data and may be unable to retrieve or delete it for
you. You can contact the project through the
[GitHub repository](https://github.com/vastsa/PI-Desktop); do not post personal
or confidential information in a public issue.

## 9. Children

PI-Desktop is a general-purpose developer tool and is not directed to children.
We do not knowingly collect personal information from children through a
PI-Desktop-operated service.

## 10. Changes to this policy

This policy may be updated when the application's data practices change. The
effective date at the top will identify the current version. Material changes
will be communicated through the repository or release notes when practical.

## 11. Contact

For privacy questions, use the [PI-Desktop GitHub repository](https://github.com/vastsa/PI-Desktop).
For security vulnerabilities, follow the repository's security reporting
instructions rather than disclosing sensitive details in a public issue.
