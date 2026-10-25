# Private owner-only v14 source-vision triage. Never write raw image/text to CI.
$ErrorActionPreference='Stop'
try {
    $checkout=(Resolve-Path -LiteralPath 'acs-v14-blind').Path
    if ((git -C $checkout rev-parse HEAD).Trim() -ne $env:EXPECTED_SHA) {
        throw 'SHA_MISMATCH'
    }
    $root='D:\ai-cognitive-pdf-benchmark-data'
    $py=Join-Path $root 'tool-env\docling-2.141.0\Scripts\python.exe'
    $script=Join-Path $checkout 'tools\pdf-parser-benchmark\scripts\ebook_b03_b15_blind_visual_triage_v14.py'
    if (-not (Test-Path -LiteralPath $py -PathType Leaf) -or
        -not (Test-Path -LiteralPath $script -PathType Leaf)) {
        throw 'ENTRY_MISSING'
    }
    $env:HF_HUB_OFFLINE='1'
    $env:TRANSFORMERS_OFFLINE='1'
    $pre=@(& $py $script --private-root $root --check-only 2>$null)
    if ($LASTEXITCODE -ne 0) { throw 'PRECHECK_FAILED' }
    if (@($pre | Where-Object { $_ -eq 'ACS_V14_VISUAL=SOURCE_TILES_CHECKED_NO_CLOUD' }).Count -ne 1) {
        throw 'PRECHECK_INVALID'
    }
    Write-Output 'ACS_V14_SOURCE_PRECHECK=PASS'
    $keyPresent = -not [string]::IsNullOrEmpty($env:ACS_GLM_VISION_API_KEY) -or
                  -not [string]::IsNullOrEmpty($env:GLM_API_KEY) -or
                  -not [string]::IsNullOrEmpty($env:ZHIPUAI_API_KEY) -or
                  -not [string]::IsNullOrEmpty($env:ZAI_API_KEY)
    if (-not $keyPresent) {
        Write-Output 'ACS_V14_CLOUD_TRIAGE=NOT_EXECUTED'
        Write-Output 'ACS_V14_GOLD=NOT_APPROVED'
        exit 0
    }
    # Only B03 R1C2/R1C3/R2C2 and B15 R3C2, max 4 calls,
    # private idempotency journal created *before* each call; never retry unknowns.
    $result=@(& $py $script --private-root $root --write --allow-cloud-vision 2>$null)
    if ($LASTEXITCODE -ne 0) { throw 'BOUND_SOURCE_CLOUD_TRIAGE_REJECTED' }
    if (@($result | Where-Object { $_ -eq 'ACS_V14_VISUAL=PRIVATE_VISUAL_CANDIDATES_CREATED_OR_AUDITED' }).Count -ne 1) {
        throw 'TRIAGE_RECEIPT_INVALID'
    }
    $audit=@(& $py $script --private-root $root --audit-only 2>$null)
    if ($LASTEXITCODE -ne 0) { throw 'REPLAY_FAILED' }
    foreach ($line in @('ACS_V14_VISUAL_COMPLETED=4',
                       'ACS_V14_VISUAL_GOLD=NOT_APPROVED',
                       'ACS_V14_VISUAL_NEW_MODEL_CALLS=0')) {
        if (@($audit | Where-Object { $_ -eq $line }).Count -ne 1) {
            throw 'AUDIT_COUNT_INVALID'
        }
    }
    Write-Output 'ACS_V14_CLOUD_TRIAGE=PRIVATE_CANDIDATE_REPLAY_PASS'
    Write-Output 'ACS_V14_SOURCE_REGIONS=4'
    Write-Output 'ACS_V14_GOLD=NOT_APPROVED'
} catch {
    Write-Output 'ACS_V14_CLOUD_TRIAGE=REJECTED'
    exit 2
}
