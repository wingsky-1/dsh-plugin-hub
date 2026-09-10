# 浏览器内核：探测、自查与安装

> 读它的时机：`--browser` 报「找不到 Chromium 系内核」，或要确认本机命中了哪个内核。
> 内核正常时不需要本文件。

`--browser` 需要 Chromium 系内核（Chrome / Edge / Chromium）。探测链
（`browser-driver.mjs` 的 `detectChrome()`，唯一收敛点）：

`DSH_VERIFY_CHROME` 环境变量 → ms-playwright 缓存 → `PATH` → 平台常见路径。
全部缺失时 fail-fast，并打印可执行的安装指引。

| 平台 | ms-playwright 缓存目录 | 常见安装路径（`PATH` 之外兜底） |
|------|------------------------|------------------------------|
| Linux | `~/.cache/ms-playwright` | `/usr/bin/google-chrome`、`/usr/bin/chromium`、`/snap/bin/chromium` |
| macOS | `~/Library/Caches/ms-playwright` | `/Applications/Google Chrome.app/.../Google Chrome`、`/Applications/Chromium.app/.../Chromium` |
| Windows | `%LOCALAPPDATA%\ms-playwright` | `%ProgramFiles%\Google\Chrome\Application\chrome.exe`、`%ProgramFiles(x86)%\...`、`%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe` |

自查命令：

```bash
# Linux / macOS：确认内核可执行文件存在
ls ~/.cache/ms-playwright 2>/dev/null      # ms-playwright 缓存命中？
command -v google-chrome chromium          # PATH 命中？
# macOS 额外：
ls "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" 2>/dev/null
# Windows（PowerShell）：
Test-Path "$env:LOCALAPPDATA\ms-playwright"          # ms-playwright 缓存
Test-Path "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
```

装内核（任选其一）：

```bash
#   Linux:   sudo apt-get install -y chromium-browser   或   npx playwright install chromium
#   macOS:   brew install --cask google-chrome          或   npx playwright install chromium
#   Windows: winget install Google.Chrome               或   npx playwright install chromium
```

已装但探测不到时显式指定路径：

```bash
DSH_VERIFY_CHROME=/path/to/chrome node "$SKILL_BASE/scripts/verify-isolated.mjs" --browser <插件包路径>
```
