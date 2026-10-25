# Run only on owner-authored PR, after synthetic gate, with owner-only private D: data.
$ErrorActionPreference='Stop'
try {
    $checkout=(Resolve-Path -LiteralPath 'acs-v15-fresh').Path
    if ((git -C $checkout rev-parse HEAD).Trim() -ne $env:EXPECTED_SHA) { throw 'SHA_MISMATCH' }
    $root='D:\ai-cognitive-pdf-benchmark-data'
    $py=Join-Path $root 'tool-env\docling-2.141.0\Scripts\python.exe'
    $script=Join-Path $checkout 'tools\pdf-parser-benchmark\scripts\ebook_b15_fresh_only_resume_v15.py'
    $v14=Join-Path $checkout 'tools\pdf-parser-benchmark\scripts\ebook_b03_b15_blind_visual_triage_v14.py'
    foreach ($p in @($py,$script,$v14)) {
        if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { throw 'SCRIPT_MISSING' }
    }
    $env:HF_HUB_OFFLINE='1'
    $env:TRANSFORMERS_OFFLINE='1'
    $before=@(& $py $script --private-root $root --check-only 2>$null)
    if ($LASTEXITCODE -ne 0) { throw 'PRECHECK_EXACT_STATE_REJECTED' }
    foreach ($line in @('ACS_V15_B15_FRESH_ONLY=SAFE_TO_START',
                        'ACS_V15_COMPLETED=2','ACS_V15_UNKNOWN=1',
                        'ACS_V15_NOT_STARTED=1','ACS_V15_NEW_MODEL_CALLS=0')) {
        if (@($before | Where-Object { $_ -eq $line }).Count -ne 1) {
            throw 'PRECHECK_RECEIPT_INVALID'
        }
    }
    Write-Output 'ACS_V15_EXACT_PRIOR_STATE=2_1_1_VERIFIED'
    # Operator has opted to continue v14, but only B15 NEVER STARTED is eligible.
    # The previous uncertain B03 charge fence is NEVER retried or overwritten.
    $keyPresent= -not [string]::IsNullOrEmpty($env:ACS_GLM_VISION_API_KEY) -or
                 -not [string]::IsNullOrEmpty($env:GLM_API_KEY)
    if (-not $keyPresent) { throw 'GLM_PROVIDER_NOT_CONFIGURED' }
    $run=@(& $py $script --private-root $root --resume-fresh-only --allow-cloud-vision 2>$null)
    if ($LASTEXITCODE -ne 0) { throw 'SINGLE_NEW_B15_PROVIDER_REJECTED' }
    foreach ($line in @('ACS_V15_CLOUD=ONE_FRESH_B15_CANDIDATE_CREATED',
                        'ACS_V15_COMPLETED=3','ACS_V15_UNKNOWN=1',
                        'ACS_V15_NOT_STARTED=0','ACS_V15_NEW_MODEL_CALLS=1',
                        'ACS_V15_GOLD=NOT_APPROVED')) {
        if (@($run | Where-Object { $_ -eq $line }).Count -ne 1) {
            throw 'B15_RESULT_RECEIPT_INVALID'
        }
    }
    Write-Output 'ACS_V15_B15_ONLY=PRIVATE_CANDIDATE_COMPLETED'
    Write-Output 'ACS_V15_B03_UNKNOWN=NOT_RETRIED'
    Write-Output 'ACS_V15_NEW_MODEL_CALLS=1'
    Write-Output 'ACS_V15_GOLD=NOT_APPROVED'
} catch {
    Write-Output 'ACS_V15_B15_ONLY=REJECTED'
    Write-Output 'ACS_V15_B03_UNKNOWN=NOT_RETRIED'
    exit 2
}
