---
title: MCP 市场
description: 添加公网 MCP 目录、自行填写凭据，并移除市场源或已安装的服务器。
---

# MCP 市场

点击侧边栏底部的**设置**（也可以在**搜索设置…**里搜 MCP）。在**智能体**分组中打开
**MCP**，再点**市场**。这里管理的是 MCP 服务器，和插件市场不是同一个页面。
**我的服务**回到已保存的服务器列表。侧边栏底部显示应用版本。下面的步骤对应 v0.15.2 及之后的版本；最后一节单独说明 v0.15.1 的行为。

[English version](/guide/mcp-market)

## 三种列表

**市场**把三份列表合在一起。远程源失败时，内置条目仍然留在页面上。

| 列表 | 从哪里来 | 你可以改什么 |
|---|---|---|
| 内置目录 | 随应用附带的服务器。断网时也会立刻出现。 | 保持随应用附带的内容。这份列表没有地址。 |
| 官方注册表 | 内置源**官方注册表**，类型是 **Registry 协议**，地址为 `https://registry.modelcontextprotocol.io/v0/servers`。 | 它一直留在**市场源**里。**移除**出现在其他行上。 |
| 目录 JSON | 你发布在公网 HTTPS 地址上的静态 JSON 文件。 | 在**市场源**里用类型**目录 JSON**添加。 |

**市场源**也可以再加一个 **Registry 协议**地址。这类地址按官方注册表协议查询，会带上 `version`、`limit`，以及 `search` 或游标。**目录 JSON**地址只取回一份 JSON，不附加注册表查询参数。

注册表记录要能被本应用安装才会出现。优先 npm，其次 PyPI，然后是公网 HTTPS 的 `streamable-http` 远端。注册表给出的包版本和启动参数会保留。只提供其他包类型的记录不会出现。PyPI 条目会带上前置说明 `Requires uv/uvx on PATH`。

远程卡片的标记是源里保存的名称。内置注册表源保存的名称是 `Official registry`。解析不到名称时，标记为**注册表**。内置卡片没有远程标记。远程条目若与内置条目使用同一个 id，页面保留内置条目。

**搜索 server**按名称、说明和作者匹配。分类是**全部**、**开发工具**、**网络**、**文档**、**数据**、**效率**。注册表搜索在注册表服务上执行。目录文件先整份下载，再在本机筛选。**加载更多**向注册表源再要后续分页。

## 添加公网目录

1. 在 **MCP 市场**点击**市场源**。按钮上会带当前数量，例如**市场源 · 1**。
2. 面板说明二者的差别：Registry 型源走官方 MCP 注册表协议；目录型源是符合市场 schema 的静态 JSON 文件。
3. 填写**源名称**。留空时使用主机名。
4. 粘贴不含用户名和密码的公网 `https://` 地址。输入框占位是 `https://…(registry 端点或目录 JSON)`。
5. 选中**目录 JSON**。表单默认停在 **Registry 协议**。目录地址若仍选 **Registry 协议**，会按注册表去查询，JSON 不会被当成目录读取。
6. 点击**添加源**。

市场只接受没有用户名和密码的公网 HTTPS 地址。回环、私网、链路本地，以及 `localhost` 这类名字会被拒绝，提示为**源地址必须是公网 https 地址**。每次请求的时限是 8 秒，响应上限 4 MiB，最多跟随 5 次公网 HTTPS 重定向。最多查询 16 个源，其中始终包括**官方注册表**。这份列表保存在这台电脑上的本应用里。

私网或明文 HTTP 端点用手动编辑器保存。回到**我的服务**，点击**新增**。编辑器接受 `http` 和 `https`；未加密的 HTTP 会显示**此 HTTP 连接未加密，凭据和工具调用可能被截获。**参见 [ADR 0142](/adr/0142-allow-non-loopback-http-mcp) 和 [ADR 0245](/adr/0245-mcp-market-public-network-boundary)。

远程没有任何条目且有源失败时，页面显示**官方注册表暂不可达,已显示内置精选**，并带上失败的源名称。无论这句提示出不出现，内置服务器都还在。目录失败但注册表仍有结果时，该目录不进入列表，上面那句提示不会出现，注册表条目仍会显示。

## 查看端点并安装

卡片上是命令行或端点 URL，占位符仍留在原文里，下面是说明。

点击**安装**。对话框包含：

