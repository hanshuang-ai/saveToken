# clear-data.ps1 —— 清理旧数据
# 用途: 清空 Claude Code 旧会话 + frugal 历史数据，为 A/B 测试重新开始
param(
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$claudeDir = "$env:USERPROFILE\.claude"
$frugalDir = "$env:USERPROFILE\Desktop\frugal"

function Backup-File($path, $suffix) {
    if (Test-Path $path) {
        $backup = "$path.$suffix"
        if (-not $DryRun) { Copy-Item $path $backup -Force }
        Write-Host "  备份: $path -> $backup"
    }
}

function Remove-Safe($path, $label) {
    if (Test-Path $path) {
        $items = (Get-ChildItem $path -ErrorAction SilentlyContinue).Count
        Write-Host "  $label ($items 个)"
        if (-not $DryRun) { Remove-Item "$path\*" -Recurse -Force -ErrorAction SilentlyContinue }
    } else {
        Write-Host "  $label (不存在)"
    }
}

Write-Host "=== 清理 Claude Code 旧数据 ===" -ForegroundColor Yellow

Remove-Safe "$claudeDir\sessions" "sessions"
Remove-Safe "$claudeDir\projects\E--WT-saveToken" "projects/E--WT-saveToken"
Remove-Safe "$claudeDir\file-history" "file-history"
Remove-Safe "$claudeDir\daemon" "daemon"
Remove-Safe "$claudeDir\tasks" "tasks"
Remove-Safe "$claudeDir\session-env" "session-env"
Remove-Safe "$claudeDir\shell-snapshots" "shell-snapshots"
Remove-Safe "$claudeDir\paste-cache" "paste-cache"
Remove-Safe "$claudeDir\ide" "ide"

Write-Host "`n=== 清理 frugal 数据 ===" -ForegroundColor Yellow
Backup-File "$frugalDir\frugal.db" "before-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Backup-File "$frugalDir\hook-decisions.jsonl" "before-$(Get-Date -Format 'yyyyMMdd-HHmmss')"

if ((Test-Path "$frugalDir\frugal.db") -and (-not $DryRun)) {
    Remove-Item "$frugalDir\frugal.db" -Force
    Write-Host "  已删除: frugal.db"
}
if ((Test-Path "$frugalDir\hook-decisions.jsonl") -and (-not $DryRun)) {
    Remove-Item "$frugalDir\hook-decisions.jsonl" -Force
    Write-Host "  已删除: hook-decisions.jsonl"
}

if ($DryRun) {
    Write-Host "`n(DRY RUN: 未实际删除)" -ForegroundColor Cyan
} else {
    Write-Host "`n清理完成" -ForegroundColor Green
}