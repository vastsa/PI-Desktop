---
title: MCP market
description: Add a public MCP catalog, supply your own credential, and remove a source or an installed server.
---

# MCP market

Open **Settings** from the sidebar footer (or search **MCP** in **Search settings…**).
Under **Agent**, open **MCP**, then **Market**. This is the MCP server list, separate
from the plugin marketplace. **My servers** returns to the servers you have saved.
The sidebar footer shows the app version. The steps below match v0.15.2 and later; the last section describes v0.15.1.

[中文版本](/zh-CN/guide/mcp-market)

## Three lists

**Market** merges three lists. Built-in rows stay on screen when a remote source fails.

| List | Where it comes from | What you can change |
|---|---|---|
| Built-in catalog | Servers shipped inside the app. They appear immediately, including while the network is off. | Leave it as shipped. It has no URL. |
| Official Registry | The built-in source **Official registry**, kind **Registry API**, at `https://registry.modelcontextprotocol.io/v0/servers`. | It remains in **Sources**. **Remove** is on the other rows. |
| Catalog JSON | A static JSON file you publish at a public HTTPS URL. | Add it under **Sources** with kind **Catalog JSON**. |

**Sources** can also hold another **Registry API** address. That address is queried with the official registry protocol (`version`, `limit`, and `search` or a cursor). A **Catalog JSON** address is fetched once as a JSON document, with no registry query string.

A registry record is shown when the app can install it. npm is preferred, then PyPI, then a public HTTPS `streamable-http` remote. The registry's package version and launch arguments are kept. A record that only offers another package type is omitted. A PyPI row includes the prerequisite text `Requires uv/uvx on PATH`.

A remote card carries a badge with the source's stored name. The built-in registry source is stored as `Official registry`. The badge reads **Registry** when that name cannot be resolved. A built-in card has no remote badge. When a remote entry reuses a built-in id, the built-in entry is the one shown.

**Search servers** matches name, description, and author. The chips are **All**, **Dev tools**, **Web**, **Docs**, **Data**, and **Productivity**. Registry search runs on the registry service. A catalog file is loaded, then filtered on this machine. **Load more** asks a registry source for further pages.

## Add a public catalog

1. On **MCP Market**, choose **Sources**. The button shows the current count, such as **Sources · 1**.
2. The sheet explains the split: registry sources speak the official MCP registry protocol; catalog sources are static JSON files in the market schema.
3. Type a **Source name**, or leave it empty to use the hostname.
4. Paste a credentials-free public `https://` URL. The field placeholder is `https://… (registry endpoint or catalog JSON)`.
5. Select **Catalog JSON**. The form opens on **Registry API**. A catalog URL left on **Registry API** is queried as a registry, so the JSON file is not read as a catalog.
6. Choose **Add source**.

The market accepts a public HTTPS URL with no username or password. Loopback, private, link-local, and names such as `localhost` are refused, and the toast says **Source URL must be a public https address**. Each request allows an 8-second deadline, a 4 MiB body, and up to five public HTTPS redirects. At most 16 sources are queried, and **Official registry** remains one of them. The list is remembered in this app on this computer.

A private or plain-HTTP endpoint belongs in the manual editor. On **My servers**, choose **Add**. That editor accepts `http` and `https` and, for unencrypted HTTP, shows **This HTTP connection is not encrypted. Credentials and tool calls may be intercepted.** See [ADR 0142](/adr/0142-allow-non-loopback-http-mcp) and [ADR 0245](/adr/0245-mcp-market-public-network-boundary).

When no remote entry comes back and a source failed, the page shows **Registry unreachable — showing built-in picks** and the failed source names. Built-in servers remain either way. A catalog that fails while the registry still returns rows is left out of the list; that sentence stays hidden, and the registry rows remain.

## Inspect the endpoint and install

A card shows the command line or the endpoint URL, still containing placeholders, and the description.

Choose **Install**. The dialog shows:

- **Will be saved as** — the same command line or URL template. Header text is not printed in that block.
- **Prerequisites:** and **Notes:** when the entry includes them.
- **Required values** — one masked field for each declared input. The label is the variable name. The hint is the entry's description, plus **optional** when the field may stay empty. A published default is filled in.
- **Nothing runs until the server connects for the first time.**

