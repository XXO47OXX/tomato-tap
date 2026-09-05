# Tomato Tap

<div align="left">
  <a href="README.md">中文</a> | <a href="README_en.md">English</a>
</div>

Tomato Tap 是一个面向自有 API Key 的本地 LLM 网关。它把多个供应商、模型和 Key 汇聚到稳定的逻辑模型名之下，并统一处理并发、限流、额度恢复、冷却、重试、出口代理、响应校验与用量统计。

它兼容 OpenAI Chat Completions 和 Anthropic Messages 客户端，不依赖数据库或托管控制面；运行时零第三方依赖，需要 Node.js 20 或更高版本。

> Tomato Tap 是 **source-available** 软件，不是 OSI 定义的开源软件。非商业使用适用 PolyForm Noncommercial 1.0.0；商业使用需要单独授权。

## 为什么使用 Tomato Tap

一个稳定上游只需要普通反向代理。当你开始面对以下问题时，Tomato Tap 才真正有价值：

- 同一个模型由多个供应商或多个 Key 提供，但可用时间、并发和额度不同；
- 下游希望始终请求 `balanced`，而不是了解每个供应商的真实模型名和路由；
- 429、401、额度耗尽和短期网络错误不能拖垮整个模型池；
- 某些 Key 必须固定出口 IP，其他 Key 可以直连或共享代理；
- 成功的 HTTP 200 不一定是有效模型响应，需要在返回下游前校验；
- 希望按供应商、真实模型、逻辑模型和路由查看 Token 与费用；
- 配置和凭据必须留在本机，并且可以热重载。

## 第一次使用：从哪种方式开始

| 你的情况 | 建议入口 |
|---|---|
| 只有一个供应商和一个 Key | 在控制台添加一个上游，先直接使用真实模型 |
| 同一供应商有多个 Key | 使用“追加 Key”，让每个 Key 独立限流、冷却和调度 |
| 多个供应商提供相近模型 | 统一为规范真实模型名，再创建一个逻辑模型 |
| 下游不能频繁修改模型名 | 让下游只请求稳定的逻辑模型，如 `balanced` |
| 不同 Key 必须使用不同 IP | 在出口管理中使用 sticky-auto 或固定节点 |
| 需要自动等待额度恢复 | 为对应上游配置额度探测和恢复策略 |
| 只想本机自用 | 保持默认回环监听和可信下游模式 |
| 需要给其他用户使用 | 放在防火墙或认证反代后，并阅读 [SECURITY.md](SECURITY.md) |

## 三分钟启动

```bash
git clone https://github.com/XXO47OXX/tomato-tap.git
cd tomato-tap
npm test
npm start
```

打开 <http://127.0.0.1:8888/admin/>。首次使用向导会要求填写：

- 供应商名称和 Base URL；
- OpenAI 或 Anthropic 协议；
- API Key 与认证方式；
- 可选 User-Agent；留空时保留下游 User-Agent；
- 上游模型名、规范模型名、RPM 和并发上限；
- 是否直连、共享代理或绑定固定出口。

控制台可以搜索和批量导入模型名，也可以读取兼容上游的 `/models` 响应。发现结果只有在选择并保存后才会写入配置。API Key、代理订阅和原始节点均为只写字段，保存后前端只显示是否已配置。

仓库自带的示例上游默认禁用，不会产生真实请求。首次保存配置时，Tomato Tap 会创建权限为 `0600` 的 `config/local/relays.json`、`config/local/models.json` 和本地 `.env`；这些路径默认被 Git 忽略。

检查状态并发起第一个请求：

```bash
curl http://127.0.0.1:8888/healthz
curl 'http://127.0.0.1:8888/readyz?model=balanced'
curl http://127.0.0.1:8888/oa/v1/models

curl http://127.0.0.1:8888/oa/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"balanced","messages":[{"role":"user","content":"Hello"}]}'
```

示例中的 `balanced` 只有在你为它配置了可用候选模型后才会就绪。

## 五个核心概念

| 概念 | 管理内容 | 不包含什么 |
|---|---|---|
| 上游通道 | 地址、协议、认证方式、RPM、并发上限 | 不保存明文 Key 到公共配置 |
| Key | 凭据、当前容量、冷却、额度和出口绑定 | 不决定逻辑模型能力 |
| 真实模型 | 规范模型名、能力、质量、思考适配和超时 | 不绑定某一个供应商 |
| 逻辑模型 | 稳定下游名称、候选模型、选择和重试策略 | 不直接持有凭据 |
| 出口 | 直连、共享、自动固定、指定节点或 HTTP 代理 | 默认不会自动启用 |

在同一供应商上使用“追加 Key”时，协议和模型映射会被复制，但新 Key 和固定代理地址保持为空。若原 Key 使用订阅节点，新 Key 会得到独立的 sticky-auto 绑定，不会静默共享同一 IP。

## 典型工作流

### 汇聚同能力模型

1. 分别添加供应商和 Key；
2. 把供应商的实际模型名映射为一致的规范模型名；
3. 在“真实模型”中描述能力、质量和思考模式；
4. 创建逻辑模型并选择候选；
5. 使用 `GET /__route/plan?model=<logical>` 检查当前选择；
6. 让下游只请求逻辑模型名。

