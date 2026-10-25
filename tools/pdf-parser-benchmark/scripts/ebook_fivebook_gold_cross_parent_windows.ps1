# Owner-only fivebook provenance gate. Source PDF, PNG and OCR bytes remain on D:.
# Errors expose only fixed classes/stages. This script never writes private files.
param(
    [Parameter(Mandatory=$true)][string]$PrivateRoot,
    [Parameter(Mandatory=$true)][string]$Checkout
)
$ErrorActionPreference = 'Stop'
$stage = 'PREFLIGHT'
try {
    $dir = Join-Path $PrivateRoot 'semantic_gate\multibook_matrix_20261023'
    $py = Join-Path $PrivateRoot 'tool-env\docling-2.141.0\Scripts\python.exe'
    $script = Join-Path $Checkout 'tools\pdf-parser-benchmark\scripts\ebook_fivebook_three_engine_gold_grade.py'
    $manifest = Join-Path $Checkout 'tools\pdf-parser-benchmark\corpus\ebook-20261022.manifest.json'
    foreach ($required in @($py, $script, $manifest)) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw 'REQUIRED_FILE_MISSING' }
    }
    $tracked = @(
        'multibook_native_24pages.private.json',
        'fivebook_three_engine_crossbook_consensus.v8.private.json',
        'fivebook_independent_reference_admission.private.json',
        'B03_p0067.private.png', 'B08_p0064.private.png',
        'B15_p0109.private.png', 'B29_p0072.private.png',
        'B31_p0126.private.png'
    )
    $before = @{}
    foreach ($item in $tracked) {
        $path = Join-Path $dir $item
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'SOURCE_MISSING' }
        $before[$path] = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
    }
    $env:HTTP_PROXY = 'http://127.0.0.1:1'
    $env:HTTPS_PROXY = 'http://127.0.0.1:1'
    $env:ALL_PROXY = 'http://127.0.0.1:1'
    $env:ACS_SAFE_GOLD_GATE_DIAGNOSTIC = '1'
    $stage = 'GOLD_READONLY_COMPUTE'
    $result = @(& $py $script --private-root $PrivateRoot --manifest $manifest --snapshot-version 1 --check-only 2>$null)
    if ($LASTEXITCODE -ne 0) {
        # Python only emits fixed, reviewed statuses; never print arbitrary output.
        $safe = @($result | Where-Object {
            $_ -match '^ACS_GOLD_THREE_ENGINE_GATE=(GOLD_GRADE_PARENT_ROW_COVERAGE_INVALID|GOLD_GRADE_PARENT_CORPUS_CHANGED|GOLD_GRADE_CROSS_PARENT_SOURCE_CHANGED|GOLD_GRADE_CROSS_PARENT_IMAGE_CHANGED|OTHER_REJECTED)$'
        })
        if ($safe.Count -eq 1) { Write-Output $safe[0] }
        throw 'SCORE_READONLY_REJECTED'
    }
    if (@($result | Where-Object { $_ -eq 'ACS_GOLD_THREE_ENGINE=READONLY_CHECKED' }).Count -ne 1) {
        throw 'CHECK_RECEIPT_INVALID'
    }
    $approved = @($result | Where-Object { $_ -match '^ACS_GOLD_THREE_ENGINE_GRADED=[0-5]$' })
    $missing = @($result | Where-Object { $_ -match '^ACS_GOLD_THREE_ENGINE_UNGRADED=[0-5]$' })
    if ($approved.Count -ne 1 -or $missing.Count -ne 1) { throw 'COUNT_INVALID' }
    $score = [int]($approved[0].Split('=')[1])
    $ungraded = [int]($missing[0].Split('=')[1])
    if (($score + $ungraded) -ne 5) { throw 'COUNT_SUM_INVALID' }
    $stage = 'SOURCE_UNCHANGED_CHECK'
    foreach ($item in $tracked) {
        $path = Join-Path $dir $item
        if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $before[$path]) {
            throw 'SOURCE_CHANGED'
        }
    }
    Write-Output ('ACS_GOLD_THREE_ENGINE_GRADED=' + $score)
    Write-Output ('ACS_GOLD_THREE_ENGINE_UNGRADED=' + $ungraded)
    Write-Output 'ACS_GOLD_THREE_ENGINE_WINDOWS=READ_ONLY_VERIFIED'
    Write-Output 'ACS_GOLD_THREE_ENGINE_FROZEN_SOURCE=UNCHANGED'
    Write-Output 'ACS_GOLD_THREE_ENGINE_NEW_MODEL_CALLS=0'
}
catch {
    Write-Output ('ACS_GOLD_THREE_ENGINE_STAGE=' + $stage)
    Write-Output 'ACS_GOLD_THREE_ENGINE_WINDOWS=REJECTED'
    exit 2
}
