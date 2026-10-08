# CodeWalk · 源码带读工作台

阅读陌生项目时，真正困难的通常不是语法，而是找到入口、理解模块职责，以及串起分散在不同文件中的关键实现。

CodeWalk 是一个本地运行的 AI 源码阅读工具。导入项目后，它会先生成项目总览，再根据用户的问题整理一条按理解顺序组织的阅读路线。每个步骤都对应真实源码，并附带阅读重点和解释。

阅读过程中可以在 Monaco 中框选代码提问、继续追问，并把回答保存为源码批注。项目总览、阅读路线和局部问答共同组成一套可持续回看的源码学习记录。

目前更适合中小型项目；阅读大型仓库时，建议先导入一个子目录。

[快速开始](#快速开始) · [模型配置](#模型配置) · [使用方法](#使用方法) ·
[工作原理](#工作原理) · [数据存储](#数据存储) · [许可证](#许可证)

## 能做什么

- 生成项目用途、目录结构和主要模块关系总览。
- 根据具体问题生成阅读路线，或让 Agent 选择默认场景。
- 按模块展示关键函数、源码范围、阅读重点和讲解。
- 在 Monaco 中只读浏览源码、切换文件并定位代码。
- 框选代码提问、继续追问并保存批注。
- 保存多条路线，支持归档、恢复和失败任务重试。

## 快速开始

CodeWalk 需要 Node.js 24 或以上、npm、ripgrep 和 Dekko。当前支持 Dekko `map.json` v11。

### Linux

先安装 [nvm](https://github.com/nvm-sh/nvm)，然后执行：

```bash
# Node.js 与源码搜索工具
nvm install 24
nvm use 24
sudo apt-get update
sudo apt-get install -y ripgrep

# uv 与 Dekko
curl -LsSf https://astral.sh/uv/install.sh | sh
# 重新打开终端后继续
uv tool install dekko

# CodeWalk
npm ci
cp model-config.example.json model-config.json
chmod 600 model-config.json
# 编辑 model-config.json，填写供应商和 API Key
npm start
```

### Windows PowerShell

```powershell
# Node.js、源码搜索工具和 uv
winget install --id OpenJS.NodeJS.LTS --exact
winget install --id BurntSushi.ripgrep.MSVC --exact
winget install --id astral-sh.uv --exact

# 重新打开 PowerShell 后安装 Dekko
uv tool install dekko

# CodeWalk
npm ci
Copy-Item .\model-config.example.json .\model-config.json
# 编辑 model-config.json，填写供应商和 API Key
npm start
```

确认 `node --version`、`npm --version`、`rg --version` 和 `dekko --version` 都能正常运行。
启动后打开 <http://127.0.0.1:3000/projects>。

导入项目时填写绝对路径，例如 Linux 下的 `/home/me/projects/my-app`，或 Windows 下的
`C:\projects\my-app`。

## 模型配置

仓库只提供 `model-config.example.json` 模板，不包含真实配置。每位用户都需要在仓库根目录创建自己的
`model-config.json`。

```json
{
  "provider": "deepseek",
  "apiKey": "YOUR_API_KEY",
  "model": "deepseek-v4-flash"
}
```

- `provider` 使用 Pi 的供应商 ID。
- `model` 可省略；填写时不带供应商前缀。
- 已配置 Pi 的用户可以不创建该文件，直接沿用本机配置。
- 修改配置后需要重启服务。

常用供应商 ID：

| 供应商                    | `provider`      |
| ------------------------- | --------------- |
| DeepSeek                  | `deepseek`      |
| OpenAI                    | `openai`        |
| Anthropic                 | `anthropic`     |
| Google Gemini             | `google`        |
| OpenRouter                | `openrouter`    |
| Moonshot / Kimi（中国区） | `moonshotai-cn` |
| MiniMax（中国区）         | `minimax-cn`    |
| Z.AI                      | `zai`           |

以上 ID 已通过当前锁定的 Pi SDK 校验；具体可用模型取决于账号权限和地区。
启动时会通过 Pi 在线目录更新模型列表，并缓存到本地；刷新失败或离线时使用已有缓存或 SDK 内置目录。
生成内容时，问题和调查所需的源码会发送给所配置的模型供应商。

### 可选环境变量

| 变量                     | 默认值              | 用途             |
| ------------------------ | ------------------- | ---------------- |
| `PORT`                   | `3000`              | 服务端口         |
| `CODEWALK_DATA_DIR`      | `.codewalk`         | 学习数据目录     |
| `CODEWALK_MODEL_CONFIG`  | `model-config.json` | 模型配置路径     |
| `PI_CODING_AGENT_DIR`    | Pi 默认目录         | Pi 配置目录      |
| `CODEWALK_DEKKO_COMMAND` | `dekko`             | Dekko 可执行文件 |

Linux：

```bash
PORT=3010 CODEWALK_DATA_DIR=/absolute/path/codewalk-data npm start
```

Windows PowerShell：

```powershell
$env:PORT = "3010"
$env:CODEWALK_DATA_DIR = "C:\codewalk-data"
$env:CODEWALK_DEKKO_COMMAND = "C:\path\to\dekko.exe"
npm start
```

## 使用方法

1. 在项目页输入源码目录的绝对路径并导入项目。
2. 生成项目总览，了解用途、目录和主要模块。
3. 输入一个具体问题，或让 Agent 选择默认场景并生成路线。
4. 在左侧选择模块和代码块，中间阅读源码，右侧查看讲解。
5. 框选不理解的代码进行提问，并在同一条批注中继续追问。
6. 在路线页管理、归档或恢复已有路线。

问题越具体，路线通常越有用。例如：「用户提交新增宠物就诊记录后，数据如何被校验并保存？」

## 工作原理

```text
源码快照 + Dekko 图谱 + 阅读目标
  → Agent 调查关键源码位置
  → 程序提取真实源码并校验范围
  → Agent 批量自查源码单元
  → 组织模块、阅读顺序和讲解
  → 独立只读 Agent 审核整条路线
  → 修订后保存完整或部分结果
```

确定性代码负责路径、源码内容、范围和数据结构；Agent 负责语义理解、关键代码选择和教学顺序。
失败阶段会保存检查点并进行有限重试。

## 数据存储

项目数据默认保存在 `.codewalk/`：

```text
.codewalk/
├── catalog.sqlite
└── projects/
    └── <project-id>/
        ├── project.sqlite
        └── snapshots/
```

每个项目单独保存总览、路线、批注、任务和源码快照。修改原项目不会改变已有快照；
需要阅读新版本时，应重新导入。备份时可以复制整个数据目录，但其中可能包含私人源码和对话记录。

## 许可证

项目采用 [ISC License](LICENSE)。