The catalog file holds placeholders. You type the key. **Install** writes that value into the saved server (an environment entry for a local command, a header for an HTTP endpoint) and returns to **My servers**. The catalog URL is left unchanged. The saved server is global and shows the **Global** badge. If the level filter is **Project**, switch it to **All** or **Global** to see the row.

**Installed** means that id is already in the global list or the current project's list; the button does not save a second copy. **Cancel** closes the dialog without saving. A missing required value keeps the dialog open and the toast names it, for example `Example remote: missing value for API_KEY`. An optional environment value or header left empty is omitted. The form fills in `defaultValue` until you edit the field. Clearing that field does not restore the published default: a required field then fails with the missing-value toast, and an optional environment value or header is omitted.

## Catalog JSON

Publish one JSON object at the HTTPS URL you added. The loader reads `servers` and skips an entry it cannot use. With no usable entry left, that source fails and the built-in list remains. The shipped catalog uses `schemaVersion` 1. An id matches `[a-z][a-z0-9_-]{0,63}` and starts with a letter. A category, when set, is `devtools`, `web`, `docs`, `data`, or `productivity`.

This file installs on v0.15.1 and on later versions:

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-09-22",
  "servers": [
    {
      "id": "example-remote",
      "name": "Example remote",
      "description": "Public HTTPS MCP endpoint. The file keeps a placeholder; you supply the key.",
      "transport": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${API_KEY}"
      },
      "requiredEnv": [
        {
          "name": "API_KEY",
          "description": "Your key for this service."
        }
      ]
    }
  ]
}
```

Placeholder rules from v0.15.2 onward:

- A command, argument, environment value, or endpoint URL expands `${NAME}` only, where `NAME` matches `[A-Z_][A-Z0-9_]*`. `{name}` inside a URL stays as written. A stdio `requiredEnv` name uses that same uppercase pattern, and the command must not contain `..`.
- An HTTP header with no `headerBindings` also expands `{name}` when `requiredEnv` lists `name`. HTTP input names may use lowercase. An undeclared `{name}` stays literal.
- With `headerBindings` present, including `{}`, only tokens named in that header's map are replaced. `{ "input": "api_key" }` asks for a value. `{ "value": "literal" }` inserts that text and does not ask, and the inserted text is not read as another placeholder. A token missing from the map stays literal on every header, including a header with no map of its own. The input name still belongs in `requiredEnv`.
- `optional: true` allows an empty field. `defaultValue` is what the form shows until you change it.

A header that should use the registry's `{name}` spelling looks like this. v0.15.2 and later prompt for `api_key`. v0.15.1 skips this entry because `api_key` is not an uppercase environment-variable name. That release also ignores `headerBindings` and leaves `{api_key}` unchanged:

```json
{
  "id": "example-header",
  "name": "Example header",
  "description": "Header variable declared for this header only.",
  "transport": "http",
  "url": "https://mcp.example.com/mcp",
  "headers": {
    "Authorization": "Bearer {api_key}"
  },
  "headerBindings": {
    "Authorization": {
      "{api_key}": { "input": "api_key" }
    }
  },
  "requiredEnv": [
    {
      "name": "api_key",
      "description": "Your key for this service."
    }
  ]
}
```

Put the placeholder in the file. Each person types their own key under **Required values**.

## Remove a source

Open **Sources**. **Official registry** stays. Every other row has **Remove**, which stops later queries to that URL. Servers already saved under **My servers** stay saved.

## Remove an installed server

Choose **My servers**. On the row, open **Actions for {name}** and choose **Remove**. The item then reads **Click again to delete**. The second click deletes that server.

## Which version you are running

v0.15.2, v0.15.3, and the current source use the placeholder rules above. v0.15.1 recognizes `${NAME}` with an uppercase name in commands, arguments, environment values, URLs, and headers. In that release, `{api_key}` is ordinary text, so a registry header written that way adds no **Required values** field and the saved header still contains the braces. `headerBindings` is ignored there, and a lowercase `requiredEnv` name causes that entry to be skipped.

The `${API_KEY}` catalog above is the form that installs on v0.15.1 and later. After v0.15.1, a registry header prompts only for a variable that same header declares, and a `{name}` in the URL stays literal. The public-HTTPS limit on market sources is the same on these builds ([ADR 0245](/adr/0245-mcp-market-public-network-boundary)).
