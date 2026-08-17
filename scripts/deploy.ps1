# deploy.ps1 — DSH VS Code 扩展一键部署
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts/deploy.ps1          # 全流程：install → build → package → install
#   powershell -ExecutionPolicy Bypass -File scripts/deploy.ps1 -NoInstall   # 跳过 npm install
#   powershell -ExecutionPolicy Bypass -File scripts/deploy.ps1 -NoPackage   # 构建后直接安装当前 dist
#   powershell -ExecutionPolicy Bypass -File scripts/deploy.ps1 -NoBuild     # 跳过构建（仅打包+安装）
#
# 也可直接：npm run deploy

param(
    [switch]$NoInstall,   # 跳过 npm install
    [switch]$NoBuild,     # 跳过构建
    [switch]$NoPackage,   # 跳过 vsce 打包（改走本地开发目录安装）
    [switch]$Force,       # code --install-extension --force
    [switch]$Open        # 安装后打开 VS Code
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Step($title) {
    Write-Host "`n=== $title ===" -ForegroundColor Cyan
}

function Fail($msg) {
    Write-Host "✗ $msg" -ForegroundColor Red
    exit 1
}

function Ok($msg) {
    Write-Host "✓ $msg" -ForegroundColor Green
}

# ---------- 环境检查 ----------
Step "环境检查"
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail "未找到 node，请先安装 Node.js >= 20 (https://nodejs.org)" }
$nodeMajor = [int]((& node --version) -replace 'v(\d+)\..*', '$1')
if ($nodeMajor -lt 20) { Fail "Node 版本过低：$(& node --version)，需要 >= 20" }
Ok "node $(& node --version)"

$code = Get-Command code -ErrorAction SilentlyContinue
if (-not $code) { Fail "未找到 VS Code CLI（code），请先安装 VS Code 并加入 PATH" }
Ok "VS Code: $($code.Source)"

# ---------- 安装依赖 ----------
if (-not $NoInstall) {
    Step "安装依赖（npm install，含 DeepSeek Harness 内核，可能需要几分钟）"
    npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { Fail "npm install 失败" }
    Ok "依赖安装完成"
} else {
    if (-not (Test-Path node_modules)) { Fail "node_modules 不存在，请去掉 -NoInstall 重跑" }
    Ok "跳过 npm install（node_modules 已存在）"
}

# ---------- 构建 ----------
if (-not $NoBuild) {
    Step "构建扩展（esbuild bundle + media）"
    node scripts/build.mjs
    if ($LASTEXITCODE -ne 0) { Fail "构建失败" }
    Ok "构建完成"
} else {
    Ok "跳过构建"
}

# ---------- 打包并安装 ----------
# 历史扩展 ID 残留清理（避免多扩展并存）：
#   1) 改名前的 dsh-vscode（deepseek-harness.dsh-vscode）
#   2) publisher 变更前的 ay-dsh-vscode（deepseek-harness.ay-dsh-vscode）
$staleExtensions = @('deepseek-harness.dsh-vscode', 'deepseek-harness.ay-dsh-vscode')
$installed = & code --list-extensions 2>$null
foreach ($stale in $staleExtensions) {
    if ($installed -contains $stale) {
        Step "卸载旧版扩展（$stale）"
        & code --uninstall-extension $stale 2>&1 | Out-Null
        Ok "已卸载 $stale"
    }
}

if ($NoPackage) {
    Step "本地开发模式安装（不打包，直接安装扩展目录）"
    $args = @('--install-extension', $Root, '--force')
    & code @args
    if ($LASTEXITCODE -ne 0) { Fail "code --install-extension 失败" }
    Ok "已安装开发模式扩展（位于 $Root）"
} else {
    Step "打包 VSIX"
    node scripts/package.mjs
    if ($LASTEXITCODE -ne 0) { Fail "打包失败" }
    $vsix = Get-ChildItem release\*.vsix | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $vsix) { Fail "未找到 VSIX 产物" }
    Ok "VSIX: $($vsix.FullName) ($([math]::Round($vsix.Length / 1MB, 1)) MB)"

    Step "安装到 VS Code"
    $installArgs = @('--install-extension', $vsix.FullName)
    if ($Force) { $installArgs += '--force' }
    & code @installArgs
    if ($LASTEXITCODE -ne 0) { Fail "安装失败（退出码 $LASTEXITCODE）" }
    Ok "安装成功"
}

# ---------- 收尾 ----------
Write-Host "`n================================================================" -ForegroundColor Cyan
Write-Host "  🎉 部署完成！" -ForegroundColor Green
Write-Host "  1. 在 VS Code 中执行命令面板 (Ctrl+Shift+P) → 'Developer: Reload Window'"
Write-Host "  2. 点击左侧活动栏的 ◈ 图标打开 DSH Agent 面板"
Write-Host "  3. 在设置中配置 dshVscode.apiKey（或设置环境变量 DEEPSEEK_API_KEY）"
Write-Host "  4. 在面板底部输入任务，例如：'帮我写一个冒泡排序并解释'"
Write-Host "================================================================" -ForegroundColor Cyan

if ($Open) { & code }
exit 0
