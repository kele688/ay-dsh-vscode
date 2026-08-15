# publish.ps1 — 一键初始化发布：git 初始化 + 首次提交 + （可选）推送到 GitHub
#
# 用法：
#   1) 仅本地初始化并提交：
#      powershell -ExecutionPolicy Bypass -File scripts\publish.ps1
#   2) 初始化并推送到仓库：
#      powershell -ExecutionPolicy Bypass -File scripts\publish.ps1 -Remote https://github.com/<your-account>/ay-dsh-vscode.git
#   3) 推送时自动使用 token（避免交互输入密码）：
#      $env:GITHUB_TOKEN = "github_pat_xxx"; powershell -ExecutionPolicy Bypass -File scripts\publish.ps1 -Remote https://github.com/<your-account>/ay-dsh-vscode.git

param(
    [string]$Remote,          # GitHub 仓库地址（可选；提供则推送）
    [string]$Branch = "main",
    [switch]$SkipCommitCheck  # 跳过对未提交变更的提醒
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Step($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }
function Ok($m) { Write-Host "✓ $m" -ForegroundColor Green }
function Fail($m) { Write-Host "✗ $m" -ForegroundColor Red; exit 1 }

# ---------- 检查 ----------
Step "环境检查"
$git = Get-Command git -ErrorAction SilentlyContinue
if (-not $git) { Fail "未找到 git，请先安装 https://git-scm.com" }
Ok "git $(& git --version)"

# ---------- git 初始化 ----------
Step "初始化仓库（$Branch 分支）"
if (-not (Test-Path .git)) {
    & git init -b $Branch 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "git init 失败" }
    Ok "git init -b $Branch"
} else {
    Ok "仓库已初始化，跳过"
}

# ---------- git 身份（未配置则提示） ----------
$name = & git config user.name
$email = & git config user.email
if (-not $name -or -not $email) {
    Write-Host "⚠ git 未配置提交身份。请先执行：" -ForegroundColor Yellow
    Write-Host '  git config user.name "你的名字"' -ForegroundColor Yellow
    Write-Host '  git config user.email "你的邮箱"' -ForegroundColor Yellow
    exit 1
}

# ---------- 暂存并提交 ----------
Step "首次提交"
& git add -A 2>&1 | Out-Null
$staged = (& git diff --cached --name-only)
Write-Host "暂存文件数: $($staged.Count)"
$bad = $staged | Where-Object { $_ -match 'node_modules|\.github-token|dist/|media/|release/|\.vsix|preview\.html|--dry-run|maintainer\.pid|maintainer/log/|maintainer/|MAINTAINER\.md|RELEASE-CHECKLIST' }
if ($bad) {
    Write-Host "⚠ 检测到不应提交的文件，已中止：" -ForegroundColor Yellow
    $bad | ForEach-Object { Write-Host "  - $_" }
    exit 1
}
if (-not $SkipCommitCheck) {
    # 敏感内容检查：本地绝对路径 + 密钥模式 + 内部运维机制关键词（通用模式，不硬编码任何开发机路径）
    $leak = $staged | Where-Object { $_ -match '\.(ts|mjs|js|json|md)$' } | ForEach-Object {
        $c = Get-Content $_ -Raw -ErrorAction SilentlyContinue
        if ($c -match 'C:\\Users\\[^\\]+|D:\\projects|C:\\Program Files\\Microsoft VS Code|github_pat_|ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|AI maintainer|start-maintainer|stop-maintainer|launch-maintainer|maintainer\.mjs|docs[\\/]MAINTAINER') { $_ }
    }
    if ($leak) {
        Write-Host "✗ 检测到敏感内容（本地绝对路径 / 密钥 / 内部运维关键词），已中止提交：" -ForegroundColor Red
        $leak | ForEach-Object { Write-Host "  - $_" }
        Write-Host "  请清理后再提交（本地敏感信息绝不外传）。" -ForegroundColor Yellow
        exit 1
    }
}
& git commit -m "Initial release: ay-dsh-vscode (DSH-powered VS Code agent)" 2>&1 | Out-String | Write-Host
if ($LASTEXITCODE -ne 0) { Fail "git commit 失败" }
Ok "首次提交完成"

# ---------- 推送 ----------
if ($Remote) {
    Step "推送到 $Remote"
    if (& git remote | Select-String '^origin$') {
        & git remote set-url origin $Remote
    } else {
        & git remote add origin $Remote
    }
    if ($env:GITHUB_TOKEN) {
        # 用 token 推送（凭证内嵌 URL，仅本次推送）
        $authed = $Remote -replace '^https://', "https://x-access-token:$($env:GITHUB_TOKEN)@"
        & git push $authed "$Branch`:$Branch" 2>&1 | Out-String | Write-Host
    } else {
        & git push -u origin $Branch 2>&1 | Out-String | Write-Host
    }
    if ($LASTEXITCODE -ne 0) { Fail "git push 失败（检查 token/网络/仓库是否已创建）" }
    Ok "已推送到 $Remote"
}

Write-Host "`n================================================================" -ForegroundColor Cyan
Write-Host " 🎉 发布准备完成！" -ForegroundColor Green
Write-Host " 1. 若尚未推送：在 GitHub 新建空仓库后重跑本脚本并加 -Remote 参数"
Write-Host " 2. 发布后请检查 GitHub Actions CI 是否通过"
Write-Host "================================================================" -ForegroundColor Cyan
exit 0
