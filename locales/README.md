# 界面文案

中文文案编辑 `zh-cn.json`，英文文案编辑 `en.json`。每个文件按语义键保存对应语言的字符串，两份文件的键必须一致。动态内容使用 `$1` 至 `$9`，两种语言的占位符必须一致。用户输入、模型提示词和翻译目标语言不属于界面文案。

修改后运行 `npm run localize`，生成 Chromium 使用的 `_locales/zh_CN/messages.json` 和 `_locales/en/messages.json`；不要直接编辑生成文件。`npm run localize:check` 检查生成结果，打包时也会自动生成。

界面跟随浏览器语言：英文使用 `en`，其他未提供的语言回退到中文。重新加载扩展后生效。
