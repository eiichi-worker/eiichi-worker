# resume.jsonc の内容で A4 の PDF を作る（Microsoft Edge のヘッドレス印刷を使用）
# 使い方: mise run pdf  または  pwsh RESUME_HTML/make-pdf.ps1  [-Out 出力先.pdf]
# 出力先の既定はリポジトリ直下の .local/（Git 管理外）
param([string]$Out)
$ErrorActionPreference = "Stop"
$dir = $PSScriptRoot

# PowerShell 7 の ConvertFrom-Json は JSONC（コメント・末尾のカンマ）も読める。書き間違いはここで止める
try {
    $data = Get-Content "$dir\resume.jsonc" -Raw -Encoding UTF8 | ConvertFrom-Json
}
catch {
    throw "resume.jsonc の書き方に誤りがあります: $($_.Exception.Message)"
}

if (-not $Out) {
    $name = ($data.name -replace '\s', '')
    $outDir = Join-Path (Split-Path $dir -Parent) ".local"
    New-Item -ItemType Directory -Force $outDir | Out-Null
    $Out = Join-Path $outDir "$($data.title)_$($name)_$($data.updatedAt -replace '-', '').pdf"
}
# Edge は作業フォルダが違うため、相対パスのままだと別の場所に書き出してしまう
$Out = [IO.Path]::GetFullPath($Out, (Get-Location).Path)

$edge = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw "Microsoft Edge が見つかりません" }

# Edge をヘッドレスで起動し、終わるまで待つ。
# msedge.exe は & で呼ぶと処理の完了を待たずに戻ることがあるため、Start-Process -Wait を使う
function Invoke-Edge([string[]]$EdgeArgs, [string]$StdOut) {
    # 古い JS/CSS がキャッシュから読まれないよう、毎回新しいプロファイルで起動する
    $profileDir = Join-Path ([IO.Path]::GetTempPath()) "resume-pdf-edge-$([guid]::NewGuid())"
    $errLog = "$profileDir.log"
    $common = @("--headless=new", "--disable-gpu", "--no-first-run", "--user-data-dir=`"$profileDir`"", "--virtual-time-budget=10000")
    $params = @{ FilePath = $edge; ArgumentList = $common + $EdgeArgs; Wait = $true; WindowStyle = "Hidden"; RedirectStandardError = $errLog }
    if ($StdOut) { $params.RedirectStandardOutput = $StdOut }
    try { Start-Process @params }
    finally {
        Remove-Item $profileDir -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item $errLog -ErrorAction SilentlyContinue
    }
}

# fetch で resume.jsonc を読むため、一時的にローカルサーバーを立てる。ポートは OS に空きを割り当ててもらう
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start(); $port = $listener.LocalEndpoint.Port; $listener.Stop()
$serverLog = Join-Path ([IO.Path]::GetTempPath()) "resume-pdf-server-$([guid]::NewGuid()).log"
$server = Start-Process python -ArgumentList "-m", "http.server", $port, "-d", "`"$dir`"", "--bind", "127.0.0.1" `
    -PassThru -WindowStyle Hidden -RedirectStandardError $serverLog
$domFile = Join-Path ([IO.Path]::GetTempPath()) "resume-pdf-dom-$([guid]::NewGuid()).html"
try {
    $url = "http://127.0.0.1:$port/"
    $ready = $false
    for ($i = 0; $i -lt 60 -and -not $ready -and -not $server.HasExited; $i++) {
        try { Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 2 | Out-Null; $ready = $true }
        catch { Start-Sleep -Milliseconds 250 }
    }
    if (-not $ready) {
        $detail = if (Test-Path $serverLog) { Get-Content $serverLog -Raw } else { "" }
        throw "ローカルサーバーを起動できませんでした（python -m http.server, port $port）`n$detail"
    }

    # 印刷する前に、ページが最後まで描画できたかを確かめる（app.js が <html data-state="ready|error"> を付ける）
    Invoke-Edge -EdgeArgs @("--dump-dom", $url) -StdOut $domFile
    $dom = Get-Content $domFile -Raw -Encoding UTF8
    if ($dom -notmatch 'data-state="ready"') {
        $message = if ($dom -match '<p class="error">([\s\S]*?)</p>') { [System.Net.WebUtility]::HtmlDecode($Matches[1]) } else { "描画が終わりませんでした" }
        throw "職務経歴書を描画できなかったため、PDF を作りませんでした。`n$message"
    }

    # 失敗時に前回の PDF が残って成功に見えないよう、先に消しておく
    if (Test-Path $Out) { Remove-Item $Out -Force }
    Invoke-Edge -EdgeArgs @("--no-pdf-header-footer", "--print-to-pdf=`"$Out`"", $url)
    if (-not (Test-Path $Out)) { throw "PDF の生成に失敗しました" }
    "PDF を作成しました: $Out"
}
finally {
    Stop-Process -Id $server.Id -ErrorAction SilentlyContinue
    $server.WaitForExit(3000) | Out-Null
    Remove-Item $domFile, $serverLog -ErrorAction SilentlyContinue
}