两个部署声明相同的规范模型后，会成为该真实模型的独立容量来源。调度器仍会分别记录它们的 Key、供应商、并发、延迟和冷却状态。

### 为逻辑模型选择策略

- `fair`：按轮次平衡候选，适合分摊额度和避免长期偏向单一模型；
- `ordered`：按配置顺序尝试，适合明确的主模型与回退链；
- `adaptive`：根据资格、健康、空闲容量、成功率和延迟动态选择。

候选在调度前会经过能力、质量、配额、冷却、并发和健康资格过滤。逻辑模型还可以设置总并发、最大尝试次数、总截止时间和请求参数覆盖。

### 管理思考与结构化请求

请求策略可以配置 `reasoningEffort`、`temperature`、`stream`、`maxOutputTokens` 和 `maxInputTokens`。优先级从低到高为：

```text
下游请求
  < 逻辑模型策略
  < 任务子类型策略
  < 真实模型兼容适配
  < 供应商 / Key 最终策略
```

后层只覆盖自身明确设置的字段，其余请求内容保持不变。

### 保留额度型备用 Key

普通真实模型路由也可以把低权重部署保留为“额度耗尽后才启用”的备用：

```json
{
  "weight": 1,
  "fallbackAdmission": "higher_weight_quota_closed",
  "quotaSignalProfile": "kimi-coding"
}
```

当更高权重部署支持同一模型时，只有它们都被明确的额度信号关闭，备用部署才会接收请求。短时限流、网络失败、5xx、认证失败或探针自身失败不会提前消耗备用额度；如果该模型只有备用部署支持，它仍可正常作为主路由。

### 可选 Cursor ACP 桥接

Cursor API Key 用于认证 `cursor-agent`，不是普通模型 API Key。Tomato Tap 可以把它作为独立、纯文本且仅回环监听的 OpenAI Chat Completions 上游：

```dotenv
TOMATO_TAP_CURSOR_ACP_ENABLED=true
TOMATO_TAP_CURSOR_ACP_API_KEY=<cursor-api-key>
TOMATO_TAP_CURSOR_ACP_CWD=/path/to/workspace
TOMATO_TAP_CURSOR_ACP_MAX_CONCURRENT=1
```

安装 Cursor CLI 后，请求 `POST /cursor/v1/chat/completions`，模型名使用 `cursor-agent`。桥接器为每次请求创建一个 ACP 会话，只返回文本并拒绝文件、终端、MCP 和工具调用；监听地址强制为回环地址。可用 `GET http://127.0.0.1:8891/health` 做不消耗模型额度的检查。

## 配置与数据边界

| 数据 | 默认位置 | 是否提交 |
|---|---|---:|
| 代码和安全示例策略 | `src/`、`config/*.json` | 是 |
| 公共供应商公开价格 | `pricing/provider-defaults.json` | 是 |
| API Key 和订阅 URL | `.env` 或 `TOMATO_TAP_ENV_FILE` | 永不 |
| 私人上游与模型清单 | `config/local/` | 永不 |
| 私人别名和协议价格 | `pricing/local/` 或外部覆盖文件 | 永不 |
| 冷却、出口绑定、用量和样本 | `runtime/` | 永不 |

上游、Key 和模型配置可以选择文件或 SQLite 存储：

```dotenv
# files（默认）、sqlite 或 auto
TOMATO_TAP_CONFIG_BACKEND=files
# TOMATO_TAP_CONFIG_DB_PATH=/var/lib/tomato-tap/tomato-config.db
```

- `files` 使用 `config/local/*.json` 和 `.env`，兼容 Node.js 20+；
- `sqlite` 首次启动时从现有本地文件导入，之后控制台直接读写权限为
  `0600` 的数据库，需要 Node.js 22.5+；
- `auto` 只在已有激活数据库时使用 SQLite，否则回退到文件。数据库损坏
  或版本不兼容不会静默回退。

切换存储后需要重启。`vendors.json` 中的协议适配和公开价格仍是文件策略，
不会与私人凭据混入同一配置层。

已有实例可先预检再切换；两个方向默认都是演练，只有 `--apply` 才写入：

```bash
node scripts/config-storage.mjs import-files
node scripts/config-storage.mjs import-files --apply
node scripts/config-storage.mjs export-files
node scripts/config-storage.mjs export-files --apply
```

导出回文件前会在 `runtime/backups/` 创建权限为 `0600` 的本地备份，命令
只输出脱敏计数，不输出 Key。

高级用户可以手动维护配置：

```dotenv
TOMATO_TAP_VENDORS_PATH=/path/to/vendors.json
TOMATO_TAP_RELAYS_PATH=/path/to/relays.json
TOMATO_TAP_MODELS_PATH=/path/to/models.json
TOMATO_TAP_ENV_FILE=/path/to/tomato-tap.env
TOMATO_TAP_PRICING_OVERRIDES_PATH=/path/to/pricing-overrides.json
```

匹配部署 ID 的凭据格式为：

