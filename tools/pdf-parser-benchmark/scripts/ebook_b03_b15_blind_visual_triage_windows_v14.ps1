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
    # Forensic mode: inspect existing private attempt fences. No cloud requests.
    # A previous run entered the paid-call path; NEVER replay unknown results.
    $inventory=@(& $py $script --private-root $root --inventory-only 2>$null)
    if ($LASTEXITCODE -ne 0) { throw 'READONLY_INVENTORY_REJECTED' }
    foreach ($prefix in @('ACS_V14_INVENTORY_COMPLETED=',
                           'ACS_V14_INVENTORY_UNKNOWN=',
                           'ACS_V14_INVENTORY_NOT_STARTED=')) {
        $values=@($inventory | Where-Object { $_.StartsWith($prefix) })
        if ($values.Count -ne 1 -or $values[0] -notmatch '^ACS_V14_INVENTORY_(COMPLETED|UNKNOWN|NOT_STARTED)=[0-4]$') {
            throw 'INVENTORY_STATUS_INVALID'
        }
        Write-Output $values[0]
    }
    if (@($inventory | Where-Object { $_ -eq 'ACS_V14_INVENTORY=PRIVATE_READONLY' }).Count -ne 1) {
        throw 'INVENTORY_RECEIPT_INVALID'
    }
    Write-Output 'ACS_V14_CLOUD_TRIAGE=DIAGNOSTIC_ONLY_NO_NEW_CALLS'
    Write-Output 'ACS_V14_GOLD=NOT_APPROVED'
} catch {
    Write-Output 'ACS_V14_CLOUD_TRIAGE=REJECTED'
    exit 2
}
