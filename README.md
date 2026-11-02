# dsh-commandcode

在 DeepSeek Harness（dsh）里使用 **Command Code** 订阅的 provider，支持 **Go / GOAT / Pro / Max** 套餐，默认按 Go 套餐过滤模型。

它存在的唯一原因是 **避开 `403 upgrade_required`**：

| 端点 | 用途 | Go 套餐 |
| --- | --- | --- |
| `/provider/v1/chat/completions`（OpenAI 兼容 Provider API） | 第三方工具直接接入 | ❌ `403 upgrade_required` |
| `/provider/v1/models` | 公开模型目录（无需鉴权） | ✅ 只用来读模型清单 |
| `/alpha/generate`（官方 CLI 私有网关） | `command-code` CLI 实际使用的流式端点 | ✅ 本插件唯一使用的生成端点 |

本插件**不会**把任何生成请求发到 `/provider/v1/*`；它把 DSH 的请求序列化成官方 CLI 的 `/alpha/generate` 信封，并带上实时读取的 `x-command-code-version`（网关靠这个头判断客户端能力，缺失或被判过期时会直接 403）。如果在 `/alpha/generate` 上仍然收到 403，插件会在错误信息里直接说明这通常意味着 key 不属于有效套餐，而不是传输方式选错了。

## 功能

- **套餐过滤**：从 `/provider/v1/models` 拉实时目录，再用官方 CLI catalog（`reference/models.md`，从 unpkg 的 `command-code@latest` 实时读取；unpkg 不可达时回退 jsDelivr）的 `Min plan` 列过滤。默认 `plan: go`；改成 `goat` / `pro` / `max` 会包含更高套餐的模型。
- **推理档位**：每个模型只暴露 catalog 真实声明的 effort（`off` / `low` / `medium` / `high` / `xhigh` / `max`）；catalog 里是 `—` 的模型不显示档位选择器。
- **工具调用**：完整的工具 schema / tool-call / tool-result 往返，并把可选参数在 wire 上映射成 nullable，避免 OpenAI Responses 的 `strict` 默认值给工具塞入伪造参数。
- **图片**：按 DSH 的路由预算重编码（单图 1 MiB、2048² 像素预算），超过单次请求 base64 预算时抛出 `IMAGE_OFFLOAD_REQUIRED`，由 DSH 记录最旧图片为 offload 后重试。
- **动态目录**：启动时扫描，之后按 `refreshMinutes` 重扫；扫描失败保留上一份目录并 60 秒后重试，不会拖垮插件。
- **密钥卡片**：Command Code 卡片默认只显示「已配置 / 未配置」和一枚按钮，点 **配置密钥**（已配置后是 **编辑密钥**）才展开输入框——和内置的 DeepSeek Official 一样是「点开才出现」，不会常驻一个空密码框。
- **额度状态栏**：当前会话选择 Command Code 模型时，对话输入框下方的状态栏显示 **5 小时 / 周 / 月** 已用比例；点击展开剩余额度、重置倒计时和当前套餐，支持手动刷新。切到其他 provider 或未配置 key 时整条指示隐藏，也不会轮询额度接口。
- **多账号**：暂不支持（一个 provider 一个 key）。需要多账号时用不同 `DSH_HOME` 或后续扩展。

## 安装

从 npm 安装（把 `web` 换成你的 profile 名；Desktop 用户可用插件管理界面）：

```sh
dsh plugin --profile web add dsh-commandcode
```

或从本地目录/打包产物安装：

```sh
# 1. 打包（可选；直接装目录也可以）
pnpm pack

# 2. 装进 profile
dsh plugin --profile web add ./dsh-commandcode-0.2.0.tgz
```

安装后需要**重启 dsh 一次**（Desktop 用户重启应用）：宿主在启动时缓存 `dsh.client` 元数据，新增的浏览器端密钥卡片要等下一次启动才会进入页面。重启后打开 Settings → Models，Command Code 卡片标题下方就会出现 API 密钥卡片（默认收起，点里面的按钮才展开输入框）。此后只改 `client.js` 的内容不必再重启，**刷新页面**即可。

## 配置 API Key

插件通过 dsh 的 credentials 服务读取 `COMMANDCODE_API_KEY`。有两条等价的路径：

1. **推荐**：打开 Web 的 **Settings → Models → Command Code**，点卡片上的 **配置密钥**（已配置时显示 **编辑密钥**）展开输入框，粘贴 key 后点 **保存密钥**（回车保存，Esc 或 **取消** 收起，输入框右侧可显示/隐藏明文）。保存后写入 credentials 服务的 `COMMANDCODE_API_KEY`，卡片状态和行首圆点会同步变化；**清除** 会 unset 同一引用。

   > 卡片右上角那个 **编辑** 是 Models 页给内置 provider 的编辑器按钮。页面只对内置的 `llm-deepseek` / `llm-pi-ai` 两个 namespace 生成「API 密钥 + 高级设置」面板，插件 provider（`commandcode-provider`）点开只有一行高级提示，而且页面没有给插件往那个面板内部插内容的槽位（只有 `settings.models.provider-card` / `settings.models.footer` 两个槽）。所以密钥输入放在卡片自己身上，并做成同样的「点开才出现」。