```dotenv
tomato_tap_relay_provider_a_key=replace-locally
```

配置会先经过完整校验，再以原子方式写入并热重载。新配置无效时，当前正常运行的配置代次不会被替换。

若同时维护公开发行版与私人部署，请使用两个独立 Git 仓库，只把通用代码从公开仓库移植到私人仓库，不要反向复制 `.env`、`config/local/`、私人价格或 `runtime/`。公开推送前运行：

```bash
npm run check:public
```

该检查会拒绝凭据、工作站路径、私人运行文件、非示例上游和已填充的私人价格覆盖。

## 出口代理

代理能力独立位于 `src/egress/`：

- 订阅内容只在内存中解析；
- Key 只绑定脱敏节点 ID；
- 绑定保存在 `runtime/proxy-bindings.json`；
- sing-box 监听器仅绑定回环地址；
- 固定节点失败时只冷却对应 Key，不会偷偷切换 IP。

所有上游默认直连。可以在“控制台 → 连接”中配置订阅和 Key 绑定，也可以使用 `false`、`true`、`sticky-auto`、指定脱敏节点或固定 HTTP 代理策略。原始订阅 URL、VLESS URI 和带认证的代理地址只能放入 `.env`。详见 [docs/egress.md](docs/egress.md)。

## 健康、额度与用量

Tomato Tap 将“已配置”“可调度”“探测中”“最近验证成功”和“冷却中”分开显示，不会仅因为模型存在于列表就声称可用。

- 每个 Key 独立维护 AIMD 并发、RPM、冷却和额度状态；
- 401、403、429、网络错误和无效响应可以采用不同范围与恢复策略；
- 配额探测器可以在不知道准确恢复时间时低频验证，并在恢复后重新释放容量；
- 无效 200 响应不会被当成成功结果返回下游；
- 用量可以按日期、供应商、真实模型、逻辑路由和币种聚合；
- 公共标价与私人协议价分层管理，不强制把不同币种换算到一起；
- 请求/响应样本默认关闭，启用后可设置保留时间和大小上限。

## 运维入口

前台运行：

```bash
npm start
```

可选 supervisor：

```bash
./scripts/run.sh start
./scripts/run.sh status
./scripts/run.sh restart
./scripts/run.sh stop
```

常用端点：

- `GET /admin/`：本地统一管理控制台；
- `GET /__status`：脱敏后的运行、Key 池、额度和出口状态；
- `GET /healthz`：仅检查进程存活，不请求上游；
- `GET /readyz`：至少一个逻辑模型当前可调度；
- `GET /readyz?mode=available`：要求最近真实请求验证成功；
- `GET /readyz?model=<logical>`：检查指定逻辑模型；
- `GET /__route/plan?model=<logical>`：不产生上游请求的路由预演；
- `GET /models`：跨路由模型清单；
- `GET /<route>/models`：指定客户端路由的模型清单；
- `GET /__usage`：用量、价格目录和 JSON API。

服务默认监听 `127.0.0.1` 并信任本机下游。当前版本不提供客户端二级 Key 鉴权；不要把可信模式直接暴露到不受信任的网络。共享使用时必须放在防火墙、受控网络或认证反向代理后，并阅读 [SECURITY.md](SECURITY.md)。

## 目录结构

```text
bin/                 命令行入口
config/              可公开的安全示例配置
src/app/             进程组合和生命周期
src/admin/           管理控制台与安全配置事务
src/config/          配置解析、生成和热重载
src/gateway/         HTTP 接入、控制面和请求读取
src/routing/         逻辑/真实模型调度与响应校验
src/providers/       供应商元数据、协议适配与额度探测
src/egress/          代理传输和固定出口绑定
src/state/           Key 容量、限流和冷却状态
src/usage/           价格、账本、聚合和用量页面
src/telemetry/       可选样本记录
tools/               运维和仓库检查工具
tests/               单元测试与回环集成测试
```

进一步阅读：

- [架构与状态模型](docs/architecture.md)
- [完整配置参考](docs/configuration.md)
- [出口代理说明](docs/egress.md)
- [安全策略](SECURITY.md)
- [贡献指南](CONTRIBUTING.md)

## 兼容旧名称

新安装应使用 `tomato-tap`、`TOMATO_TAP_*`、`tomato_tap_relay_*` 和 `x-tomato-tap-*`。`0.x` 期间仍兼容预发布阶段的 `mimo-tap` 命令、旧环境变量和旧响应元数据；新名称始终优先。旧标识不会在没有主版本迁移说明的情况下直接删除。

## 开发

```bash
npm test
npm run check
bash -n scripts/*.sh
```

## 授权

Tomato Tap 采用 Source Available / 商业双授权：

- 非商业使用适用 [PolyForm Noncommercial License 1.0.0](LICENSE)；
- 商业使用需要获得版权所有者的单独书面授权，详见 [COMMERCIAL-LICENSING.md](COMMERCIAL-LICENSING.md)。

营利组织内部使用、收费或面向客户的服务、转售、托管运营和商业产品集成通常需要商业授权。每个发行版本适用其随附许可，早期版本已经授予的许可不会被追溯撤销。
