# Baka Translator · 模型接入配置

这里是扩展的模型注册表，不包含任何 API Key。修改后请重新加载扩展，模型下拉栏会读取新配置。

## 文件结构

`index.json` 决定服务商及其显示顺序，并指定默认模型；每个服务商一个同名文件。新增服务商时，
在 `index.json` 的 `providers` 中加入 id，创建 `<id>.json`，并把文件名加入 `scripts/package.py`。
`manifest.json` 已有 `<all_urls>`，不用再加域名。

```json
{
  "version": 2,
  "defaultModelId": "deepseek-flash",
  "providers": ["deepseek", "openai", "anthropic", "xai", "gemini", "custom"]
}
```

示例服务商文件：

```json
{
  "id": "deepseek",
  "name": "DeepSeek",
  "endpoint": "https://api.deepseek.com",
  "completionsPath": "/chat/completions",
  "modelsPath": "/models",
  "protocol": "openai",
  "requestShape": "deepseek",
  "apiKeyLabel": "DeepSeek API Key",
  "apiKeyPrefix": "sk-",
  "docsUrl": "https://platform.deepseek.com/api_keys",
  "models": [
    {
      "id": "deepseek-flash",
      "name": "DeepSeek V4.1 Flash",
      "model": "deepseek-flash",
      "endpoint": "https://api.deepseek.com",
      "contextWindow": 1000000,
      "maxOutputTokens": 384000,
      "effortLevels": ["none", "low", "high", "max"],
      "defaultEffort": "none",
      "supportsVision": true,
      "supportsJson": true,
      "pricing": {}
    }
  ]
}
```

只想多用一个模型时不必改这里：在设置 → 常规 → 服务商的「添加模型名称」填写即可。这些名称保存在
`chrome.storage.local` 的 `userModels`，端点及请求路径沿用该服务商第一个模型的参数，不提供预测价格功能。

也可以输入 API Key 后点击「可用模型 → 获取模型」，支持 DeepSeek、OpenAI、Anthropic、Gemini、Grok
及提供模型列表的 OpenAI 兼容接口。输入框留空时使用已保存的 Key；临时输入的 Key 不会自动保存。
获取结果去重追加到本地列表，不删除已有模型或切换当前选择；失败时保留原列表。每个服务商最多添加
500 个模型，达到上限时会提示。随后在「高级 → 模型行为」中选择用于翻译或润色的模型。

列表会过滤可识别的嵌入、语音、图像及不兼容接口的模型；服务商未提供完整能力信息时采用名称判断，
可能需要手动补充。列表获取成功不代表调用权限、余额或所有参数都兼容。新增模型仍沿用第一个模型的
端点与请求路径，省略思考强度、温度及 JSON 模式参数，输出上限为 4096 tokens。图像能力未知时允许尝试；
模型明确返回不支持图像后，本地会记住并禁用图片翻译，可在该模型旁点击「重试图片」重新尝试。
需精确配置思考强度、输出限制、视觉能力或价格时，请在本目录添加模型配置。

接口说明：[DeepSeek](https://api-docs.deepseek.com/api/list-models/)、
[OpenAI](https://developers.openai.com/api/reference/resources/models/methods/list)、
[Anthropic](https://platform.claude.com/docs/en/api/models/list)、
[Gemini](https://ai.google.dev/api/models)、
[Grok](https://docs.x.ai/developers/rest-api-reference/inference/models)。

## 字段说明

provider 的 `protocol` 为 `openai`（Chat Completions）或 `anthropic`（Claude Messages API，
`completionsPath` 为 `/messages`）。`anthropic` 协议使用 `x-api-key` 与 `anthropic-version`
请求头，模型 effort 写入 `output_config.effort`，不发送 temperature 与 `response_format`。

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | 扩展内部唯一 ID，设置页下拉框使用它保存选择 |
| `name` | 是 | 下拉栏显示名称 |
| `model` | 是 | 发送给 API 的 `model` 字段，如 `deepseek-flash`、`gpt-6.1-terra` |
| `endpoint` | 是 | OpenAI 兼容 Chat Completions 的 base URL；DeepSeek 为 `https://api.deepseek.com`，OpenAI 为 `https://api.openai.com/v1` |
| `contextWindow` | 是 | 上下文 token 数，用于设置页展示和未来长文本分片 |
| `maxOutputTokens` | 否 | 单次最大输出 token 数 |
| `outputFloor` | 否 | 请求的输出上限下限；思考计入输出上限的模型（Claude、Gemini）用它预留思考空间 |
| `effortLevels` | 是 | 思考强度可选项；没有思考能力的模型填 `["none"]` |
| `defaultEffort` | 是 | 默认 effort，必须存在于 `effortLevels` |
| `thinkingParam` | 否 | `deepseek` 表示发送 DeepSeek 的 `thinking` 字段；其他/留空不发送 |
| `effortParam` | 否 | 例如 `reasoning_effort`；留空则不发送 effort 参数 |
| `supportsVision` | 否 | 是否可用于图片翻译 |
| `supportsJson` | 否 | 是否发送 `response_format: json_object` |
| `maxTokensParam` | 否 | `max_tokens` 或 `max_completion_tokens` |
| `apiKeyPrefix`（provider） | 否 | 设置页校验 Key 的固定前缀；留空则不校验前缀 |
| `imageDetail`（provider） | 否 | `false` 时图片请求不发送 OpenAI 专用的 `detail` 字段 |
| `refusalFallback` | 否 | 仅 Claude：`true` 时发送 `fallbacks: "default"`（服务端拒答回退 beta） |
| `pricing` | 否 | 价格配置，用于预估计费；见下 |

## 计价方式

`pricing.unit` 目前固定按 **每 1M tokens / USD** 解释。支持两种模式：

- **峰谷价（DeepSeek）**：提供 `peak`、`offPeak`、`peakWindowsUtc`、
  `peakWeekdays`、`holidayDates`。当前默认按 DeepSeek 官方说明：UTC 周一至周五
  01:00–04:00、06:00–10:00 为峰时，其余为谷时；`holidayDates` 可补充中国法定节假日
  日期（`YYYY-MM-DD`，UTC 日期）。
- **固定价（OpenAI/Claude/Grok/Gemini/自定义）**：提供 `flat`。Claude 的 `inputCacheHit` 为缓存读取价；
  扩展不发送 `cache_control`，缓存写入 token 按未命中价估算。

每档价格包含：

```json
{ "inputCacheHit": 0.003, "inputCacheMiss": 0.15, "output": 0.6 }
```

扩展会从 API 的 `usage` 中读取缓存命中 token（DeepSeek `prompt_cache_hit_tokens`、
OpenAI `prompt_tokens_details.cached_tokens`），按缓存命中价、缓存未命中价和输出价
计算当次预估费用，并累计到设置页。实际账单以服务商为准。

## 自定义 OpenAI 兼容接口

1. 在设置 → 常规 → 服务商点「＋ 添加服务商」；
2. 填写名称、base URL（例如 `https://api.example.com/v1`）和真实 model 名称；
3. 保存后在同一面板填写 API Key（服务不需要时可留空）并测试连接；
4. 在设置 → 高级 → 模型行为中把翻译或润色切换到该服务商。

用户添加的服务商保存在 `chrome.storage.local` 的 `customProviders`（`[{id, name, endpoint, model}]`）中，
不写入本目录。`custom.json` 只作为模板：每个添加的服务商复制一份，模型 id 为 `<服务商 id>-model`。

自定义接口必须兼容 OpenAI Chat Completions 的请求/响应结构。模型没有视觉能力时请把模板模型的
`supportsVision` 设为 `false`。