2. 手动写 `~/.dsh/.credentials.yaml`，注意当前版本只认 **`refs:`** 下的条目（根级同名的外国键会被保留但**不会**被解析）：

```yaml
version: 1
refs:
  COMMANDCODE_API_KEY: user_xxxxxxxxxxxxxxxx
records: {}
```

文件权限必须是 `600`（`chmod 600 ~/.dsh/.credentials.yaml`），否则 credentials-local 会拒绝启动。

也可以用环境变量：在启动 dsh 的 shell 里 `export COMMANDCODE_API_KEY=...`，或写进 `$DSH_HOME/.env`。

## 配置项

全部可选，默认即可用：

```yaml
- id: commandcode-provider
  name: 'dsh-commandcode'
  config:
    baseURL: https://api.commandcode.ai
    plan: go
    maxTokens: 64000
    defaultContextWindow: 1000000
    maxRequestImageBytes: 2097152
    http1: false
    refreshMinutes: 360
```

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `baseURL` | `string` | `https://api.commandcode.ai` | 网关 base URL，自动追加 `/alpha/generate` |
| `plan` | `go` \| `goat` \| `pro` \| `max` | `go` | 按套餐层级过滤模型（Go < GOAT < Pro < Max） |
| `maxTokens` | `number` | `64000` | 单次请求默认输出上限，请求显式值优先 |
| `defaultContextWindow` | `number` | `1000000` | 模型无精确 contextWindow 时的兜底 |
| `maxRequestImageBytes` | `number` | `2097152`（2 MiB） | 单次请求内联 base64 图片预算 |
| `http1` | `boolean` | `false` | 用 HTTP/1.1 发请求。Node ≥ 26 默认 HTTP/2，并发时 Cloudflare 边缘可能用 `ENHANCE_YOUR_CALM` 重置流；HTTP/1.1 会把同一限流变成可读的 429 |
| `refreshMinutes` | `number` | `360` | 目录重扫间隔（分钟） |

## 额度状态栏

当前会话选中的是 Command Code 模型时，对话输入框下方的状态栏（`conversation.composer.dock`）会多出一枚额度指示：

```
▤ 5小时 20% · 周 26% · 月 16%
```

点击后展开完整读数：每个窗口的 `已用 / 上限`、重置倒计时、月度剩余额度与套餐名。数据直接来自 Command Code 官方 CLI `/usage` 使用的同一组只读端点：

| 端点 | 用途 |
| --- | --- |
| `/alpha/whoami` | 团队账号的 `orgId`，用于给下面两个查询加作用域 |
| `/alpha/billing/credits` | 5 小时 / 周滚动窗口的 `used` / `cap` / `resetAt`，以及月度剩余 credits |
| `/alpha/billing/subscriptions` | 套餐 `planId`、订阅状态和账期结束时间 |

5 小时与周比例是服务端原值；**月度比例是推算值**：`已用 = 套餐月度 credits − monthlyCredits`，套餐上限取自官方 CLI 的映射表（Go 10、GOAT 70、Pro 30/80、Max 150、Ultra 300、Teams Pro 40）。遇到未知套餐时只显示两个滚动窗口，不会编造月度上限。

显示条件来自会话的 `modelSelection` projection：只有 `next.provider === 'commandcode'` 时才渲染并开始轮询；切换到 DeepSeek 等其他模型会立即隐藏并停止轮询，切回来再重新读取。宿主侧把一次读数缓存 20 秒，浏览器端在激活时、每分钟、页面重新可见时刷新；面板里的 **刷新** 会强制绕过缓存。没有配置 `COMMANDCODE_API_KEY` 时，额度指示不渲染，也不会产生任何上游请求。

> 从 0.1.x 升级时，额度查询方法注册在宿主进程里，需要**重启一次 dsh**（Desktop 用户重启应用）才会生效；之后只改 `client.js` 的话刷新页面即可。

## 验证

```sh
pnpm install
pnpm test    # 59 个单元测试：catalog / protocol / adapter / usage / client / package
pnpm live    # 真实网关请求，需已配置 key；会打印 usage 与 finish
```

`pnpm live` 的输出应类似：

```
model=deepseek/deepseek-v4-flash cliVersion=1.88.2 endpoint=/alpha/generate
pong
usage: {"inputTokens":1461,"outputTokens":3,"totalTokens":7608,"cacheReadTokens":6144,"reasoningTokens":0}
finish: {"kind":"stop"}
quota: 5h 20% weekly 26% monthly 16% plan=Go

live check passed
```

## 兼容性

- dsh `>=0.2.0-rc.2 <0.3`（在 `0.2.1-rc.5` 上验证）。
- Node.js `^22.19.0 || >=24.0.0`。
- Profile：`web` / `headless`。

## Credit

- 架构与协议移植参考 [jiesou/dsh-commandcode-go-provider](https://github.com/jiesou/dsh-commandcode-go-provider)（MIT）。
- 上游协议来自 [brent-weatherall/opencode-commandcode-provider](https://github.com/brent-weatherall/opencode-commandcode-provider) 与官方 `command-code` CLI。

## License

[MIT](LICENSE)
