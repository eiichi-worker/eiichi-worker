# resume.jsonc の内容で A4 の PDF を作る（Microsoft Edge のヘッドレス印刷を使用）
# 使い方: mise run pdf  または  pwsh RESUME_HTML/make-pdf.ps1  [-Variant all|full|masked] [-Out 出力先.pdf]
# 既定では通常版と匿名版（氏名・会社名・URL を伏せたもの）の 2 つを作る。
# 出力先の既定はリポジトリ直下の .local/（Git 管理外）で、ファイル名は描画後のページタイトル（例: 職務経歴書_藤本永一_20261005.pdf）
param(
    [ValidateSet("all", "full", "masked")][string]$Variant = "all",
    [string]$Out
)
$ErrorActionPreference = "Stop"
$dir = $PSScriptRoot

# PowerShell 7 の ConvertFrom-Json は JSONC（コメント・末尾のカンマ）も読める。書き間違いはここで止める
try {
    $data = Get-Content "$dir\resume.jsonc" -Raw -Encoding UTF8 | ConvertFrom-Json
}
catch {
    throw "resume.jsonc の書き方に誤りがあります: $($_.Exception.Message)"
}

$variants = if ($Variant -eq "all") { @("full", "masked") } else { @($Variant) }
if ($Out -and $variants.Count -gt 1) { throw "-Out を指定するときは -Variant full か -Variant masked も指定してください" }
# Edge は作業フォルダが違うため、相対パスのままだと別の場所に書き出してしまう
if ($Out) { $Out = [IO.Path]::GetFullPath($Out, (Get-Location).Path) }
$outDir = Join-Path (Split-Path $dir -Parent) ".local"

# 匿名版に残っていてはいけない文字列（置き換え前の氏名・会社名・学校名と、伏せた項目や差し替えた項目の元の値）
$secrets = @($data.masked.replace | ForEach-Object { $_.from })
foreach ($key in $data.masked.set.PSObject.Properties.Name) { if ($data.$key) { $secrets += $data.$key } }
foreach ($key in $data.masked.hide) {
    $value = $data.$key
    if ($value -is [string]) { $secrets += $value }
    elseif ($value) { $secrets += @($value | ForEach-Object { $_.url } | Where-Object { $_ }) }
}

# style.css が読み込む Noto Sans JP の TrueType（標準・太字）。なければ作る（fonts/ は Git 管理外）。
# Edge は可変フォントと CFF 形式（.otf）を PDF に図形（Type3）として入れ、文字のコピーや検索が崩れる。
# そのため Google Fonts の可変フォントから、fontTools で標準と太字を TrueType のまま切り出す。
# 部首（⼀ など）と互換漢字の対応も外す。字形を共有しているため、PDF からコピーすると「一」が「⼀」になる
$fontDir = Join-Path $dir "fonts"
if (-not ((Test-Path "$fontDir\NotoSansJP-Regular.ttf") -and (Test-Path "$fontDir\NotoSansJP-Bold.ttf"))) {
    New-Item -ItemType Directory -Force $fontDir | Out-Null
    $vf = Join-Path $fontDir "NotoSansJP-VF.ttf"
    if (-not (Test-Path $vf)) {
        "フォントをダウンロードしています: Noto Sans JP"
        try { Invoke-WebRequest "https://github.com/google/fonts/raw/main/ofl/notosansjp/NotoSansJP%5Bwght%5D.ttf" -OutFile $vf -UseBasicParsing }
        catch {
            Remove-Item $vf -ErrorAction SilentlyContinue
            throw "Noto Sans JP をダウンロードできませんでした: $($_.Exception.Message)"
        }
    }
    "フォントを作っています: NotoSansJP-Regular.ttf / NotoSansJP-Bold.ttf"
    $fontScript = @'
import sys
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
src, out = sys.argv[1], sys.argv[2]
for name, weight in (("Regular", 400), ("Bold", 700)):
    font = TTFont(src)
    instancer.instantiateVariableFont(font, {"wght": weight}, inplace=True, updateFontNames=True)
    for table in font["cmap"].tables:
        for cp in [c for c in table.cmap if 0x2E80 <= c <= 0x2FDF or 0xF900 <= c <= 0xFAFF]:
            del table.cmap[cp]
    font.save(f"{out}/NotoSansJP-{name}.ttf")
'@
    $fontScript | uv run --quiet --with fonttools python - $vf $fontDir
    if ($LASTEXITCODE -ne 0) { throw "フォントを作れませんでした（uv run --with fonttools）" }
}

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

    foreach ($v in $variants) {
        $pageUrl = if ($v -eq "masked") { "$($url)?masked" } else { $url }

        # 印刷する前に、ページが最後まで描画できたかを確かめる（app.js が <html data-state="ready|error"> を付ける）
        Invoke-Edge -EdgeArgs @("--dump-dom", $pageUrl) -StdOut $domFile
        $dom = Get-Content $domFile -Raw -Encoding UTF8
        if ($dom -notmatch 'data-state="ready"') {
            $message = if ($dom -match '<p class="error">([\s\S]*?)</p>') { [System.Net.WebUtility]::HtmlDecode($Matches[1]) } else { "描画が終わりませんでした" }
            throw "職務経歴書を描画できなかったため、PDF を作りませんでした。`n$message"
        }
        if ($v -eq "masked") {
            $text = [System.Net.WebUtility]::HtmlDecode($dom)
            $leaks = $secrets | Where-Object { $text.Contains($_) }
            if ($leaks) { throw "匿名版に伏せるはずの文字列が残っているため、PDF を作りませんでした: $($leaks -join ', ')" }
        }

        # ファイル名は app.js が付けたページタイトルから決める（PDF のタイトル情報と一致させる）
        $target = $Out
        if (-not $target) {
            if ($dom -notmatch '<title>([^<]+)</title>') { throw "ページタイトルを取得できませんでした" }
            New-Item -ItemType Directory -Force $outDir | Out-Null
            $target = Join-Path $outDir "$([System.Net.WebUtility]::HtmlDecode($Matches[1])).pdf"
        }

        # 失敗時に前回の PDF が残って成功に見えないよう、先に消しておく
        if (Test-Path $target) { Remove-Item $target -Force }
        Invoke-Edge -EdgeArgs @("--no-pdf-header-footer", "--print-to-pdf=`"$target`"", $pageUrl)
        if (-not (Test-Path $target)) { throw "PDF の生成に失敗しました" }
        # 別のフォントに置き換わったり、図形（Type3）になったりしていないかを確かめる
        $raw = [IO.File]::ReadAllText($target, [Text.Encoding]::Latin1)
        if (-not $raw.Contains("+NotoSansJP-Regular") -or $raw.Contains("/Type3")) {
            throw "PDF に Noto Sans JP が文字として埋め込まれていません: $target"
        }
        "PDF を作成しました: $target"
    }
}
finally {
    Stop-Process -Id $server.Id -ErrorAction SilentlyContinue
    $server.WaitForExit(3000) | Out-Null
    Remove-Item $domFile, $serverLog -ErrorAction SilentlyContinue
}