- **将写入配置**：同一条命令行或 URL 模板。这一块不打印 header 原文。
- 条目自带时，显示**前置条件:**和**说明:**。
- **需补齐的值**：每个已声明的输入各有一个密文输入框。标签是变量名。提示是条目里的说明；可以留空时再附上**可留空**。目录里写了默认值时，框里会预先填上。
- **server 首次连接之前不会执行任何命令。**

目录文件里放的是占位符。密钥由你自己填写。**安装**把这个值写进已保存的服务器（本地命令写入环境变量，HTTP 端点写入 header），然后回到**我的服务**。目录地址本身不会被改写。保存结果是全局服务器，带**全局**标记。级别筛选停在**项目**时，改成**全部**或**全局**才能看到这一行。

**已安装**表示这个 id 已经在全局列表或当前项目列表里，按钮不会再存一份。**取消**关闭对话框且不保存。必填值缺失时对话框保持打开，提示会点名，例如 `Example remote: missing value for API_KEY`。可留空的环境变量或 header 若为空，则不会写入。表单会先填入 `defaultValue`，直到你改动该字段。清掉之后不会自动恢复目录里的默认值：必填字段会以缺失值提示失败，可留空的环境变量或 header 则不会写入。

## 目录 JSON

把一个 JSON 对象发布到你添加的 HTTPS 地址。加载器读取 `servers`，用不上的条目会被跳过。一条可用条目都不剩时，这个源失败，内置列表仍在。随应用附带的目录使用 `schemaVersion` 1。id 符合 `[a-z][a-z0-9_-]{0,63}`，并且以字母开头。填写分类时，只能是 `devtools`、`web`、`docs`、`data` 或 `productivity`。

下面这份文件在 v0.15.1 和之后的版本都能安装：

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

v0.15.2 及之后的占位规则：

- 命令、参数、环境变量值和端点 URL 只展开 `${NAME}`，`NAME` 符合 `[A-Z_][A-Z0-9_]*`。URL 里的 `{name}` 保持原样。stdio 的 `requiredEnv` 名称用同一套大写规则，命令里不能出现 `..`。
- 没有 `headerBindings` 的 HTTP header 还会展开 `requiredEnv` 里列出的 `{name}`。HTTP 输入名可以包含小写。未声明的 `{name}` 保持字面量。
- 只要写了 `headerBindings`，包括 `{}`，就只替换该 header 映射里点名的记号。`{ "input": "api_key" }` 会要求填写。`{ "value": "literal" }` 直接写入这段文字并且不再询问，写入的文字也不会再被当成占位符。映射里没有的记号在每个 header 上都保持字面量，包括自身没有映射的 header。对应的输入名仍然要写进 `requiredEnv`。
- `optional: true` 表示字段可以留空。`defaultValue` 是你改动之前表单里显示的值。

要使用注册表那种 `{name}` 写法时，header 像下面这样。v0.15.2 及之后会提示填写 `api_key`。v0.15.1 会跳过这条，因为 `api_key` 不是大写的环境变量名。该版本还会忽略 `headerBindings`，并让 `{api_key}` 保持原样：

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

文件里放占位符。每个人在**需补齐的值**里填写自己的密钥。

## 移除市场源

打开**市场源**。**官方注册表**会留下。其他每一行都有**移除**，用来停止以后再查询该地址。已经保存在**我的服务**里的服务器仍然保留。

## 移除已安装的服务器

回到**我的服务**。在该行打开 **{name} 的操作**，选择**移除**。菜单项会变成**再点一次删除**。再点一次才会删除这台服务器。

## 你正在使用的版本

v0.15.2、v0.15.3 和当前源码使用上面的占位规则。v0.15.1 在命令、参数、环境变量值、URL 和 header 里只识别大写的 `${NAME}`。在那个版本里，`{api_key}` 是普通文字，因此这样写的注册表 header 不会出现**需补齐的值**，保存后的 header 里仍然带着花括号。那里的 `headerBindings` 会被忽略；`requiredEnv` 使用小写名称时，整条会被跳过。

上面使用 `${API_KEY}` 的目录，在 v0.15.1 和之后的版本都能安装。v0.15.1 之后，注册表 header 只会为它自己声明的变量弹出输入，URL 里的 `{name}` 保持字面量。这些版本对市场源的公网 HTTPS 限制是同一条（[ADR 0245](/adr/0245-mcp-market-public-network-boundary)）。
